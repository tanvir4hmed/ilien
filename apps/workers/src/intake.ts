import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../../packages/persistence/src/database.js";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { activateCase } from "../../../packages/coordination/src/service.js";
const lambda = new LambdaClient({ maxAttempts: 2 });
const job = z.strictObject({
  tenantId: z.uuid(),
  jobId: z.uuid(),
  inboxId: z.uuid(),
});
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const item = job.parse(JSON.parse(record.body));
      await transaction(item.tenantId, async (tx) => {
        const jobs = rows<{ state: string }>(
          await query(
            "SELECT state FROM outbox_jobs WHERE id=CAST(:job AS uuid) AND inbox_id=CAST(:inbox AS uuid) FOR UPDATE",
            [param("job", item.jobId), param("inbox", item.inboxId)],
            tx,
          ),
        );
        if (!jobs[0]) throw new Error("Unknown work");
        if (jobs[0].state === "processed") return;
        const activated = await activateCase(item.tenantId, item.inboxId, tx);
        await query(
          "UPDATE inbox_events SET status=:status,disposition=:disposition WHERE id=CAST(:inbox AS uuid)",
          [
            param("inbox", item.inboxId),
            param(
              "status",
              activated ? "coordinating" : "awaiting_coordination",
            ),
            param("disposition", activated ? "create_mission" : "triage"),
          ],
          tx,
        );
        await query(
          "UPDATE outbox_jobs SET state='processed',lease_until=NULL WHERE id=CAST(:job AS uuid)",
          [param("job", item.jobId)],
          tx,
        );
      });
      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.RELAY_FUNCTION,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ tenantId: item.tenantId })),
        }),
      );
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
