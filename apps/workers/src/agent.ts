import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { z } from "zod";
import { processRun } from "../../../packages/ai/src/worker.js";
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const input = z
        .strictObject({ tenantId: z.uuid(), runId: z.uuid() })
        .parse(JSON.parse(record.body));
      await processRun(input.tenantId, input.runId);
    } catch {
      console.error(
        JSON.stringify({
          code: "agent_worker_failed",
          messageId: record.messageId,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
