import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { z } from "zod";
import { processRun } from "../../../packages/ai/src/worker.js";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
const relay = new LambdaClient({ maxAttempts: 2 });
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const input = z
        .strictObject({ tenantId: z.uuid(), runId: z.uuid() })
        .parse(JSON.parse(record.body));
      await processRun(input.tenantId, input.runId);
      await relay.send(new InvokeCommand({
        FunctionName: process.env.RELAY_FUNCTION,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ tenantId: input.tenantId })),
      }));
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
