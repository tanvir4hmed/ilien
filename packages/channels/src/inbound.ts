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
  contactCurrent, bindingMatches,
  decode,
  type Binding,
  type Delivery,
} from "./intents.js";
import type { Incoming } from "./normalize.js";
import { enqueueAgent } from "../../ai/src/store.js";
import { projectProviderEvents } from "./events.js";
import { authoredReplyText } from "./text.js";
import {
  canonical,
  isGreeting,
  openDeliveries,
  type OpenDelivery,
} from "./matching.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export type ReceiptResolution = {
  receiptId: string;
  deliveryId?: string;
  actor: string;
  reason: string;
};
export async function receive(
  tenant: string,
  sourceId: string,
  item: Incoming,
  resolution?: ReceiptResolution,
) {
  return transaction(tenant, async (tx) => {
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text",
      [param("key", `${tenant}/${item.channel}/${item.providerId}`)],
      tx,
    );
    let evidence: string = randomUUID();
    const raw = item.raw;
    const authored = authoredReplyText(item.text);
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
        "INSERT INTO channel_delivery_events(tenant_id,id,channel,provider_message_id,event_key,event_type,evidence_id,occurred_at,normalized) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),:channel,:provider,:key,:type,CAST(:evidence AS uuid),CAST(:time AS timestamptz),CAST(:normalized AS jsonb))",
        [
          param("tenant", tenant),
          param("id", randomUUID()),
          param("channel", item.channel),
          param("provider", item.providerId),
          param("key", key),
          param("type", item.eventType),
          param("evidence", evidence),
          param("time", item.timestamp ?? new Date().toISOString()),
          param(
            "normalized",
            JSON.stringify({
              providerRequestId: item.providerId,
              channelMessageId: item.channelMessageId,
              failure: item.deliveryFailure,
            }),
          ),
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
      return {
        failedDeliveryId: await projectProviderEvents(item.providerId, tx),
      };
    }
    const prior = rows<{
      id: string;
      normalized: Incoming | string;
      evidence_id: string;
      status: string;
    }>(
      await query(
        "SELECT id,normalized,evidence_id,status FROM channel_receipts WHERE connection_id=CAST(:source AS uuid) AND channel=:channel AND provider_message_id=:provider FOR UPDATE",
        [
          param("source", sourceId),
          param("channel", item.channel),
          param("provider", item.providerId),
        ],
        tx,
      ),
    )[0];
    if (prior) {
      if (
        hash(canonical(decode(prior.normalized))) !==
        hash(canonical({ ...item, raw: undefined }))
      )
        throw new Error("ProviderMessageContentConflict");
      if (!resolution)
        return { receiptId: prior.id, status: prior.status, duplicate: true };
      if (resolution.receiptId !== prior.id)
        throw new CoordinationError("receipt_identity_conflict");
      if (!["unmatched", "received"].includes(prior.status))
        throw new CoordinationError("receipt_already_processed");
      evidence = prior.evidence_id;
    }
    if (resolution && !prior)
      throw new CoordinationError("receipt_not_found", 404);
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
    let candidates = rows<Delivery>(
      await query(
        "SELECT * FROM channel_deliveries WHERE connection_id=CAST(:source AS uuid) AND ((:delivery<>'' AND id=CAST(NULLIF(:delivery,'') AS uuid)) OR (:delivery='' AND ((:token<>'' AND token=:token) OR (:reply<>'' AND channel=:channel AND (provider_message_id=:reply OR channel_message_id=:reply))))) LIMIT 2",
        [
          param("source", sourceId),
          param("delivery", resolution?.deliveryId ?? ""),
          param("token", item.token ?? ""),
          param("reply", item.replyTo ?? ""),
          param("channel", item.channel),
        ],
        tx,
      ),
    );
    if (
      !resolution?.deliveryId &&
      !item.token &&
      !item.replyTo &&
      binding &&
      !isGreeting(authored)
    ) {
      const open = rows<OpenDelivery>(
        await query(
          "SELECT d.*,c.snapshot FROM channel_deliveries d JOIN coordination_cases c ON c.tenant_id=d.tenant_id AND c.id=d.case_id WHERE d.connection_id=CAST(:source AS uuid) AND (d.actor_id=:actor OR (d.request->>'demo'='true' AND d.request->>'demoActorId'=:actor)) AND d.status IN ('accepted','uncertain','sending') AND c.status='active' ORDER BY d.attempt_at DESC,d.id LIMIT 101",
          [param("source", sourceId), param("actor", binding.actor_id)],
          tx,
        ),
      );
      // An overfull candidate set is ambiguous; never pick from a truncated list.
      candidates =
        open.length > 100
          ? open
          : openDeliveries(
              binding,
              open,
              item.timestamp ?? new Date().toISOString(),
            );
    }
    const d = candidates.length === 1 ? candidates[0] : undefined;
    if (d) d.request = decode(d.request);
    let status = "unmatched",
      reason = "identity_or_correlation_required";
    const receiptId = prior?.id ?? randomUUID();
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
    if (!prior)
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
      if (authored.toUpperCase() === "STOP") {
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
            "UPDATE channel_deliveries SET status='pending',reason=NULL,queued_at=NULL WHERE binding_id=CAST(:id AS uuid) AND status='blocked' AND reason IN ('whatsapp_session_required','whatsapp_session_or_approved_template_required')",
            [param("id", binding!.id)],
            tx,
          );
        }
        reason =
          candidates.length > 1
            ? "multiple_open_requests_choose_one"
            : item.token || item.replyTo || resolution?.deliveryId
              ? "request_reference_not_found"
              : "no_open_request_for_participant";
        if (isGreeting(authored) || !authored) {
          status = "received";
          reason = authored
            ? "greeting_received"
            : "quoted_message_without_new_reply";
        }
        if(d?.request.contact.kind==="decision_update") {status="received";reason="decision_update_acknowledged";}
        if (
          authored &&
          !isGreeting(authored) &&
          d &&
          d.request.contact.kind!=="decision_update" &&
          bindingMatches(d,binding!) &&
          caseRow
        ) {
          const state = decode(caseRow.snapshot);
          status = "needs_review";
          reason = "unstructured_reply";
          try {
            if (!contactCurrent(state, d))
              throw new CoordinationError("stale_contact");
            if (!["accepted", "uncertain", "sending"].includes(d.status))
              throw new CoordinationError("request_not_sent");
            // Tokens correlate across channels; the independently consented actor binding still authorizes.
            const body = authored
              .replace(/^\s*ILIEN [a-f0-9]{32}\s*/, "")
              .split(/\r?\n(?:>|On .+wrote:)/)[0]!
              .trim();
            const op = operationSchema.parse(JSON.parse(body));
            if (!["reply", "decide", "verify", "add_child"].includes(op.type))
              throw new CoordinationError("channel_operation_not_allowed", 403);
            if (
              (op.type === "reply" || op.type === "decide") &&
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
                actorId: d.actor_id,
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
        } else if (d && !bindingMatches(d,binding!))
          reason = "sender_not_authorized_for_request";
      }
    } else if (item.blockedReason) {
      status = "quarantined";
      reason = item.blockedReason;
    } else reason = "sender_not_registered";
    if (!prior)
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
    else
      await query(
        "UPDATE channel_receipts SET binding_id=CAST(NULLIF(:binding,'') AS uuid),delivery_id=CAST(NULLIF(:delivery,'') AS uuid),case_id=CAST(NULLIF(:case,'') AS uuid),status=:status,reason=:reason WHERE id=CAST(:id AS uuid)",
        [
          param("binding", binding?.id ?? ""),
          param("delivery", d?.id ?? ""),
          param("case", d?.case_id ?? ""),
          param("status", status),
          param("reason", reason),
          param("id", receiptId),
        ],
        tx,
      );
    if (resolution)
      await query(
        "INSERT INTO channel_receipt_audit(tenant_id,connection_id,id,receipt_id,actor,reason,change) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),CAST(:receipt AS uuid),:actor,:reason,CAST(:change AS jsonb))",
        [
          param("tenant", tenant),
          param("source", sourceId),
          param("id", randomUUID()),
          param("receipt", receiptId),
          param("actor", resolution.actor),
          param("reason", resolution.reason),
          param(
            "change",
            JSON.stringify({
              previousStatus: prior?.status,
              status,
              reason,
              deliveryId: d?.id,
              bindingId: binding?.id,
            }),
          ),
        ],
        tx,
      );
    if (
      status === "needs_review" &&
      reason === "unstructured_reply" &&
      d &&
      binding?.actor_id === d.actor_id
    )
      await enqueueAgent(
        { tenant_id: tenant, id: sourceId, origin: "simulated" },
        d.case_id,
        receiptId,
        `receipt:${receiptId}`,
        tx,
        true,
      );
    return { receiptId, status, reason, caseId: d?.case_id ?? null };
  });
}
