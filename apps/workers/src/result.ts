import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../../packages/persistence/src/database.js";
import { decode } from "../../../packages/channels/src/intents.js";
import { pausedFor } from "../../../packages/operations/src/controls.js";
import { caseHeld } from "../../../packages/operations/src/supervision.js";
import {queueCompletionNotice} from '../../../packages/channels/src/completion.js';
const sns = new SNSClient({ maxAttempts: 1 });
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records)
    try {
      const job = z
        .strictObject({ tenantId: z.uuid(), resultId: z.uuid() })
        .parse(JSON.parse(record.body));
      if (job.tenantId !== process.env.TENANT_ID)
        throw new Error("Unconfigured result tenant");
      const prepared = await transaction(job.tenantId, async (tx) => {
        const row = rows<{
          state: string;
          started_at: string | null;
          connection_id: string;
          case_id: string;
          result: unknown;
          case_revision: number;
          current_revision: number;
          enabled: boolean;
          attempts: number;
        }>(
          await query(
            "SELECT d.attempts,d.state,d.started_at,d.connection_id,d.case_id,r.result,r.case_revision,c.revision AS current_revision,s.enabled FROM result_dispatches d JOIN coordination_results r ON r.tenant_id=d.tenant_id AND r.id=d.result_id JOIN coordination_cases c ON c.tenant_id=d.tenant_id AND c.id=d.case_id JOIN source_connections s ON s.tenant_id=d.tenant_id AND s.id=d.connection_id WHERE d.result_id=CAST(:id AS uuid) FOR UPDATE OF d,c",
            [param("id", job.resultId)],
            tx,
          ),
        )[0];
        if (!row || ["published", "superseded", "review"].includes(row.state))
          return null;
        if (!row.enabled || row.connection_id !== process.env.SOURCE_ID)
          throw new Error("Unconfigured result source");
        if (
          await pausedFor(
            {
              tenant_id: job.tenantId,
              id: row.connection_id,
              origin: "simulated",
            },
            "results",
            tx,
          )
        )
          return null;
        if (await caseHeld(row.case_id, tx)) return null;
        if (row.attempts >= 3) {
          await query(
            "UPDATE result_dispatches SET state='review' WHERE result_id=CAST(:id AS uuid)",
            [param("id", job.resultId)],
            tx,
          );
          return null;
        }
        if (
          row.state === "publishing" &&
          row.started_at &&
          Date.parse(row.started_at) > Date.now() - 120000
        )
          throw new Error("Result publish leased");
        if (row.case_revision !== row.current_revision) {
          await query(
            "UPDATE result_dispatches SET state='superseded' WHERE result_id=CAST(:id AS uuid)",
            [param("id", job.resultId)],
            tx,
          );
          return null;
        }
        await query(
          "UPDATE result_dispatches SET state='publishing',started_at=now(),attempts=attempts+1 WHERE result_id=CAST(:id AS uuid)",
          [param("id", job.resultId)],
          tx,
        );
        return {
          tenantId: job.tenantId,
          sourceId: row.connection_id,
          result: decode(row.result),
          deliverySemantics: "at_least_once",
          resultId: job.resultId,
        };
      });
      if (!prepared) continue;
      const message = JSON.stringify(prepared);
      if (Buffer.byteLength(message) > 240000)
        throw new Error("Result payload exceeds boundary");
      const published = await sns.send(
        new PublishCommand({
          TopicArn: process.env.RESULT_TOPIC_ARN,
          Message: message,
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      await transaction(job.tenantId, async (tx) => {
        await query(
          "UPDATE result_dispatches SET state='published',provider_id=:provider WHERE result_id=CAST(:id AS uuid)",
          [param("id", job.resultId), param("provider", published.MessageId!)],
          tx,
        );
        await queueCompletionNotice(job.tenantId,job.resultId,tx);
      });
    } catch {
      console.error(
        JSON.stringify({
          code: "result_dispatch_failed",
          messageId: record.messageId,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  return { batchItemFailures };
}
