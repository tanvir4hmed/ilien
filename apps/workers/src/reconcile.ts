import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { reconcile } from "../../../packages/operations/src/reconcile.js";
import { transaction } from "../../../packages/persistence/src/database.js";
import { superviseCases } from "../../../packages/operations/src/supervision.js";
const client = new LambdaClient({ maxAttempts: 2 });
export async function handler(event: unknown) {
  const input = z
    .strictObject({ tenantId: z.uuid(), sourceId: z.uuid() })
    .parse(event);
  if (
    input.tenantId !== process.env.TENANT_ID ||
    input.sourceId !== process.env.SOURCE_ID
  )
    throw new Error("Unconfigured maintenance scope");
  const result = await reconcile({
    tenant_id: input.tenantId,
    id: input.sourceId,
    origin: "simulated",
  });
  const caseChecks =
    "disabled" in result
      ? { checked: 0, review: 0, skipped: 0 }
      : await transaction(input.tenantId, (tx) =>
          superviseCases(
            {
              tenant_id: input.tenantId,
              id: input.sourceId,
              origin: "simulated",
            },
            tx,
          ),
        );
  await client.send(
    new InvokeCommand({
      FunctionName: process.env.RELAY_FUNCTION,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ tenantId: input.tenantId })),
    }),
  );
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "ILIEN/Operations",
            Dimensions: [["Service"]],
            Metrics: [
              { Name: "ReconciliationHeartbeat", Unit: "Count" },
              { Name: "UncertainEffects", Unit: "Count" },
              { Name: "ExhaustedDispatches", Unit: "Count" },
              { Name: "InvariantViolations", Unit: "Count" },
            ],
          },
        ],
      },
      Service: "ilien",
      ReconciliationHeartbeat: 1,
      UncertainEffects:
        "currentUncertainEffects" in result
          ? (result.currentUncertainEffects ?? 0)
          : 0,
      ExhaustedDispatches:
        "currentExhaustedDispatches" in result
          ? (result.currentExhaustedDispatches ?? 0)
          : 0,
      InvariantViolations: caseChecks.review,
      code: "reconciliation_complete",
      counts: { ...result, caseChecks },
    }),
  );
  return result;
}
