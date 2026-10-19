import {
  query,
  param,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import type { Source } from "../../coordination/src/service.js";
import { controlsFor } from "./controls.js";
export async function reconcile(source: Source) {
  return transaction(source.tenant_id, async (tx) => {
    const enabled = rows(
      await query(
        "SELECT id FROM source_connections WHERE id=CAST(:source AS uuid) AND enabled",
        [param("source", source.id)],
        tx,
      ),
    );
    if (!enabled.length) return { disabled: true };
    await controlsFor(source, tx);
    const p = [param("source", source.id)];
    const intake = rows(
      await query(
        "WITH candidates AS (SELECT j.id FROM outbox_jobs j JOIN inbox_events i ON i.tenant_id=j.tenant_id AND i.id=j.inbox_id WHERE i.connection_id=CAST(:source AS uuid) AND ((j.state='leased' AND j.lease_until<now()) OR (j.state='dispatched' AND coalesce(j.dispatched_at,j.created_at)<now()-interval '20 minutes') OR (j.state='pending' AND j.attempts>=3)) ORDER BY j.created_at LIMIT 100 FOR UPDATE OF j SKIP LOCKED) UPDATE outbox_jobs j SET state=CASE WHEN attempts>=3 THEN 'exhausted' ELSE 'pending' END,lease_until=NULL,lease_token=NULL FROM candidates x WHERE x.id=j.id RETURNING j.id,j.state",
        p,
        tx,
      ),
    );
    const timers = rows(
      await query(
        "WITH candidates AS (SELECT j.id,(c.revision<>j.expected_revision OR c.status IN ('completed','cancelled','handed_off')) AS obsolete FROM coordination_jobs j JOIN coordination_cases c ON c.tenant_id=j.tenant_id AND c.id=j.case_id WHERE c.connection_id=CAST(:source AS uuid) AND j.state IN ('pending','leased','dispatched') AND (c.revision<>j.expected_revision OR c.status IN ('completed','cancelled','handed_off') OR (j.state='leased' AND j.lease_until<now()) OR (j.state='dispatched' AND j.due_at<now() AND coalesce(j.dispatched_at,j.created_at)<now()-interval '20 minutes') OR j.attempts>=3) ORDER BY j.created_at LIMIT 100 FOR UPDATE OF j SKIP LOCKED) UPDATE coordination_jobs j SET state=CASE WHEN x.obsolete THEN 'processed' WHEN attempts>=3 THEN 'exhausted' ELSE 'pending' END,lease_until=NULL,lease_token=NULL FROM candidates x WHERE x.id=j.id RETURNING j.id,j.state",
        p,
        tx,
      ),
    );
    const channels = rows(
      await query(
        "WITH candidates AS (SELECT id FROM channel_deliveries WHERE connection_id=CAST(:source AS uuid) AND status='sending' AND attempt_at<now()-interval '10 minutes' ORDER BY attempt_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE channel_deliveries d SET status='uncertain',reason='worker_interrupted_requires_provider_reconciliation' FROM candidates x WHERE x.id=d.id RETURNING d.id",
        p,
        tx,
      ),
    );
    const agents = rows(
      await query(
        "WITH candidates AS (SELECT id FROM ai_runs WHERE connection_id=CAST(:source AS uuid) AND state='running' AND started_at<now()-interval '10 minutes' ORDER BY started_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE ai_runs r SET state='uncertain',reason='worker_interrupted_no_automatic_inference_retry',updated_at=now() FROM candidates x WHERE x.id=r.id RETURNING r.id",
        p,
        tx,
      ),
    );
    const results = rows(
      await query(
        "WITH candidates AS (SELECT result_id FROM result_dispatches WHERE connection_id=CAST(:source AS uuid) AND ((state='publishing' AND started_at<now()-interval '10 minutes') OR (state='pending' AND (attempts>=3 OR queue_attempts>=3))) ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE result_dispatches d SET state='review' FROM candidates x WHERE x.result_id=d.result_id RETURNING d.result_id",
        p,
        tx,
      ),
    );
    const attention = rows<{ uncertain: number; exhausted: number }>(
      await query(
        "SELECT ((SELECT count(*) FROM channel_deliveries WHERE connection_id=CAST(:source AS uuid) AND status='uncertain')+(SELECT count(*) FROM ai_runs WHERE connection_id=CAST(:source AS uuid) AND state='uncertain'))::int AS uncertain,((SELECT count(*) FROM outbox_jobs j JOIN inbox_events i ON i.tenant_id=j.tenant_id AND i.id=j.inbox_id WHERE i.connection_id=CAST(:source AS uuid) AND j.state='exhausted')+(SELECT count(*) FROM coordination_jobs j JOIN coordination_cases c ON c.tenant_id=j.tenant_id AND c.id=j.case_id WHERE c.connection_id=CAST(:source AS uuid) AND j.state='exhausted')+(SELECT count(*) FROM result_dispatches WHERE connection_id=CAST(:source AS uuid) AND state='review')+(SELECT count(*) FROM channel_deliveries WHERE connection_id=CAST(:source AS uuid) AND status='pending' AND queue_attempts>=3)+(SELECT count(*) FROM ai_runs WHERE connection_id=CAST(:source AS uuid) AND state='pending' AND queue_attempts>=3))::int AS exhausted",
        p,
        tx,
      ),
    )[0]!;
    return {
      currentUncertainEffects: attention.uncertain,
      currentExhaustedDispatches: attention.exhausted,
      intake: intake.length,
      timers: timers.length,
      uncertainChannels: channels.length,
      uncertainAgents: agents.length,
      resultReview: results.length,
      exhausted:
        intake.filter((r) => (r as { state: string }).state === "exhausted")
          .length +
        timers.filter((r) => (r as { state: string }).state === "exhausted")
          .length,
    };
  });
}
