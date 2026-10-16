import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { processTimer } from "../../../packages/coordination/src/service.js";
const client = new LambdaClient({ maxAttempts: 2 });
const schema = z.strictObject({ tenantId: z.uuid(), jobId: z.uuid() });
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const item = schema.parse(JSON.parse(record.body));
      await processTimer(item.tenantId, item.jobId);
      await client.send(
        new InvokeCommand({
          FunctionName: process.env.RELAY_FUNCTION,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ tenantId: item.tenantId })),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "coordination_job_failed",
          messageId: record.messageId,
          errorType: error instanceof Error ? error.name : "Unknown",
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
