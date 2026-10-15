import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { param,query,rows,transaction } from "../../../packages/persistence/src/database.js";
const sqs = new SQSClient({ maxAttempts: 3 });
export async function handler(event: unknown) {
  const { tenantId } = z.strictObject({ tenantId: z.uuid() }).parse(event);
  const lease = randomUUID();
  const jobs = await transaction(tenantId, async tx => rows<{id:string;inbox_id:string}>(await query("WITH candidates AS (SELECT id FROM outbox_jobs WHERE state='pending' OR (state='leased' AND lease_until<now()) ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE outbox_jobs j SET state='leased',lease_token=CAST(:lease AS uuid),lease_until=now()+interval '2 minutes',attempts=attempts+1 FROM candidates c WHERE j.id=c.id RETURNING j.id,j.inbox_id", [param("lease",lease)],tx)));
  for (const job of jobs) {
    await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify({tenantId,jobId:job.id,inboxId:job.inbox_id}) }));
    await transaction(tenantId, tx => query("UPDATE outbox_jobs SET state='dispatched',lease_until=NULL WHERE id=CAST(:id AS uuid) AND lease_token=CAST(:lease AS uuid) AND state='leased'", [param("id",job.id),param("lease",lease)],tx));
  }
  return { dispatched: jobs.length };
}
