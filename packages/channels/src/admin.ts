import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import type { Source } from "../../coordination/src/service.js";
import {
  CoordinationError,
  type CaseState,
  type Contact,
  type Policy,
} from "../../coordination/src/types.js";
import { createDelivery, decode } from "./intents.js";
const bindingSchema = z.strictObject({
  actorId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  channel: z.enum(["email", "whatsapp"]),
  address: z.string().min(3).max(254),
  consentRef: z.string().min(1).max(500),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(100).default(10),
});
export async function saveBinding(source: Source, raw: string) {
  const action=JSON.parse(raw);
  if(action.action==="archive") {
    const input=z.strictObject({action:z.literal("archive"),bindingId:z.uuid(),reason:z.string().min(1).max(500)}).parse(action);
    return transaction(source.tenant_id,async tx=>{
      const b=rows<{id:string}>(await query("UPDATE channel_bindings SET enabled=false WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid) RETURNING id",[param("id",input.bindingId),param("source",source.id)],tx))[0];
      if(!b)throw new CoordinationError("binding_not_found",404);
      await query("INSERT INTO channel_binding_audit VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:binding AS uuid),CAST(:change AS jsonb),now())",[param("tenant",source.tenant_id),param("id",randomUUID()),param("binding",b.id),param("change",JSON.stringify(input))],tx);
      return {bindingId:b.id,enabled:false,archived:true};
    });
  }
  const b = bindingSchema.parse(JSON.parse(raw));
  b.address = b.address.trim().toLowerCase();
  if (b.channel === "whatsapp") b.address = b.address.replace(/^\+/, "");
  if (
    b.channel === "email"
      ? !z.email().safeParse(b.address).success
      : !/^[1-9][0-9]{7,14}$/.test(b.address)
  )
    throw new CoordinationError("invalid_channel_address", 422);
  return transaction(source.tenant_id, async (tx) => {
    const policy = rows<{ policy: Policy | string }>(
      await query(
        "SELECT policy FROM coordination_policies WHERE connection_id=CAST(:source AS uuid)",
        [param("source", source.id)],
        tx,
      ),
    )[0];
    if (
      !policy ||
      !decode(policy.policy).actors.some((a) => a.enabled && a.id === b.actorId)
    )
      throw new CoordinationError("actor_not_authorized", 403);
    const existing = rows<{ id: string; actor_id: string; address: string }>(
      await query(
        "SELECT id,actor_id,address FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND channel=:channel AND address=:address FOR UPDATE",
        [
          param("source", source.id),
          param("channel", b.channel),
          param("address", b.address),
        ],
        tx,
      ),
    );
    if (
      existing.some((e) => e.actor_id !== b.actorId || e.address !== b.address)
    )
      throw new CoordinationError("binding_identity_immutable");
    const id = existing[0]?.id ?? randomUUID();
    await query(
      "INSERT INTO channel_bindings(tenant_id,connection_id,id,actor_id,channel,address,consent_ref,enabled,priority) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),:actor,:channel,:address,:consent,CAST(:enabled AS boolean),CAST(:priority AS integer)) ON CONFLICT(tenant_id,id) DO UPDATE SET consent_ref=EXCLUDED.consent_ref,enabled=EXCLUDED.enabled,priority=EXCLUDED.priority",
      [
        param("tenant", source.tenant_id),
        param("source", source.id),
        param("id", id),
        param("actor", b.actorId),
        param("channel", b.channel),
        param("address", b.address),
        param("consent", b.consentRef),
        param("enabled", String(b.enabled)),
        param("priority", String(b.priority)),
      ],
      tx,
    );
    await query(
      "INSERT INTO channel_binding_audit VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:binding AS uuid),CAST(:change AS jsonb),now())",
      [
        param("tenant", source.tenant_id),
        param("id", randomUUID()),
        param("binding", id),
        param("change", JSON.stringify(b)),
      ],
      tx,
    );
    if (b.enabled && b.channel === "whatsapp") {
      // A newly registered participant may already have opened the service
      // window. Recover it from verified provider evidence, never operator time.
      await query(
        "UPDATE channel_bindings SET last_inbound_at=GREATEST(last_inbound_at,(SELECT max(CAST(normalized->>'timestamp' AS timestamptz)) FROM channel_receipts WHERE connection_id=CAST(:source AS uuid) AND channel='whatsapp' AND normalized->>'sender'=:address AND normalized->>'blockedReason' IS NULL AND normalized->>'timestamp' IS NOT NULL AND CAST(normalized->>'timestamp' AS timestamptz)<=now()+interval '1 minute')) WHERE id=CAST(:id AS uuid)",
        [
          param("source", source.id),
          param("address", b.address),
          param("id", id),
        ],
        tx,
      );
      await query(
        "UPDATE channel_deliveries SET status='pending',reason=NULL,queued_at=NULL WHERE binding_id=CAST(:id AS uuid) AND status='blocked' AND reason IN ('whatsapp_session_required','whatsapp_session_or_approved_template_required') AND EXISTS(SELECT 1 FROM channel_bindings WHERE id=CAST(:id AS uuid) AND last_inbound_at>now()-interval '23 hours 54 minutes')",
        [param("id", id)],
        tx,
      );
    }
    return { bindingId: id, enabled: b.enabled };
  });
}
export async function dispatchContact(source: Source, raw: string) {
  const b = z
    .strictObject({
      caseId: z.uuid(),
      contactId: z.uuid(),
      bindingId: z.uuid(),
    })
    .parse(JSON.parse(raw));
  return transaction(source.tenant_id, async (tx) => {
    const c = rows<{ snapshot: CaseState | string }>(
      await query(
        "SELECT snapshot FROM coordination_cases WHERE id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid) FOR UPDATE",
        [param("case", b.caseId), param("source", source.id)],
        tx,
      ),
    )[0];
    if (!c) throw new CoordinationError("case_not_found", 404);
    const contact = rows<{
      contact: (Contact & { obligationRevision?: number }) | string;
      case_revision: number;
    }>(
      await query(
        "SELECT contact,case_revision FROM coordination_contacts WHERE case_id=CAST(:case AS uuid) AND id=CAST(:id AS uuid)",
        [param("case", b.caseId), param("id", b.contactId)],
        tx,
      ),
    )[0];
    if (!contact) throw new CoordinationError("contact_not_found", 404);
    // Preserve the original obligation revision even when another branch advanced the case.
    const state = decode(c.snapshot);
    const original = decode(contact.contact);
    const obligation = state.obligations.find(
      (o) => o.id === original.obligationId,
    );
    if (
      !obligation ||
      (original.obligationRevision === undefined
        ? contact.case_revision !== state.revision
        : original.obligationRevision !== obligation.revision)
    )
      throw new CoordinationError("stale_contact");
    return {
      deliveryId: await createDelivery(
        source.tenant_id,
        state,
        b.contactId,
        decode(contact.contact),
        tx,
        b.bindingId,
      ),
    };
  });
}
export async function channelView(source: Source, section: string) {
  return transaction(source.tenant_id, async (tx) => {
    if (section === "bindings")
      return rows(
        await query(
          "SELECT id,actor_id,channel,address,enabled,priority,last_inbound_at FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) ORDER BY actor_id,priority",
          [param("source", source.id)],
          tx,
        ),
      );
    if (section === "deliveries")
      return rows(
        await query(
          "SELECT id,case_id,contact_id,actor_id,channel,status,reason,provider_error,provider_message_id,created_at FROM channel_deliveries WHERE connection_id=CAST(:source AS uuid) ORDER BY created_at DESC LIMIT 100",
          [param("source", source.id)],
          tx,
        ),
      );
    if (section === "receipts")
      return rows(
        await query(
          "SELECT id,case_id,channel,provider_message_id,evidence_id,status,reason,normalized,created_at FROM channel_receipts WHERE connection_id=CAST(:source AS uuid) ORDER BY created_at DESC LIMIT 50",
          [param("source", source.id)],
          tx,
        ),
      );
    if (section === "delivery-events")
      return rows(
        await query(
          "SELECT e.id,e.channel,coalesce(e.normalized->>'providerRequestId',e.provider_message_id) AS provider_message_id,e.event_type,e.evidence_id,e.occurred_at FROM channel_delivery_events e WHERE EXISTS(SELECT 1 FROM channel_deliveries d WHERE d.channel=e.channel AND (d.provider_message_id=e.provider_message_id OR d.provider_message_id=e.normalized->>'providerRequestId') AND d.connection_id=CAST(:source AS uuid)) ORDER BY e.created_at DESC LIMIT 100",
          [param("source", source.id)],
          tx,
        ),
      );
    throw new CoordinationError("not_found", 404);
  });
}
