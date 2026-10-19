import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import type { Source } from "../../coordination/src/service.js";
import { CoordinationError } from "../../coordination/src/types.js";
const client = new SQSClient({ maxAttempts: 2 });
export async function infrastructureView(source: Source) {
  if (
    source.tenant_id !== process.env.TENANT_ID ||
    source.id !== process.env.SOURCE_ID
  )
    throw new CoordinationError("infrastructure_scope_unconfigured", 403);
  const queues = JSON.parse(process.env.OPERATIONS_QUEUES ?? "{}") as Record<
    string,
    string
  >;
  const snapshot = await Promise.all(
    Object.entries(queues).map(async ([name, url]) => {
      try {
        const data = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
              "ApproximateNumberOfMessagesDelayed",
            ],
          }),
          { abortSignal: AbortSignal.timeout(5000) },
        );
        return {
          name,
          visible: Number(data.Attributes?.ApproximateNumberOfMessages ?? 0),
          inFlight: Number(
            data.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0,
          ),
          delayed: Number(
            data.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0,
          ),
        };
      } catch {
        return { name, error: "queue_status_unavailable" };
      }
    }),
  );
  return {
    observedAt: new Date().toISOString(),
    approximate: true,
    queues: snapshot,
    dashboard: process.env.OPERATIONS_DASHBOARD_URL,
  };
}
