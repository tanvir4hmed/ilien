import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../../packages/persistence/src/database.js";
const sqs = new SQSClient({ maxAttempts: 3 });
export async function handler(event: unknown) {
  const { tenantId } = z.strictObject({ tenantId: z.uuid() }).parse(event);
  const lease = randomUUID();
  const jobs = await transaction(tenantId, async (tx) =>
    rows<{ id: string; inbox_id: string }>(
      await query(
        "WITH candidates AS (SELECT id FROM outbox_jobs WHERE (state='pending' OR (state='leased' AND lease_until<now())) AND attempts<3 AND EXISTS(SELECT 1 FROM inbox_events i JOIN operations_controls o ON o.tenant_id=i.tenant_id AND o.connection_id=i.connection_id WHERE i.id=outbox_jobs.inbox_id AND i.tenant_id=outbox_jobs.tenant_id AND NOT o.intake_paused) ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE outbox_jobs j SET state='leased',lease_token=CAST(:lease AS uuid),lease_until=now()+interval '2 minutes',attempts=attempts+1 FROM candidates c WHERE j.id=c.id RETURNING j.id,j.inbox_id",
        [param("lease", lease)],
        tx,
      ),
    ),
  );
  for (const job of jobs) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.QUEUE_URL,
        MessageBody: JSON.stringify({
          tenantId,
          jobId: job.id,
          inboxId: job.inbox_id,
        }),
      }),
    );
    await transaction(tenantId, (tx) =>
      query(
        "UPDATE outbox_jobs SET state='dispatched',dispatched_at=now(),lease_until=NULL WHERE id=CAST(:id AS uuid) AND lease_token=CAST(:lease AS uuid) AND state='leased'",
        [param("id", job.id), param("lease", lease)],
        tx,
      ),
    );
  }
  const timers = await transaction(tenantId, async (tx) =>
    rows<{ id: string; case_id: string; due_at: string }>(
      await query(
        "WITH candidates AS (SELECT id FROM coordination_jobs WHERE (state='pending' OR (state='leased' AND lease_until<now())) AND attempts<3 ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE coordination_jobs j SET state='leased',lease_token=CAST(:lease AS uuid),lease_until=now()+interval '3 minutes',attempts=attempts+1 FROM candidates c WHERE j.id=c.id RETURNING j.id,j.case_id,j.due_at",
        [param("lease", lease)],
        tx,
      ),
    ),
  );
  for (const timer of timers) {
    const delay = Math.max(
      0,
      Math.min(900, Math.ceil((Date.parse(timer.due_at) - Date.now()) / 1000)),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.COORDINATION_QUEUE_URL,
        DelaySeconds: delay,
        MessageBody: JSON.stringify({ tenantId, jobId: timer.id }),
      }),
    );
    await transaction(tenantId, (tx) =>
      query(
        "UPDATE coordination_jobs SET state='dispatched',dispatched_at=now(),lease_until=NULL WHERE id=CAST(:id AS uuid) AND lease_token=CAST(:lease AS uuid) AND state='leased'",
        [param("id", timer.id), param("lease", lease)],
        tx,
      ),
    );
  }
  const deliveries = await transaction(tenantId, async (tx) =>
    rows<{ id: string }>(
      await query(
        "WITH candidates AS (SELECT id FROM channel_deliveries WHERE status='pending' AND queue_attempts<3 AND EXISTS(SELECT 1 FROM operations_controls o WHERE o.tenant_id=channel_deliveries.tenant_id AND o.connection_id=channel_deliveries.connection_id AND NOT o.outbound_paused) AND (queued_at IS NULL OR queued_at<now()-interval '5 minutes') ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE channel_deliveries d SET queued_at=now(),queue_attempts=queue_attempts+1 FROM candidates c WHERE d.id=c.id RETURNING d.id",
        [],
        tx,
      ),
    ),
  );
  for (const delivery of deliveries)
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.CHANNEL_QUEUE_URL,
        MessageBody: JSON.stringify({ tenantId, deliveryId: delivery.id }),
      }),
    );
  return {
    agentRuns: await dispatchAgents(tenantId),
    results: await dispatchResults(tenantId),
    dispatched: jobs.length,
    timers: timers.length,
    deliveries: deliveries.length,
  };
}

async function dispatchAgents(tenantId: string) {
  const runs = await transaction(tenantId, async (tx) =>
    rows<{ id: string }>(
      await query(
        "WITH candidates AS (SELECT id FROM ai_runs WHERE state='pending' AND queue_attempts<3 AND EXISTS(SELECT 1 FROM operations_controls o WHERE o.tenant_id=ai_runs.tenant_id AND o.connection_id=ai_runs.connection_id AND NOT o.agent_paused) AND (queued_at IS NULL OR queued_at<now()-interval '5 minutes') ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED) UPDATE ai_runs r SET queued_at=now(),queue_attempts=queue_attempts+1 FROM candidates c WHERE r.id=c.id RETURNING r.id",
        [],
        tx,
      ),
    ),
  );
  for (const run of runs)
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.AGENT_QUEUE_URL,
        MessageBody: JSON.stringify({ tenantId, runId: run.id }),
      }),
    );
  return runs.length;
}

async function dispatchResults(tenantId: string) {
  const jobs = await transaction(tenantId, async (tx) =>
    rows<{ result_id: string }>(
      await query(
        "WITH candidates AS (SELECT result_id FROM result_dispatches WHERE state='pending' AND queue_attempts<3 AND attempts<3 AND EXISTS(SELECT 1 FROM operations_controls o WHERE o.tenant_id=result_dispatches.tenant_id AND o.connection_id=result_dispatches.connection_id AND NOT o.results_paused) AND (queued_at IS NULL OR queued_at<now()-interval '5 minutes') ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE result_dispatches d SET queued_at=now(),queue_attempts=queue_attempts+1 FROM candidates c WHERE d.result_id=c.result_id RETURNING d.result_id",
        [],
        tx,
      ),
    ),
  );
  for (const job of jobs)
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.RESULT_QUEUE_URL,
        MessageBody: JSON.stringify({ tenantId, resultId: job.result_id }),
      }),
    );
  return jobs.length;
}
