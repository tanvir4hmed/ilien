import type { APIGatewayProxyEventV2WithIAMAuthorizer } from "aws-lambda";
import { createHash, randomUUID } from "node:crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { sourceEventSchema } from "../../../packages/contracts/src/validation.js";
import { param, query, rows, transaction } from "../../../packages/persistence/src/database.js";
const lambda = new LambdaClient({ maxAttempts: 2 });
const response = (statusCode: number, body: unknown) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
type Source = { tenant_id: string; id: string; origin: string };
export async function handler(event: APIGatewayProxyEventV2WithIAMAuthorizer) {
  if (event.rawPath === "/health") return response(200, { service: "ilien", phase: "foundation", version: "0.1.0" });
  const principal = event.requestContext.authorizer?.iam?.userArn;
  if (!principal) return response(401, { error: "authentication_required" });
  try {
    const source = rows<Source>(await query("SELECT * FROM resolve_source(:principal)", [param("principal", principal)]))[0];
    if (!source) return response(403, { error: "source_not_authorized" });
    if (event.requestContext.http.method === "GET" && event.rawPath === "/v1/events") {
      const items = await transaction(source.tenant_id, tx => query("SELECT id,external_id,event_type,status,disposition,received_at FROM inbox_events WHERE connection_id=CAST(:connection AS uuid) ORDER BY received_at DESC LIMIT 50", [param("connection", source.id)], tx));
      return response(200, { items: rows(items) });
    }
    if (event.requestContext.http.method !== "POST" || event.rawPath !== "/v1/events") return response(404, { error: "not_found" });
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
    if (Buffer.byteLength(raw) > 262144) return response(413, { error: "payload_too_large" });
    let input: unknown;
    try { input = JSON.parse(raw); } catch { return response(400, { error: "invalid_json" }); }
    const parsed = sourceEventSchema.safeParse(input);
    if (!parsed.success) return response(422, { error: "invalid_event" });
    const envelope = parsed.data;
    const hash = createHash("sha256").update(raw).digest("hex");
    const accepted = await transaction(source.tenant_id, async tx => {
      // Serialize equal source/event keys, including concurrent first arrivals.
      await query("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text", [param("key", `${source.tenant_id}/${source.id}/${envelope.eventId}`)], tx);
      const existing = rows<{ id: string; content_hash: string }>(await query("SELECT id,content_hash FROM inbox_events WHERE connection_id=CAST(:connection AS uuid) AND external_id=:external", [param("connection", source.id),param("external",envelope.eventId)],tx))[0];
      if (existing) return { id: existing.id, duplicate: true, conflict: existing.content_hash !== hash };
      const id = randomUUID(), evidence = randomUUID();
      await query("INSERT INTO evidence_items(tenant_id,id,origin,original_text,sha256) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),:origin,:raw,:hash)", [param("tenant",source.tenant_id),param("id",evidence),param("origin",source.origin),param("raw",raw),param("hash",hash)],tx);
      await query("INSERT INTO inbox_events(tenant_id,id,connection_id,external_id,event_type,occurred_at,evidence_id,content_hash) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:connection AS uuid),:external,:type,CAST(:occurred AS timestamptz),CAST(:evidence AS uuid),:hash)", [param("tenant",source.tenant_id),param("id",id),param("connection",source.id),param("external",envelope.eventId),param("type",envelope.eventType),param("occurred",envelope.occurredAt),param("evidence",evidence),param("hash",hash)],tx);
      await query("INSERT INTO outbox_jobs(tenant_id,id,inbox_id,kind) VALUES(CAST(:tenant AS uuid),CAST(:job AS uuid),CAST(:inbox AS uuid),'event.accepted')", [param("tenant",source.tenant_id),param("job",randomUUID()),param("inbox",id)],tx);
      return { id, duplicate: false, conflict: false };
    });
    if (accepted.conflict) return response(409, { error: "event_id_content_conflict" });
    // The durable outbox survives a missed dispatch wake; reconciliation can retry it.
    await lambda.send(new InvokeCommand({ FunctionName: process.env.RELAY_FUNCTION, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ tenantId: source.tenant_id })) })).catch(() => console.error(JSON.stringify({ code: "relay_wake_failed", inboxId: accepted.id })));
    return response(accepted.duplicate ? 200 : 202, { inboxId: accepted.id, duplicate: accepted.duplicate, disposition: "triage" });
  } catch {
    console.error(JSON.stringify({ code: "intake_unavailable", requestId: event.requestContext.requestId }));
    return response(503, { error: "temporarily_unavailable" });
  }
}
