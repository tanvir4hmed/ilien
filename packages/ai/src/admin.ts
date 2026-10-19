import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import { policyFor, type Source } from "../../coordination/src/service.js";
import { CoordinationError } from "../../coordination/src/types.js";
import { settings } from "./store.js";
import { hash } from "./contracts.js";
const key = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const publish = z.strictObject({
  action: z.literal("publish"),
  documentKey: key,
  version: z.number().int().positive(),
  group: key,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(8000),
  effectiveAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
const mutation = z.discriminatedUnion("action", [
  publish,
  z.strictObject({
    action: z.literal("revoke"),
    id: z.uuid(),
    reason: z.string().min(1).max(500),
  }),
]);
export async function adminView(source: Source, section: string) {
  return transaction(source.tenant_id, async (tx) =>
    section === "settings"
      ? await settings(source, tx)
      : rows(
          await query(
            "SELECT id,document_key,version,group_id,title,sha256,approved_by,effective_at,expires_at,revoked,created_at FROM ai_knowledge WHERE connection_id=CAST(:source AS uuid) ORDER BY created_at DESC LIMIT 100",
            [param("source", source.id)],
            tx,
          ),
        ),
  );
}
export async function adminWrite(
  source: Source,
  section: string,
  raw: string,
  actor: string,
) {
  return transaction(source.tenant_id, async (tx) => {
    // Source principal is the explicitly trusted operator in this installation; never model input.
    const parameters = [
      param("tenant", source.tenant_id),
      param("source", source.id),
      param("actor", actor),
    ];
    const policy = await policyFor(source, tx);
    if (!policy) throw new CoordinationError("ai_policy_unavailable");
    let result: unknown;
    let change: unknown;
    if (section === "settings") {
      const input = z
        .strictObject({
          enabled: z.boolean(),
          autoReceipts: z.boolean(),
          expectedRevision: z.number().int().positive(),
        })
        .parse(JSON.parse(raw));
      const updated = rows(
        await query(
          "UPDATE ai_settings SET enabled=CAST(:enabled AS boolean),auto_receipts=CAST(:auto AS boolean),revision=revision+1 WHERE connection_id=CAST(:source AS uuid) AND revision=CAST(:revision AS int) RETURNING enabled,auto_receipts,revision",
          [
            ...parameters,
            param("enabled", String(input.enabled)),
            param("auto", String(input.autoReceipts)),
            param("revision", String(input.expectedRevision)),
          ],
          tx,
        ),
      );
      if (!updated.length)
        throw new CoordinationError("ai_settings_revision_conflict");
      result = updated[0];
      change = { type: "settings", ...input };
    } else {
      const input = mutation.parse(JSON.parse(raw));
      if (input.action === "revoke") {
        result = rows(
          await query(
            "UPDATE ai_knowledge SET revoked=true WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid) RETURNING id,revoked",
            [...parameters, param("id", input.id)],
            tx,
          ),
        )[0];
        if (!result) throw new CoordinationError("knowledge_not_found", 404);
        change = input;
      } else {
        if (!policy.groups.includes(input.group))
          throw new CoordinationError("knowledge_group_forbidden", 403);
        if (
          Buffer.byteLength(input.body) > 8000 ||
          Date.parse(input.expiresAt) <= Date.parse(input.effectiveAt) ||
          Date.parse(input.expiresAt) <= Date.now()
        )
          throw new CoordinationError("knowledge_invalid_bounds");
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text",
          [
            param(
              "key",
              `knowledge/${source.tenant_id}/${source.id}/${input.documentKey}`,
            ),
          ],
          tx,
        );
        const max =
          rows<{ version: number | null }>(
            await query(
              "SELECT max(version)::int AS version FROM ai_knowledge WHERE connection_id=CAST(:source AS uuid) AND document_key=:key",
              [...parameters, param("key", input.documentKey)],
              tx,
            ),
          )[0]?.version ?? 0;
        if (input.version <= max)
          throw new CoordinationError("knowledge_version_must_increase");
        const id = randomUUID(),
          digest = hash(input.body);
        await query(
          "INSERT INTO ai_knowledge(tenant_id,connection_id,id,document_key,version,group_id,title,body,sha256,approved_by,effective_at,expires_at) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),:key,CAST(:version AS int),:group,:title,:body,:hash,:actor,CAST(:effective AS timestamptz),CAST(:expires AS timestamptz))",
          [
            ...parameters,
            param("id", id),
            param("key", input.documentKey),
            param("version", String(input.version)),
            param("group", input.group),
            param("title", input.title),
            param("body", input.body),
            param("hash", digest),
            param("effective", input.effectiveAt),
            param("expires", input.expiresAt),
          ],
          tx,
        );
        result = { id, version: input.version, sha256: digest };
        change = { type: "knowledge_published", ...(result as object) };
      }
    }
    await query(
      "INSERT INTO ai_config_audit(tenant_id,id,connection_id,actor,change) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:source AS uuid),:actor,CAST(:change AS jsonb))",
      [
        ...parameters,
        param("id", randomUUID()),
        param("change", JSON.stringify(change)),
      ],
      tx,
    );
    return result;
  });
}
