import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { fallbackDelivery } from "../../../packages/channels/src/intents.js";
const sqs = new SQSClient({ maxAttempts: 3 });
import { z } from "zod";
import { sendDelivery } from "../../../packages/channels/src/outbound.js";
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const job = z
        .strictObject({ tenantId: z.uuid(), deliveryId: z.uuid() })
        .parse(JSON.parse(record.body));
      const delay = await sendDelivery(job.tenantId, job.deliveryId);
      if (delay)
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: process.env.CHANNEL_QUEUE_URL,
            DelaySeconds: delay,
            MessageBody: record.body,
          }),
        );
      if (!delay) {
        const next = await fallbackDelivery(job.tenantId, job.deliveryId);
        if (next)
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: process.env.CHANNEL_QUEUE_URL,
              MessageBody: JSON.stringify({
                tenantId: job.tenantId,
                deliveryId: next,
              }),
            }),
          );
      }
    } catch {
      console.error(
        JSON.stringify({
          code: "channel_send_worker_failed",
          messageId: record.messageId,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
