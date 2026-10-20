import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { z } from "zod";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  normalize,
  boundedEvidence,
} from "../../../packages/channels/src/normalize.js";
import { receive } from "../../../packages/channels/src/inbound.js";
import { fallbackDelivery } from "../../../packages/channels/src/intents.js";
const lambda = new LambdaClient({ maxAttempts: 2 });
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const sns = z
        .object({
          Type: z.literal("Notification"),
          TopicArn: z.string(),
          Message: z.string(),
        })
        .parse(JSON.parse(record.body));
      const items = await normalize(sns.TopicArn, sns.Message);
      for (const item of items) {
        const result = await receive(
          process.env.TENANT_ID!,
          process.env.SOURCE_ID!,
          await boundedEvidence(item),
        );
        if (result && "failedDeliveryId" in result && result.failedDeliveryId)
          await fallbackDelivery(
            process.env.TENANT_ID!,
            result.failedDeliveryId,
          );
      }
      if (items.length)
        await lambda.send(
          new InvokeCommand({
            FunctionName: process.env.RELAY_FUNCTION,
            InvocationType: "Event",
            Payload: Buffer.from(
              JSON.stringify({ tenantId: process.env.TENANT_ID! }),
            ),
          }),
        );
    } catch {
      console.error(
        JSON.stringify({
          code: "channel_receive_worker_failed",
          messageId: record.messageId,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
