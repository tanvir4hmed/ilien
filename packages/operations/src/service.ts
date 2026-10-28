import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  query,
  param,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import {getCase,policyFor,applyCommand,type Source} from "../../coordination/src/service.js";
import { CoordinationError } from "../../coordination/src/types.js";
import { controlsFor } from "./controls.js";
const base = { requestId: z.uuid(), reason: z.string().min(10).max(1000) };
export const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({...base,action:z.literal('delete_case'),targetId:z.uuid()}),
  z.strictObject({...base,action:z.literal('restore_case'),targetId:z.uuid()}),
  z.strictObject({ ...base, action: z.literal("reconcile") }),
  z.strictObject({
    ...base,
    action: z.literal("controls"),
    expectedRevision: z.number().int().positive(),
    intakePaused: z.boolean(),
    agentPaused: z.boolean(),
    outboundPaused: z.boolean(),
    resultsPaused: z.boolean(),
    retentionDays: z.number().int().min(7).max(3650),
    legalHold: z.boolean(),
  }),
  z.strictObject({
    ...base,
    action: z.literal("requeue_work"),
    lane: z.enum(["intake", "coordination", "result", "agent", "outbound"]),
    targetId: z.uuid(),
  }),
  z.strictObject({
    ...base,
    action: z.literal("resolve_delivery"),
    targetId: z.uuid(),
    outcome: z.enum(["accepted", "not_sent"]),
    providerId: z
      .string()
      .regex(/^[A-Za-z0-9_.:/+=-]{1,200}$/)
      .optional(),
    evidenceRef: z.string().min(5).max(500),
  }),
  z.strictObject({
    ...base,
    action: z.literal("retry_delivery"),
    targetId: z.uuid(),
    evidenceRef: z.string().min(5).max(500),
  }),
  z.strictObject({
    ...base,
    action: z.literal("redact_ai_traces"),
    targetId: z.uuid(),
  }),
]);
const fail = (code: string): never => {
  throw new CoordinationError(code);
};
export async function operationsView(source: Source) {
  return transaction(source.tenant_id, async (tx) => {
    const p = [param("source", source.id)];
    const work = rows(
      await query(
        `SELECT 'intake' AS lane,j.id,j.state,j.attempts,j.created_at FROM outbox_jobs j JOIN inbox_events i ON i.tenant_id=j.tenant_id AND i.id=j.inbox_id WHERE i.connection_id=CAST(:source AS uuid) AND j.state<>'processed'
 UNION ALL SELECT 'coordination',j.id,j.state,j.attempts,j.created_at FROM coordination_jobs j JOIN coordination_cases c ON c.tenant_id=j.tenant_id AND c.id=j.case_id WHERE c.connection_id=CAST(:source AS uuid) AND j.state<>'processed'
 UNION ALL SELECT 'result',result_id,state,attempts,created_at FROM result_dispatches WHERE connection_id=CAST(:source AS uuid) AND state IN ('pending','publishing','review')
 UNION ALL SELECT 'agent',id,state,queue_attempts,created_at FROM ai_runs WHERE connection_id=CAST(:source AS uuid) AND state IN ('pending','running','uncertain','needs_review') ORDER BY created_at LIMIT 100`,
        p,
        tx,
      ),
    );
    return {
      controls: await controlsFor(source, tx),
      work,
      deliveries: rows(
        await query(
          "SELECT id,case_id,channel,status,reason,queue_attempts,attempt_at,created_at FROM channel_deliveries WHERE connection_id=CAST(:source AS uuid) AND status IN ('pending','sending','uncertain','blocked') ORDER BY created_at LIMIT 100",
          p,
          tx,
        ),
      ),
      audit: rows(
        await query(
          "SELECT id,request_id,actor,action,target_id,reason,detail,created_at FROM operations_audit WHERE connection_id=CAST(:source AS uuid) ORDER BY created_at DESC LIMIT 50",
          p,
          tx,
        ),
      ),
      caseChecks: rows(
        await query(
          "SELECT case_id,checked_revision,status,issues,checked_at FROM case_health_checks WHERE connection_id=CAST(:source AS uuid) ORDER BY checked_at DESC LIMIT 50",
          p,
          tx,
        ),
      ),
      retention: rows(
        await query(
          "SELECT c.id,c.status,c.updated_at,count(r.id)::int AS eligible_traces FROM coordination_cases c JOIN operations_controls o ON o.tenant_id=c.tenant_id AND o.connection_id=c.connection_id JOIN ai_runs r ON r.tenant_id=c.tenant_id AND r.case_id=c.id WHERE c.connection_id=CAST(:source AS uuid) AND c.status IN ('completed','cancelled','handed_off') AND c.updated_at<now()-make_interval(days=>o.retention_days) AND r.trace_redacted_at IS NULL AND r.state IN ('approved','rejected','failed','stale') GROUP BY c.id,c.status,c.updated_at ORDER BY c.updated_at LIMIT 50",
          p,
          tx,
        ),
      ),
    };
  });
}
export async function operationsWrite(
  source: Source,
  raw: string,
  actor: string,
) {
  const request = requestSchema.parse(JSON.parse(raw)),
    hash = createHash("sha256").update(raw).digest("hex");
  return transaction(source.tenant_id, async (tx) => {
    const controls = await controlsFor(source, tx, true);
    const p = [
      param("tenant", source.tenant_id),
      param("source", source.id),
      param("request", request.requestId),
    ];
    const prior = rows<{ request_hash: string; detail: unknown }>(
      await query(
        "SELECT request_hash,detail FROM operations_audit WHERE connection_id=CAST(:source AS uuid) AND request_id=CAST(:request AS uuid)",
        p,
        tx,
      ),
    )[0];
    if (prior) {
      if (prior.request_hash !== hash) fail("recovery_request_conflict");
      return { duplicate: true, detail: prior.detail };
    }
    let detail: unknown = {};
    if (request.action === "reconcile") {
      detail = { requested: true };
    } else if (request.action === "controls") {
      if (request.expectedRevision !== controls.revision)
        fail("controls_revision_conflict");
      await query(
        "UPDATE operations_controls SET revision=revision+1,intake_paused=CAST(:intake AS boolean),agent_paused=CAST(:agent AS boolean),outbound_paused=CAST(:outbound AS boolean),results_paused=CAST(:results AS boolean),retention_days=CAST(:days AS int),legal_hold=CAST(:hold AS boolean),updated_at=now() WHERE connection_id=CAST(:source AS uuid)",
        [
          ...p,
          param("intake", String(request.intakePaused)),
          param("agent", String(request.agentPaused)),
          param("outbound", String(request.outboundPaused)),
          param("results", String(request.resultsPaused)),
          param("days", String(request.retentionDays)),
          param("hold", String(request.legalHold)),
        ],
        tx,
      );
      detail = { before: controls, after: await controlsFor(source, tx) };
    } else {
      const target = request.targetId;
      p.push(param("target", target));
      const repeats = rows<{ n: number }>(
        await query(
          "SELECT count(*)::int AS n FROM operations_audit WHERE connection_id=CAST(:source AS uuid) AND target_id=CAST(:target AS uuid) AND action IN ('requeue_work','retry_delivery')",
          p,
          tx,
        ),
      )[0]!.n;
      if (
        repeats >= 3 &&
        ["requeue_work", "retry_delivery"].includes(request.action)
      )
        fail("manual_recovery_budget_exhausted");
      if(request.action==='delete_case'){
        const state=await getCase(source,target,tx,true);
        if(state.origin!=='simulated')fail('simulated_case_required');
        if(!['completed','cancelled','handed_off'].includes(state.status)){
          const policy=await policyFor(source,tx),coordinator=policy?.actors.find(a=>a.enabled&&a.role==='coordinator');
          if(!coordinator)fail('coordinator_required');
          await applyCommand(source,target,JSON.stringify({commandId:request.requestId,expectedRevision:state.revision,actorId:coordinator!.id,operation:{type:'cancel',reason:request.reason}}),tx);
        }
        await query("UPDATE result_dispatches SET state='superseded' WHERE case_id=CAST(:target AS uuid) AND connection_id=CAST(:source AS uuid) AND state='pending'",p,tx);
        await query("UPDATE channel_deliveries SET status='blocked',reason='case_removed' WHERE case_id=CAST(:target AS uuid) AND connection_id=CAST(:source AS uuid) AND status='pending'",p,tx);
        detail={caseId:target,removed:true,recoverable:true,evidenceRetained:true};
      }else if(request.action==='restore_case'){
        const exists=rows<{id:string;status:string}>(await query("SELECT id,status FROM coordination_cases WHERE id=CAST(:target AS uuid) AND connection_id=CAST(:source AS uuid)",p,tx))[0];
        if(!exists)fail('case_not_found');
        detail={caseId:target,removed:false,status:exists!.status};
      }else if (request.action === "requeue_work") {
        const sql =
          request.lane === "intake"
            ? "UPDATE outbox_jobs j SET state='pending',attempts=0,lease_until=NULL,lease_token=NULL WHERE j.id=CAST(:target AS uuid) AND EXISTS(SELECT 1 FROM inbox_events i WHERE i.tenant_id=j.tenant_id AND i.id=j.inbox_id AND i.connection_id=CAST(:source AS uuid)) AND (j.state='exhausted' OR (j.state='dispatched' AND coalesce(j.dispatched_at,j.created_at)<now()-interval '20 minutes') OR (j.state='leased' AND j.lease_until<now())) RETURNING j.id"
            : request.lane === "coordination"
              ? "UPDATE coordination_jobs j SET state='pending',attempts=0,lease_until=NULL,lease_token=NULL WHERE j.id=CAST(:target AS uuid) AND EXISTS(SELECT 1 FROM coordination_cases c WHERE c.tenant_id=j.tenant_id AND c.id=j.case_id AND c.connection_id=CAST(:source AS uuid) AND c.revision=j.expected_revision) AND (j.state='exhausted' OR (j.state='dispatched' AND j.due_at<now() AND coalesce(j.dispatched_at,j.created_at)<now()-interval '20 minutes') OR (j.state='leased' AND j.lease_until<now())) RETURNING j.id"
              : request.lane === "outbound"
                ? "UPDATE channel_deliveries SET queue_attempts=0,queued_at=NULL WHERE id=CAST(:target AS uuid) AND connection_id=CAST(:source AS uuid) AND status='pending' AND queue_attempts>=3 RETURNING id"
                : request.lane === "result"
                  ? "UPDATE result_dispatches SET state='pending',attempts=0,queue_attempts=0,queued_at=NULL,started_at=NULL WHERE result_id=CAST(:target AS uuid) AND connection_id=CAST(:source AS uuid) AND state='review' RETURNING result_id AS id"
                  : "UPDATE ai_runs SET queue_attempts=0,queued_at=NULL WHERE id=CAST(:target AS uuid) AND connection_id=CAST(:source AS uuid) AND state='pending' AND queue_attempts>=3 RETURNING id";
        detail =
          rows(await query(sql, p, tx))[0] ??
          fail("work_not_recoverable_in_this_state");
      } else if (request.action === "resolve_delivery") {
        if (request.outcome === "accepted" && !request.providerId)
          fail("provider_message_id_required");
        detail =
          rows(
            await query(
              "UPDATE channel_deliveries SET status=:status,reason=:reason,provider_message_id=CASE WHEN :status='accepted' THEN :provider ELSE provider_message_id END WHERE id=CAST(:target AS uuid) AND connection_id=CAST(:source AS uuid) AND status='uncertain' AND (provider_message_id IS NULL OR provider_message_id=:provider) RETURNING id,status",
              [
                ...p,
                param(
                  "status",
                  request.outcome === "accepted" ? "accepted" : "blocked",
                ),
                param(
                  "reason",
                  request.outcome === "accepted"
                    ? "operator_confirmed_accepted"
                    : "operator_confirmed_not_sent",
                ),
                param("provider", request.providerId ?? ""),
              ],
              tx,
            ),
          )[0] ?? fail("delivery_not_uncertain_or_provider_conflict");
        detail = {
          result: detail,
          evidenceRef: request.evidenceRef,
          providerId: request.providerId,
          attestation: "operator_supplied_not_provider_verified",
        };
      } else if (request.action === "retry_delivery") {
        detail =
          rows(
            await query(
              "UPDATE channel_deliveries d SET status='pending',reason=NULL,queued_at=NULL,queue_attempts=0 WHERE d.id=CAST(:target AS uuid) AND d.connection_id=CAST(:source AS uuid) AND d.status='blocked' AND d.reason IN ('provider_rejected','provider_delivery_failed','whatsapp_session_or_approved_template_required','template_verification_unavailable','operator_confirmed_not_sent','case_integrity_review_required') AND NOT EXISTS(SELECT 1 FROM channel_deliveries other WHERE other.tenant_id=d.tenant_id AND other.contact_id=d.contact_id AND other.id<>d.id AND other.status IN ('pending','sending','accepted','uncertain')) RETURNING d.id",
              p,
              tx,
            ),
          )[0] ?? fail("delivery_not_safe_to_retry");
        detail = { result: detail, evidenceRef: request.evidenceRef };
      } else {
        if (controls.legal_hold) fail("retention_legal_hold");
        detail = rows(
          await query(
            "SELECT redact_case_ai_traces(CAST(:source AS uuid),CAST(:target AS uuid),:actor) AS redacted_runs",
            [...p, param("actor", actor)],
            tx,
          ),
        )[0];
      }
    }
    await query(
      "INSERT INTO operations_audit(tenant_id,connection_id,id,request_id,request_hash,actor,action,target_id,reason,detail) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),CAST(:request AS uuid),:hash,:actor,:action,CAST(NULLIF(:target,'') AS uuid),:reason,CAST(:detail AS jsonb))",
      [
        param("tenant", source.tenant_id),
        param("source", source.id),
        param("id", randomUUID()),
        param("request", request.requestId),
        param("hash", hash),
        param("actor", actor),
        param("action", request.action),
        param("target", "targetId" in request ? request.targetId : ""),
        param("reason", request.reason),
        param("detail", JSON.stringify(detail)),
      ],
      tx,
    );
    return { requestId: request.requestId, detail };
  });
}
