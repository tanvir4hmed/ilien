import { query, param, rows } from "../../persistence/src/database.js";
import type { Source } from "../../coordination/src/service.js";
import type { CaseState } from "../../coordination/src/types.js";
import { decode } from "../../channels/src/intents.js";
interface Projection {
  id: string;
  connection_id: string;
  revision: number;
  status: string;
  snapshot: CaseState | string | null;
  source_evidence_exists: boolean;
}
/** Independent structural checks; this does not establish semantic truth or AI accuracy. */
function inspect(row: Projection) {
  const issues: string[] = [];
  if (!row.snapshot)
    return {
      status: "skipped",
      issues: ["snapshot_exceeds_supervision_size_boundary"],
    };
  const state = decode(row.snapshot);
  if (
    state.id !== row.id ||
    state.sourceId !== row.connection_id ||
    state.revision !== row.revision ||
    state.status !== row.status
  )
    issues.push("projection_mismatch");
  if (!row.source_evidence_exists) issues.push("missing_original_evidence");
  if (
    !Array.isArray(state.obligations) ||
    !state.obligations.length ||
    state.obligations.length > 32
  )
    return {
      status: "review",
      issues: [...issues, "invalid_obligation_collection"],
    };
  if (
    !state.subject?.revision ||
    !Number.isInteger(state.revision) ||
    state.revision < 1
  )
    issues.push("invalid_case_identity_or_revision");
  for (const o of state.obligations)
    if (
      typeof o.id !== "string" ||
      !o.id ||
      !["waiting", "answered", "verified", "disputed", "blocked"].includes(
        o.status,
      )
    )
      issues.push("invalid_obligation_identity_or_state");
  const byId = new Map(state.obligations.map((o) => [o.id, o]));
  if (byId.size !== state.obligations.length)
    issues.push("duplicate_obligation_identity");
  for (const o of state.obligations) {
    if (!Array.isArray(o.dependencies)) {
      issues.push("invalid_dependency_collection");
      continue;
    }
    if (o.dependencies.some((id) => !byId.has(id) || id === o.id))
      issues.push("invalid_dependency_reference");
    if (
      o.status === "verified" &&
      (!o.reply ||
        !o.verification ||
        o.verification.actorId === o.reply.actorId ||
        o.verification.replyRevision !== o.reply.revision ||
        o.reply.subjectRevision !== state.subject?.revision ||
        o.dependencies.some((id) => byId.get(id)?.status !== "verified"))
    )
      issues.push("unverified_or_stale_requirement");
  }
  const visited = new Set<string>(),
    path = new Set<string>();
  const visit = (id: string): void => {
    if (path.has(id)) {
      issues.push("dependency_cycle");
      return;
    }
    if (visited.has(id)) return;
    path.add(id);
    for (const child of byId.get(id)?.dependencies ?? [])
      if (byId.has(child)) visit(child);
    path.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  if (
    state.status === "completed" &&
    state.obligations.some((o) => o.required && o.status !== "verified")
  )
    issues.push("false_completion_projection");
  return {
    status: issues.length ? "review" : "ok",
    issues: [...new Set(issues)],
  };
}
export async function superviseCases(source: Source, tx: string) {
  const candidates = rows<Projection>(
    await query(
      "SELECT c.id,c.connection_id,c.revision,c.status,CASE WHEN octet_length(c.snapshot::text)<=100000 THEN c.snapshot ELSE NULL END AS snapshot,EXISTS(SELECT 1 FROM evidence_items e WHERE e.tenant_id=c.tenant_id AND e.id::text=c.snapshot->>'sourceEvidenceId') AS source_evidence_exists FROM coordination_cases c LEFT JOIN case_health_checks h ON h.tenant_id=c.tenant_id AND h.case_id=c.id WHERE c.connection_id=CAST(:source AS uuid) ORDER BY coalesce(h.checked_at,'epoch'::timestamptz),c.updated_at LIMIT 5 FOR UPDATE OF c SKIP LOCKED",
      [param("source", source.id)],
      tx,
    ),
  );
  for (const row of candidates) {
    let result;
    try {
      result = inspect(row);
    } catch {
      result = { status: "review", issues: ["malformed_case_snapshot"] };
    }
    await query(
      "INSERT INTO case_health_checks(tenant_id,connection_id,case_id,checked_revision,status,issues) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:case AS uuid),CAST(:revision AS int),:status,CAST(:issues AS jsonb)) ON CONFLICT(tenant_id,case_id) DO UPDATE SET checked_revision=EXCLUDED.checked_revision,status=EXCLUDED.status,issues=EXCLUDED.issues,checked_at=now()",
      [
        param("tenant", source.tenant_id),
        param("source", source.id),
        param("case", row.id),
        param("revision", String(row.revision)),
        param("status", result.status),
        param("issues", JSON.stringify(result.issues)),
      ],
      tx,
    );
  }
  const count = rows<{ review: number; skipped: number }>(
    await query(
      "SELECT count(*) FILTER(WHERE status='review')::int AS review,count(*) FILTER(WHERE status='skipped')::int AS skipped FROM case_health_checks WHERE connection_id=CAST(:source AS uuid)",
      [param("source", source.id)],
      tx,
    ),
  )[0]!;
  return { checked: candidates.length, ...count };
}
export async function caseHeld(caseId: string, tx: string) {
  return (
    rows(
      await query(
        "SELECT 1 FROM case_health_checks WHERE case_id=CAST(:case AS uuid) AND status='review'",
        [param("case", caseId)],
        tx,
      ),
    ).length > 0
  );
}
