import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import { applyCommand } from "../../coordination/src/service.js";
import {
  CoordinationError,
  operationSchema,
  type CaseState,
} from "../../coordination/src/types.js";
import {
  contactCurrent,
  decode,
  type Binding,
  type Delivery,
} from "./intents.js";
import type { Incoming } from "./normalize.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function receive(
  tenant: string,
  sourceId: string,
  item: Incoming,
) {
  return transaction(tenant, async (tx) => {
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text",
      [param("key", `${tenant}/${item.channel}/${item.providerId}`)],
      tx,
    );
    const evidence = randomUUID();
    const raw = JSON.stringify({
      notification: item.raw,
      ...(item.object ? { object: item.object } : {}),
    });
    if (item.eventType) {
      const key = hash(
        `${item.channel}/${item.providerId}/${item.eventType}/${item.timestamp}`,
      );
      if (
        rows(
          await query(
            "SELECT 1 FROM channel_delivery_events WHERE event_key=:key",
            [param("key", key)],
            tx,
          ),
        ).length
      )
        return;
      await query(
        "INSERT INTO evidence_items(tenant_id,id,origin,original_text,sha256) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),'external',:raw,:hash)",
        [
          param("tenant", tenant),
          param("id", evidence),
          param("raw", raw),
          param("hash", hash(raw)),
        ],
        tx,
      );
      await query(
        "INSERT INTO channel_delivery_events(tenant_id,id,channel,provider_message_id,event_key,event_type,evidence_id,occurred_at) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),:channel,:provider,:key,:type,CAST(:evidence AS uuid),CAST(:time AS timestamptz))",
        [
          param("tenant", tenant),
          param("id", randomUUID()),
          param("channel", item.channel),
          param("provider", item.providerId),
          param("key", key),
          param("type", item.eventType),
          param("evidence", evidence),
          param("time", item.timestamp ?? new Date().toISOString()),
        ],
        tx,
      );
      // Receipts are immutable facts, never an approval or proof of business completion.
      if (["bounce", "complaint"].includes(item.eventType))
        await query(
          "UPDATE channel_bindings SET enabled=false WHERE id IN (SELECT binding_id FROM channel_deliveries WHERE channel=:channel AND provider_message_id=:provider)",
          [param("channel", item.channel), param("provider", item.providerId)],
          tx,
        );
      return;
    }
    const prior = rows<{ id: string; normalized: Incoming | string }>(
      await query(
        "SELECT id,normalized FROM channel_receipts WHERE channel=:channel AND provider_message_id=:provider",
        [param("channel", item.channel), param("provider", item.providerId)],
        tx,
      ),
    )[0];
    if (prior) {
      if (
        hash(JSON.stringify(decode(prior.normalized))) !==
        hash(JSON.stringify({ ...item, raw: undefined }))
      )
        throw new Error("ProviderMessageContentConflict");
      return;
    }
    const binding = rows<Binding>(
      await query(
        "SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND channel=:channel AND address=:address AND enabled",
        [
          param("source", sourceId),
          param("channel", item.channel),
          param("address", item.sender),
        ],
        tx,
      ),
    )[0];
    const candidates = rows<Delivery>(
      await query(
        "SELECT * FROM channel_deliveries WHERE connection_id=CAST(:source AS uuid) AND ((:token<>'' AND token=:token) OR (:reply<>'' AND channel=:channel AND provider_message_id=:reply)) LIMIT 2",
        [
          param("source", sourceId),
          param("token", item.token ?? ""),
          param("reply", item.replyTo ?? ""),
          param("channel", item.channel),
        ],
        tx,
      ),
    );
    const d = candidates.length === 1 ? candidates[0] : undefined;
    if (d) d.request = decode(d.request);
    let status = "unmatched",
      reason = "identity_or_correlation_required";
    const receiptId = randomUUID();
    // Lock order is case then binding, matching outbound preparation and coordination.
    const caseRow = d
      ? rows<{ snapshot: CaseState | string }>(
          await query(
            "SELECT snapshot FROM coordination_cases WHERE id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid) FOR UPDATE",
            [param("case", d.case_id), param("source", sourceId)],
            tx,
          ),
        )[0]
      : undefined;
    const lockedBinding = binding
      ? rows<Binding>(
          await query(
            "SELECT * FROM channel_bindings WHERE id=CAST(:id AS uuid) FOR UPDATE",
            [param("id", binding.id)],
            tx,
          ),
        )[0]
      : undefined;
    await query(
      "INSERT INTO evidence_items(tenant_id,id,origin,original_text,sha256) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),'external',:raw,:hash)",
      [
        param("tenant", tenant),
        param("id", evidence),
        param("raw", raw),
        param("hash", hash(raw)),
      ],
      tx,
    );
    if (lockedBinding?.enabled && !item.blockedReason) {
      if (item.text.trim().toUpperCase() === "STOP") {
        await query(
          "UPDATE channel_bindings SET enabled=false WHERE id=CAST(:id AS uuid)",
          [param("id", binding!.id)],
          tx,
        );
        status = "applied";
        reason = "consent_withdrawn";
      } else {
        if (
          item.channel === "whatsapp" &&
          item.timestamp &&
          Date.parse(item.timestamp) <= Date.now() + 60000
        ) {
          await query(
            "UPDATE channel_bindings SET last_inbound_at=GREATEST(last_inbound_at,CAST(:time AS timestamptz)) WHERE id=CAST(:id AS uuid)",
            [param("id", binding!.id), param("time", item.timestamp)],
            tx,
          );
          await query(
            "UPDATE channel_deliveries SET status='pending',reason=NULL,queued_at=NULL WHERE binding_id=CAST(:id AS uuid) AND status='blocked' AND reason='whatsapp_session_required'",
            [param("id", binding!.id)],
            tx,
          );
        }
        if (d && d.actor_id === binding!.actor_id && caseRow) {
          const state = decode(caseRow.snapshot);
          status = "needs_review";
          reason = "unstructured_reply";
          try {
            if (!contactCurrent(state, d))
              throw new CoordinationError("stale_contact");
            if (!["accepted", "uncertain", "sending"].includes(d.status))
              throw new CoordinationError("request_not_sent");
            // Tokens correlate across channels; the independently consented actor binding still authorizes.
            const body = item.text
              .replace(/^\s*ILIEN [a-f0-9]{32}\s*/, "")
              .split(/\r?\n(?:>|On .+wrote:)/)[0]!
              .trim();
            const op = operationSchema.parse(JSON.parse(body));
            if (!["reply", "verify", "add_child"].includes(op.type))
              throw new CoordinationError("channel_operation_not_allowed", 403);
            if (
              op.type === "reply" &&
              (op.obligationId !== d.obligation_id ||
                op.expectedObligationRevision !== d.obligation_revision ||
                op.subjectRevision !== d.request.subject.revision)
            )
              throw new CoordinationError("reply_scope_mismatch");
            if (
              op.type === "verify" &&
              (op.obligationId !== d.obligation_id ||
                d.request.contact.kind !== "verify_request" ||
                op.replyRevision !== d.request.contact.replyRevision)
            )
              throw new CoordinationError("verification_scope_mismatch");
            if (op.type === "add_child" && op.parentId !== d.obligation_id)
              throw new CoordinationError("child_scope_mismatch");
            await applyCommand(
              { tenant_id: tenant, id: sourceId, origin: "simulated" },
              d.case_id,
              JSON.stringify({
                commandId: receiptId,
                actorId: binding!.actor_id,
                expectedRevision: state.revision,
                operation: op,
              }),
              tx,
              evidence,
            );
            status = "applied";
            reason = "authorized_structured_reply";
          } catch (error) {
            if (error instanceof CoordinationError) reason = error.code;
            else if (
              !(error instanceof z.ZodError) &&
              !(error instanceof SyntaxError)
            )
              throw error;
          }
        }
      }
    } else if (item.blockedReason) {
      status = "quarantined";
      reason = item.blockedReason;
    }
    await query(
      "INSERT INTO channel_receipts(tenant_id,connection_id,id,channel,provider_message_id,binding_id,delivery_id,case_id,evidence_id,normalized,status,reason) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),:channel,:provider,CAST(NULLIF(:binding,'') AS uuid),CAST(NULLIF(:delivery,'') AS uuid),CAST(NULLIF(:case,'') AS uuid),CAST(:evidence AS uuid),CAST(:normalized AS jsonb),:status,:reason)",
      [
        param("tenant", tenant),
        param("source", sourceId),
        param("id", receiptId),
        param("channel", item.channel),
        param("provider", item.providerId),
        param("binding", binding?.id ?? ""),
        param("delivery", d?.id ?? ""),
        param("case", d?.case_id ?? ""),
        param("evidence", evidence),
        param("normalized", JSON.stringify({ ...item, raw: undefined })),
        param("status", status),
        param("reason", reason),
      ],
      tx,
    );
  });
}
