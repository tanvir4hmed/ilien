import type {
  APIGatewayProxyEventV2WithIAMAuthorizer,
  APIGatewayProxyEventV2WithJWTAuthorizer,
} from "aws-lambda";
import { createHash, randomUUID } from "node:crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { sourceEventSchema } from "../../../packages/contracts/src/validation.js";
import {
  param,
  query,
  rows,
  transaction,
} from "../../../packages/persistence/src/database.js";
import { z } from "zod";
import {
  executeCommand,
  listCases,
  listTasks,
  caseView,
  acknowledge,
  readEvidence,
} from "../../../packages/coordination/src/service.js";
import { CoordinationError } from "../../../packages/coordination/src/types.js";
import {
  saveBinding,
  dispatchContact,
  channelView,
} from "../../../packages/channels/src/admin.js";
import {
  inboxView,
  resolveReceipt,
} from "../../../packages/channels/src/inbox.js";
import { reviewReceipt } from "../../../packages/channels/src/review.js";
import {
  audit,
  readConfiguration,
  publishConfiguration,
  members,
} from "../../../packages/product/src/configuration.js";
import {
  operationsView,
  operationsWrite,
  requestSchema as operationsRequestSchema,
} from "../../../packages/operations/src/service.js";
import { pausedFor } from "../../../packages/operations/src/controls.js";
import { infrastructureView } from "../../../packages/operations/src/infrastructure.js";
const lambda = new LambdaClient({ maxAttempts: 2 });
import {
  enqueueAgent,
  listRuns,
  runDetail,
  reviewRun,
} from "../../../packages/ai/src/store.js";
import { adminView, adminWrite } from "../../../packages/ai/src/admin.js";
const response = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});
type Source = { tenant_id: string; id: string; origin: string };
export async function handler(
  event:
    | APIGatewayProxyEventV2WithIAMAuthorizer
    | APIGatewayProxyEventV2WithJWTAuthorizer,
) {
  if (event.rawPath === "/health")
    return response(200, {
      service: "ilien",
      phase: "autonomous-coordination-foundation",
      version: "0.9.0",
    });
  const consoleRequest = event.rawPath.startsWith("/console/");
  if (consoleRequest && event.requestContext.http.method === "OPTIONS")
    return { statusCode: 204, body: "" };
  const authorization = event.requestContext.authorizer;
  const claims =
    authorization && "jwt" in authorization
      ? authorization.jwt.claims
      : undefined;
  let principal =
    authorization && "iam" in authorization
      ? authorization.iam.userArn
      : undefined;
  if (consoleRequest) {
    if (
      !claims ||
      claims.token_use !== "access" ||
      ![process.env.OPERATOR_CLIENT_ID, process.env.OPERATOR_GUEST_CLIENT_ID]
        .filter(Boolean)
        .includes(String(claims.client_id)) ||
      claims.iss !== process.env.OPERATOR_ISSUER ||
      typeof claims.sub !== "string" ||
      !z.guid().safeParse(claims.sub).success ||
      !String(claims.scope ?? "")
        .split(" ")
        .some((scope) =>
          ["openid", "aws.cognito.signin.user.admin"].includes(scope),
        )
    )
      return response(401, { error: "invalid_operator_token" });
    principal = claims.sub;
    event = { ...event, rawPath: event.rawPath.slice("/console".length) };
  }
  if (!principal) return response(401, { error: "authentication_required" });
  try {
    const source = rows<Source & { role?: string }>(
      await query(
        consoleRequest
          ? "SELECT * FROM resolve_operator(CAST(:principal AS uuid))"
          : "SELECT * FROM resolve_source(:principal)",
        [param("principal", principal)],
      ),
    )[0];
    if (!source) return response(403, { error: "source_not_authorized" });
    const method = event.requestContext.http.method;
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    if (Buffer.byteLength(rawBody) > 24576)
      return response(413, { error: "request_too_large" });
    if (consoleRequest) {
      if (
        method !== "GET" &&
        (source.role === "viewer" ||
          !["admin", "operator"].includes(source.role ?? ""))
      )
        return response(403, { error: "operator_role_required" });
      if (
        method !== "GET" &&
        /^\/v1\/(configuration|members|ai\/(settings|knowledge)|channels\/bindings)$/.test(
          event.rawPath,
        ) &&
        source.role !== "admin"
      )
        return response(403, { error: "admin_required" });
      if (event.rawPath === "/v1/members" && source.role !== "admin")
        return response(403, { error: "admin_required" });
      if (method !== "GET")
        await audit(source, principal, `${method} ${event.rawPath}`, rawBody);
    }
    if (method === "GET" && event.rawPath === "/v1/me")
      return response(200, {
        subject: principal,
        role: source.role ?? "source",
        sourceId: source.id,
        origin: source.origin,
      });
    if (event.rawPath === "/v1/configuration") {
      if (method === "GET")
        return response(200, await readConfiguration(source));
      if (method === "POST")
        return response(
          200,
          await publishConfiguration(source, rawBody, principal),
        );
    }
    if (event.rawPath === "/v1/members") {
      if (method === "GET")
        return response(200, { items: await members(source) });
      if (method === "POST")
        return response(200, {
          items: await members(source, rawBody, principal),
        });
    }
    if (
      event.rawPath === "/v1/operations" ||
      event.rawPath === "/v1/operations/queues"
    ) {
      if (!consoleRequest || source.role !== "admin")
        return response(403, { error: "admin_required" });
      if (method === "GET")
        return response(
          200,
          event.rawPath.endsWith("/queues")
            ? await infrastructureView(source)
            : await operationsView(source),
        );
      if (method === "POST" && event.rawPath === "/v1/operations") {
        const request = operationsRequestSchema.parse(JSON.parse(rawBody));
        const result = await operationsWrite(source, rawBody, principal);
        if (!("duplicate" in result))
          await lambda
            .send(
              new InvokeCommand({
                FunctionName:
                  request.action === "reconcile"
                    ? process.env.RECONCILE_FUNCTION
                    : process.env.RELAY_FUNCTION,
                InvocationType: "Event",
                Payload: Buffer.from(
                  JSON.stringify({
                    tenantId: source.tenant_id,
                    ...(request.action === "reconcile"
                      ? { sourceId: source.id }
                      : {}),
                  }),
                ),
              }),
            )
            .catch(() =>
              console.error(
                JSON.stringify({
                  code: "operations_wake_failed",
                  requestId: request.requestId,
                }),
              ),
            );
        return response(200, result);
      }
      return response(404, { error: "not_found" });
    }
    const aiCase = /^\/v1\/cases\/([0-9a-f-]{36})\/agent$/.exec(event.rawPath);
    const aiRun = /^\/v1\/ai\/runs\/([0-9a-f-]{36})(?:\/(review))?$/.exec(
      event.rawPath,
    );
    const aiAdmin = /^\/v1\/ai\/(settings|knowledge)$/.exec(event.rawPath);
    if (aiCase || aiRun || aiAdmin) {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : (event.body ?? "");
      if (Buffer.byteLength(raw) > 12000)
        return response(413, { error: "ai_request_too_large" });
      if (method === "GET") {
        if (aiCase)
          return response(200, {
            items: await listRuns(source, z.uuid().parse(aiCase[1])),
          });
        if (aiRun && !aiRun[2])
          return response(
            200,
            await runDetail(source, z.uuid().parse(aiRun[1])),
          );
        if (aiAdmin) return response(200, await adminView(source, aiAdmin[1]!));
      }
      if (method === "POST") {
        let result: unknown;
        if (aiCase) {
          const input = z
            .strictObject({
              requestId: z.uuid(),
              receiptId: z.uuid().optional(),
            })
            .parse(JSON.parse(raw));
          result = await transaction(source.tenant_id, (tx) =>
            enqueueAgent(
              source,
              z.uuid().parse(aiCase[1]),
              input.receiptId ?? null,
              `operator:${input.requestId}`,
              tx,
            ),
          );
        } else if (aiRun?.[2] === "review")
          result = await reviewRun(
            source,
            z.uuid().parse(aiRun[1]),
            raw,
            principal,
          );
        else if (aiAdmin)
          result = await adminWrite(source, aiAdmin[1]!, raw, principal);
        else return response(404, { error: "not_found" });
        await lambda
          .send(
            new InvokeCommand({
              FunctionName: process.env.RELAY_FUNCTION,
              InvocationType: "Event",
              Payload: Buffer.from(
                JSON.stringify({ tenantId: source.tenant_id }),
              ),
            }),
          )
          .catch(() =>
            console.error(JSON.stringify({ code: "ai_relay_wake_failed" })),
          );
        return response(200, result);
      }
      return response(404, { error: "not_found" });
    }
    const channelRoute =
      /^\/v1\/channels\/(bindings|deliveries|receipts|delivery-events|dispatch|inbox|resolve|review)$/.exec(
        event.rawPath,
      );
    if (channelRoute) {
      const section = channelRoute[1]!;
      if (
        method === "GET" &&
        !["dispatch", "resolve", "review"].includes(section)
      )
        return response(200, {
          items:
            section === "inbox"
              ? await inboxView(source)
              : await channelView(source, section),
        });
      if (
        method === "POST" &&
        ["bindings", "dispatch", "resolve", "review"].includes(section)
      ) {
        const raw = event.isBase64Encoded
          ? Buffer.from(event.body ?? "", "base64").toString("utf8")
          : (event.body ?? "");
        if (Buffer.byteLength(raw) > 4096)
          return response(413, { error: "channel_request_too_large" });
        const result =
          section === "bindings"
            ? await saveBinding(source, raw)
            : section === "resolve"
              ? await resolveReceipt(source, raw, principal)
              : section === "review"
                ? await reviewReceipt(source, raw, principal)
                : await dispatchContact(source, raw);
        await lambda
          .send(
            new InvokeCommand({
              FunctionName: process.env.RELAY_FUNCTION,
              InvocationType: "Event",
              Payload: Buffer.from(
                JSON.stringify({ tenantId: source.tenant_id }),
              ),
            }),
          )
          .catch(() =>
            console.error(
              JSON.stringify({ code: "channel_relay_wake_failed" }),
            ),
          );
        return response(200, result);
      }
      return response(404, { error: "not_found" });
    }
    if (method === "GET" && event.rawPath === "/v1/cases")
      return response(200, { items: await listCases(source) });
    if (method === "GET" && event.rawPath === "/v1/tasks")
      return response(200, { items: await listTasks(source) });
    const evidenceRoute =
      /^\/v1\/cases\/([0-9a-f-]{36})\/evidence\/([0-9a-f-]{36})$/.exec(
        event.rawPath,
      );
    if (method === "GET" && evidenceRoute)
      return response(
        200,
        await readEvidence(
          source,
          z.uuid().parse(evidenceRoute[1]),
          z.uuid().parse(evidenceRoute[2]),
        ),
      );
    const route =
      /^\/v1\/cases\/([0-9a-f-]{36})(?:\/(commands|acknowledgements|policy|journey|journal|contacts|claims|results|rejections))?$/.exec(
        event.rawPath,
      );
    if (route) {
      const id = z.uuid().parse(route[1]),
        section = route[2] ?? "state";
      if (
        method === "GET" &&
        !["commands", "acknowledgements"].includes(section)
      )
        return response(200, await caseView(source, id, section));
      if (
        method === "POST" &&
        ["commands", "acknowledgements"].includes(section)
      ) {
        const raw = event.isBase64Encoded
          ? Buffer.from(event.body ?? "", "base64").toString("utf8")
          : (event.body ?? "");
        if (Buffer.byteLength(raw) > 16384)
          return response(413, { error: "command_too_large" });
        const result =
          section === "commands"
            ? await executeCommand(source, id, raw)
            : await acknowledge(source, id, raw);
        if (section === "commands")
          await lambda.send(
            new InvokeCommand({
              FunctionName: process.env.RELAY_FUNCTION,
              InvocationType: "Event",
              Payload: Buffer.from(
                JSON.stringify({ tenantId: source.tenant_id }),
              ),
            }),
          );
        return response(200, result);
      }
      return response(404, { error: "not_found" });
    }
    if (
      event.requestContext.http.method === "GET" &&
      event.rawPath === "/v1/events"
    ) {
      const items = await transaction(source.tenant_id, (tx) =>
        query(
          "SELECT i.id,i.external_id,i.event_type,i.status,i.disposition,i.received_at,c.id AS case_id,c.status AS case_status FROM inbox_events i LEFT JOIN LATERAL (SELECT id,status FROM coordination_cases WHERE inbox_id=i.id AND connection_id=i.connection_id ORDER BY updated_at DESC LIMIT 1) c ON true WHERE i.connection_id=CAST(:connection AS uuid) ORDER BY i.received_at DESC LIMIT 50",
          [param("connection", source.id)],
          tx,
        ),
      );
      return response(200, { items: rows(items) });
    }
    if (
      event.requestContext.http.method !== "POST" ||
      event.rawPath !== "/v1/events"
    )
      return response(404, { error: "not_found" });
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    if (Buffer.byteLength(raw) > 24576)
      return response(413, { error: "payload_too_large" });
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return response(400, { error: "invalid_json" });
    }
    const parsed = sourceEventSchema.safeParse(input);
    if (!parsed.success) return response(422, { error: "invalid_event" });
    const envelope = parsed.data;
    const hash = createHash("sha256").update(raw).digest("hex");
    const accepted = await transaction(source.tenant_id, async (tx) => {
      if (await pausedFor(source, "intake", tx))
        throw new CoordinationError("intake_paused", 503);
      // Serialize equal source/event keys, including concurrent first arrivals.
      await query(
        "SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text",
        [param("key", `${source.tenant_id}/${source.id}/${envelope.eventId}`)],
        tx,
      );
      const existing = rows<{ id: string; content_hash: string }>(
        await query(
          "SELECT id,content_hash FROM inbox_events WHERE connection_id=CAST(:connection AS uuid) AND external_id=:external",
          [param("connection", source.id), param("external", envelope.eventId)],
          tx,
        ),
      )[0];
      if (existing)
        return {
          id: existing.id,
          duplicate: true,
          conflict: existing.content_hash !== hash,
        };
      const id = randomUUID(),
        evidence = randomUUID();
      await query(
        "INSERT INTO evidence_items(tenant_id,id,origin,original_text,sha256) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),:origin,:raw,:hash)",
        [
          param("tenant", source.tenant_id),
          param("id", evidence),
          param("origin", source.origin),
          param("raw", raw),
          param("hash", hash),
        ],
        tx,
      );
      await query(
        "INSERT INTO inbox_events(tenant_id,id,connection_id,external_id,event_type,occurred_at,evidence_id,content_hash) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:connection AS uuid),:external,:type,CAST(:occurred AS timestamptz),CAST(:evidence AS uuid),:hash)",
        [
          param("tenant", source.tenant_id),
          param("id", id),
          param("connection", source.id),
          param("external", envelope.eventId),
          param("type", envelope.eventType),
          param("occurred", envelope.occurredAt),
          param("evidence", evidence),
          param("hash", hash),
        ],
        tx,
      );
      await query(
        "INSERT INTO outbox_jobs(tenant_id,id,inbox_id,kind) VALUES(CAST(:tenant AS uuid),CAST(:job AS uuid),CAST(:inbox AS uuid),'event.accepted')",
        [
          param("tenant", source.tenant_id),
          param("job", randomUUID()),
          param("inbox", id),
        ],
        tx,
      );
      return { id, duplicate: false, conflict: false };
    });
    if (accepted.conflict)
      return response(409, { error: "event_id_content_conflict" });
    // The durable outbox survives a missed dispatch wake; reconciliation can retry it.
    await lambda
      .send(
        new InvokeCommand({
          FunctionName: process.env.RELAY_FUNCTION,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ tenantId: source.tenant_id })),
        }),
      )
      .catch(() =>
        console.error(
          JSON.stringify({ code: "relay_wake_failed", inboxId: accepted.id }),
        ),
      );
    return response(accepted.duplicate ? 200 : 202, {
      inboxId: accepted.id,
      duplicate: accepted.duplicate,
      disposition: "triage",
    });
  } catch (error) {
    if (error instanceof CoordinationError)
      return response(error.status, { error: error.code });
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return response(422, { error: "invalid_command" });
    console.error(
      JSON.stringify({
        code: "intake_unavailable",
        requestId: event.requestContext.requestId,
      }),
    );
    return response(503, { error: "temporarily_unavailable" });
  }
}
