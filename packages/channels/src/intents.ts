import { randomBytes, randomUUID } from "node:crypto";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import {
  CoordinationError,
  type CaseState,
  type Contact,
  type Policy,
} from "../../coordination/src/types.js";

export interface Binding {
  id: string;
  actor_id: string;
  channel: "whatsapp" | "email";
  address: string;
  enabled: boolean;
  last_inbound_at?: string;
}
export interface Delivery {
  id: string;
  connection_id: string;
  case_id: string;
  contact_id: string;
  binding_id: string;
  actor_id: string;
  channel: "whatsapp" | "email";
  address: string;
  token: string;
  obligation_id: string;
  obligation_revision: number;
  status: string;
  provider_message_id?: string;
  request: {
    contact: Contact;
    subject: CaseState["subject"];
    obligationRevision: number;
    deadline: string;
    claim?: unknown;
    proposal?: unknown;
  };
}
export const decode = <T>(v: T | string): T =>
  typeof v === "string" ? JSON.parse(v) : v;

/** Contact content comes only from the deterministic coordinator, never an API send body. */
export async function createDelivery(
  tenant: string,
  state: CaseState,
  contactId: string,
  contact: Contact,
  tx: string,
  bindingId?: string,
) {
  const bindings = rows<Binding>(
    await query(
      `SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND actor_id=:actor AND enabled ${bindingId ? "AND id=CAST(:binding AS uuid)" : ""} ORDER BY priority,id LIMIT 1`,
      [
        param("source", state.sourceId),
        param("actor", contact.actorId),
        ...(bindingId ? [param("binding", bindingId)] : []),
      ],
      tx,
    ),
  );
  const binding = bindings[0];
  if (!binding) {
    if (bindingId)
      throw new CoordinationError("consented_binding_required", 403);
    return null;
  }
  const obligation = state.obligations.find(
    (o) => o.id === contact.obligationId,
  );
  if (!obligation) throw new CoordinationError("obligation_not_found", 404);
  const id = randomUUID();
  const result = rows<{ id: string }>(
    await query(
      `INSERT INTO channel_deliveries(tenant_id,id,connection_id,case_id,contact_id,binding_id,actor_id,channel,address,token,obligation_id,obligation_revision,request)
     VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:source AS uuid),CAST(:case AS uuid),CAST(:contact AS uuid),CAST(:binding AS uuid),:actor,:channel,:address,:token,:obligation,CAST(:revision AS integer),CAST(:request AS jsonb))
     ON CONFLICT(tenant_id,contact_id,channel) DO NOTHING RETURNING id`,
      [
        param("tenant", tenant),
        param("id", id),
        param("source", state.sourceId),
        param("case", state.id),
        param("contact", contactId),
        param("binding", binding.id),
        param("actor", contact.actorId),
        param("channel", binding.channel),
        param("address", binding.address),
        param("token", randomBytes(16).toString("hex")),
        param("obligation", obligation.id),
        param("revision", String(obligation.revision)),
        param(
          "request",
          JSON.stringify({
            contact,
            subject: state.subject,
            obligationRevision: obligation.revision,
            deadline: state.deadline,
            ...(obligation.proposal ? { proposal: obligation.proposal } : {}),
            ...(contact.kind === "verify_request"
              ? { claim: obligation.reply }
              : {}),
          }),
        ),
      ],
      tx,
    ),
  );
  if (result.length)
    await query(
      "UPDATE coordination_contacts SET delivery_status='channel_intent' WHERE id=CAST(:id AS uuid)",
      [param("id", contactId)],
      tx,
    );
  return result[0]?.id ?? null;
}

export function contactCurrent(state: CaseState, d: Delivery) {
  const o = state.obligations.find((o) => o.id === d.obligation_id);
  return (
    !!o &&
    state.status === "active" &&
    !state.takeoverBy &&
    Date.parse(state.deadline) > Date.now() &&
    o.revision === d.obligation_revision &&
    (d.request.contact.kind === "verify_request"
      ? o.status === "answered" &&
        o.reply?.revision === d.request.contact.replyRevision
      : o.assignee === d.actor_id && o.status === "waiting")
  );
}

/** A definitive failure may use one other consented channel. Unknown sends never fall back. */
export async function fallbackDelivery(tenant: string, id: string) {
  return transaction(tenant, async (tx) => {
    const d = rows<Delivery & { reason: string }>(
      await query(
        "SELECT * FROM channel_deliveries WHERE id=CAST(:id AS uuid)",
        [param("id", id)],
        tx,
      ),
    )[0];
    if (
      !d ||
      d.status !== "blocked" ||
      ![
        "provider_rejected",
        "provider_delivery_failed",
        "whatsapp_session_or_approved_template_required",
        "template_verification_unavailable",
      ].includes(d.reason)
    )
      return null;
    const settings = rows<{
      configuration: { automaticFallback: boolean } | string;
    }>(
      await query(
        "SELECT configuration FROM product_settings WHERE connection_id=CAST(:source AS uuid)",
        [param("source", d.connection_id)],
        tx,
      ),
    )[0];
    if (!settings || !decode(settings.configuration).automaticFallback)
      return null;
    const c = rows<{ snapshot: CaseState | string }>(
      await query(
        "SELECT snapshot FROM coordination_cases WHERE id=CAST(:case AS uuid) FOR UPDATE",
        [param("case", d.case_id)],
        tx,
      ),
    )[0];
    const p = rows<{ policy: Policy | string }>(
      await query(
        "SELECT policy FROM coordination_policies WHERE connection_id=CAST(:source AS uuid)",
        [param("source", d.connection_id)],
        tx,
      ),
    )[0];
    d.request = decode(d.request);
    if (
      !c ||
      !p ||
      decode(c.snapshot).configurationVersion !== decode(p.policy).version ||
      !contactCurrent(decode(c.snapshot), d) ||
      !decode(p.policy).actors.some((a) => a.id === d.actor_id && a.enabled)
    )
      return null;
    const prior = rows(
      await query(
        "SELECT id FROM channel_deliveries WHERE contact_id=CAST(:contact AS uuid) AND id<>CAST(:id AS uuid)",
        [param("contact", d.contact_id), param("id", id)],
        tx,
      ),
    );
    if (prior.length) return null;
    const next = rows<Binding>(
      await query(
        "SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND actor_id=:actor AND enabled AND channel<>:channel ORDER BY priority,id LIMIT 1",
        [
          param("source", d.connection_id),
          param("actor", d.actor_id),
          param("channel", d.channel),
        ],
        tx,
      ),
    )[0];
    if (!next) return null;
    return createDelivery(
      tenant,
      decode(c.snapshot),
      d.contact_id,
      d.request.contact,
      tx,
      next.id,
    );
  });
}
