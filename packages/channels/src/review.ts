import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import { applyCommand, type Source } from "../../coordination/src/service.js";
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

/** An explicit human interpretation keeps the external evidence and bound actor. */
export async function reviewReceipt(
  source: Source,
  raw: string,
  reviewer: string,
) {
  const input = z
    .strictObject({
      receiptId: z.uuid(),
      operation: operationSchema,
      reason: z.string().min(1).max(1000),
    })
    .parse(JSON.parse(raw));
  if (
    !["reply", "decide", "verify", "add_child"].includes(input.operation.type)
  )
    throw new CoordinationError("channel_operation_not_allowed", 403);
  return transaction(source.tenant_id, async (tx) => {
    const found = rows<{
      case_id: string;
      delivery_id: string;
      binding_id: string;
    }>(
      await query(
        "SELECT case_id,delivery_id,binding_id FROM channel_receipts WHERE connection_id=CAST(:source AS uuid) AND id=CAST(:id AS uuid)",
        [param("source", source.id), param("id", input.receiptId)],
        tx,
      ),
    )[0];
    if (!found?.case_id)
      throw new CoordinationError("correlated_receipt_required");
    const c = rows<{ snapshot: CaseState | string }>(
      await query(
        "SELECT snapshot FROM coordination_cases WHERE connection_id=CAST(:source AS uuid) AND id=CAST(:id AS uuid) FOR UPDATE",
        [param("source", source.id), param("id", found.case_id)],
        tx,
      ),
    )[0];
    const r = rows<{
      status: string;
      reason: string;
      evidence_id: string;
      case_id: string;
      delivery_id: string;
      binding_id: string;
    }>(
      await query(
        "SELECT status,reason,evidence_id,case_id,delivery_id,binding_id FROM channel_receipts WHERE id=CAST(:id AS uuid) FOR UPDATE",
        [param("id", input.receiptId)],
        tx,
      ),
    )[0];
    const b = rows<Binding>(
      await query(
        "SELECT * FROM channel_bindings WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid) FOR UPDATE",
        [param("id", found.binding_id), param("source", source.id)],
        tx,
      ),
    )[0];
    const d = rows<Delivery>(
      await query(
        "SELECT * FROM channel_deliveries WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid)",
        [param("id", found.delivery_id), param("source", source.id)],
        tx,
      ),
    )[0];
    if (
      !c ||
      !r ||
      !b?.enabled ||
      !d ||
      d.actor_id !== b.actor_id ||
      r.case_id !== found.case_id ||
      r.delivery_id !== d.id ||
      r.binding_id !== b.id
    )
      throw new CoordinationError("receipt_identity_conflict");
    if (r.status !== "needs_review" || r.reason !== "unstructured_reply")
      throw new CoordinationError("receipt_not_reviewable");
    const state = decode(c.snapshot);
    d.request = decode(d.request);
    if (
      !contactCurrent(state, d) ||
      !["accepted", "uncertain", "sending"].includes(d.status)
    )
      throw new CoordinationError("stale_contact");
    const op = input.operation;
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
    const commandId = randomUUID();
    await applyCommand(
      source,
      d.case_id,
      JSON.stringify({
        commandId,
        actorId: b.actor_id,
        expectedRevision: state.revision,
        operation: op,
      }),
      tx,
      r.evidence_id,
    );
    await query(
      "UPDATE channel_receipts SET status='applied',reason='operator_reviewed_interpretation' WHERE id=CAST(:id AS uuid)",
      [param("id", input.receiptId)],
      tx,
    );
    await query(
      "INSERT INTO channel_receipt_audit(tenant_id,connection_id,id,receipt_id,actor,reason,change) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),CAST(:receipt AS uuid),:actor,:reason,CAST(:change AS jsonb))",
      [
        param("tenant", source.tenant_id),
        param("source", source.id),
        param("id", randomUUID()),
        param("receipt", input.receiptId),
        param("actor", reviewer),
        param("reason", input.reason),
        param(
          "change",
          JSON.stringify({
            commandId,
            operation: op,
            boundActor: b.actor_id,
            evidenceId: r.evidence_id,
          }),
        ),
      ],
      tx,
    );
    return { status: "applied", caseId: d.case_id, commandId };
  });
}
