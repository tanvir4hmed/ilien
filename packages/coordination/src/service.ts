import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import { sourceEventSchema } from "../../contracts/src/validation.js";
import { seedCase } from "../../domain-packs/src/textile.js";
import { initialize, nextWake, resolveActor, transition } from "./engine.js";
import {
  commandSchema,
  acknowledgementSchema,
  CoordinationError,
  type CaseState,
  type Contact,
  type Outcome,
  type Policy,
} from "./types.js";
import { createDelivery } from "../../channels/src/intents.js";
export type Source = { tenant_id: string; id: string; origin: string };
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
function decode<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) : value;
}
const parameters = (tenant: string, id: string) => [
  param("tenant", tenant),
  param("case", id),
];
const policySchema = z.object({
  version: z.string(),
  groups: z.array(z.string()).max(32),
  actors: z
    .array(
      z.object({
        id: z.string(),
        group: z.string(),
        role: z.enum(["respondent", "verifier", "coordinator"]),
        enabled: z.boolean(),
      }),
    )
    .max(128),
  deadlineSeconds: z.number().int().min(60).max(604800),
  reminderSeconds: z.number().int().min(60).max(86400),
  maxReminders: z.number().int().min(0).max(5),
  maxContacts: z.number().int().min(1).max(128),
  maxNodes: z.number().int().min(1).max(32),
  maxDepth: z.number().int().min(1).max(8),
  evidenceAgeSeconds: z.number().int().min(60).max(604800),
});
async function policyFor(source: Source, tx: string): Promise<Policy | null> {
  if (source.origin !== "simulated") return null;
  const p = rows<{ policy: Policy | string; simulation_enabled: boolean }>(
    await query(
      "SELECT p.policy,p.simulation_enabled FROM coordination_policies p JOIN source_connections c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id WHERE p.connection_id=CAST(:source AS uuid) AND c.enabled AND c.origin='simulated'",
      [param("source", source.id)],
      tx,
    ),
  )[0];
  return p?.simulation_enabled ? policySchema.parse(decode(p.policy)) : null;
}
async function getCase(
  source: Source,
  id: string,
  tx: string,
  lock = false,
): Promise<CaseState> {
  const record = rows<{ snapshot: CaseState | string }>(
    await query(
      `SELECT snapshot FROM coordination_cases WHERE id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid)${lock ? " FOR UPDATE" : ""}`,
      [param("case", id), param("source", source.id)],
      tx,
    ),
  )[0];
  if (!record) throw new CoordinationError("case_not_found", 404);
  return decode(record.snapshot);
}
async function storeEvidence(
  tenant: string,
  id: string,
  raw: string,
  tx: string,
) {
  await query(
    "INSERT INTO evidence_items(tenant_id,id,origin,original_text,sha256) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),'simulated',:raw,:hash)",
    [
      param("tenant", tenant),
      param("id", id),
      param("raw", raw),
      param("hash", digest(raw)),
    ],
    tx,
  );
}
async function persist(
  tenant: string,
  state: CaseState,
  policy: Policy,
  contacts: Contact[],
  result: Outcome | undefined,
  commandId: string,
  actorId: string,
  raw: string,
  evidenceId: string | null,
  now: string,
  tx: string,
) {
  if (Buffer.byteLength(JSON.stringify(state)) > 30000)
    throw new CoordinationError("case_size_limit_handoff_required");
  const p = parameters(tenant, state.id);
  await query(
    "UPDATE coordination_cases SET revision=CAST(:revision AS integer),status=:status,snapshot=CAST(:snapshot AS jsonb),updated_at=now() WHERE id=CAST(:case AS uuid)",
    [
      ...p,
      param("revision", String(state.revision)),
      param("status", state.status),
      param("snapshot", JSON.stringify(state)),
    ],
    tx,
  );
  for (const o of state.obligations) {
    await query(
      "INSERT INTO coordination_obligations(tenant_id,case_id,id,revision,status,assignee,required) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),:id,CAST(:revision AS integer),:status,:assignee,CAST(:required AS boolean)) ON CONFLICT(tenant_id,case_id,id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status,assignee=EXCLUDED.assignee",
      [
        ...p,
        param("id", o.id),
        param("revision", String(o.revision)),
        param("status", o.status),
        param("assignee", o.assignee),
        param("required", String(o.required)),
      ],
      tx,
    );
    if (o.reply)
      await query(
        "INSERT INTO coordination_claims(tenant_id,case_id,obligation_id,revision,evidence_id,claim) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),:id,CAST(:revision AS integer),CAST(:evidence AS uuid),CAST(:claim AS jsonb)) ON CONFLICT DO NOTHING",
        [
          ...p,
          param("id", o.id),
          param("revision", String(o.reply.revision)),
          param("evidence", o.reply.evidenceId),
          param("claim", JSON.stringify(o.reply)),
        ],
        tx,
      );
  }
  for (const o of state.obligations)
    for (const dep of o.dependencies)
      await query(
        "INSERT INTO coordination_dependencies VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),:id,:dependency) ON CONFLICT DO NOTHING",
        [...p, param("id", o.id), param("dependency", dep)],
        tx,
      );
  await query(
    "INSERT INTO coordination_journal(tenant_id,case_id,command_id,request_hash,actor_id,case_revision,evidence_id,operation,state_hash) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),CAST(:command AS uuid),:hash,:actor,CAST(:revision AS integer),CAST(NULLIF(:evidence,'') AS uuid),CAST(:operation AS jsonb),:statehash)",
    [
      ...p,
      param("command", commandId),
      param("hash", digest(raw)),
      param("actor", actorId),
      param("revision", String(state.revision)),
      param("evidence", evidenceId ?? ""),
      param("operation", raw),
      param("statehash", digest(JSON.stringify(state))),
    ],
    tx,
  );
  for (const contact of contacts) {
    const contactId = randomUUID();
    await query(
      "INSERT INTO coordination_contacts(tenant_id,case_id,id,case_revision,contact) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),CAST(:id AS uuid),CAST(:revision AS integer),CAST(:contact AS jsonb))",
      [
        ...p,
        param("id", contactId),
        param("revision", String(state.revision)),
        param(
          "contact",
          JSON.stringify({
            ...contact,
            obligationRevision: state.obligations.find(
              (o) => o.id === contact.obligationId,
            )!.revision,
          }),
        ),
      ],
      tx,
    );
    await createDelivery(tenant, state, contactId, contact, tx);
  }
  if (result) {
    const id = randomUUID();
    await query(
      "INSERT INTO coordination_results(tenant_id,case_id,id,case_revision,result) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),CAST(:id AS uuid),CAST(:revision AS integer),CAST(:result AS jsonb))",
      [
        ...p,
        param("id", id),
        param("revision", String(state.revision)),
        param(
          "result",
          JSON.stringify({
            contractVersion: "1.0",
            resultId: id,
            resultRevision: state.revision,
            missionId: state.id,
            missionRevision: 1,
            caseId: state.id,
            caseRevision: state.revision,
            generatedAt: now,
            outcome: result.outcome,
            missionTerminal: result.terminal,
            summary:
              "Communication outcome for simulated source context; individual evidence records identify participant provenance. No operational action was executed.",
            requirements: state.obligations.map((o) => ({
              requirementId: o.id,
              status:
                o.status === "verified"
                  ? "satisfied"
                  : o.status === "disputed"
                    ? "conflicting"
                    : "missing",
              evidence: [o.reply?.evidenceId, o.verification?.evidenceId]
                .filter(Boolean)
                .map((evidenceId) => ({ evidenceId, revision: 1 })),
              reasonCode: o.status,
            })),
            unresolvedObligationIds: result.unresolvedObligationIds,
            decisionRefs: [],
            origin: "simulated",
            scope: "communication_only",
          }),
        ),
      ],
      tx,
    );
  }
  const wake = nextWake(state, policy, now);
  if (wake) await enqueue(tenant, state, wake, tx);
}
async function enqueue(
  tenant: string,
  state: CaseState,
  due: string,
  tx: string,
) {
  await query(
    "INSERT INTO coordination_jobs(tenant_id,case_id,id,expected_revision,due_at) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),CAST(:id AS uuid),CAST(:revision AS integer),CAST(:due AS timestamptz))",
    [
      ...parameters(tenant, state.id),
      param("id", randomUUID()),
      param("revision", String(state.revision)),
      param("due", due),
    ],
    tx,
  );
}
/** Called inside the intake transaction. Original event data never chooses a tenant. */
export async function activateCase(
  tenant: string,
  inboxId: string,
  tx: string,
) {
  const record = rows<{
    connection_id: string;
    evidence_id: string;
    original_text: string;
    origin: string;
  }>(
    await query(
      "SELECT i.connection_id,i.evidence_id,e.original_text,e.origin FROM inbox_events i JOIN evidence_items e ON e.tenant_id=i.tenant_id AND e.id=i.evidence_id WHERE i.id=CAST(:inbox AS uuid)",
      [param("inbox", inboxId)],
      tx,
    ),
  )[0];
  if (!record) return false;
  const source: Source = {
    tenant_id: tenant,
    id: record.connection_id,
    origin: record.origin,
  };
  const policy = await policyFor(source, tx);
  if (!policy) return false;
  const event = sourceEventSchema.parse(JSON.parse(record.original_text)),
    now = new Date().toISOString();
  const state = seedCase(
    event,
    {
      id: randomUUID(),
      inboxId,
      sourceId: source.id,
      sourceEvidenceId: record.evidence_id,
    },
    policy,
    now,
  );
  if (!state) return false;
  const existing = rows(
    await query(
      "SELECT id FROM coordination_cases WHERE inbox_id=CAST(:inbox AS uuid) AND workflow=:workflow",
      [param("inbox", inboxId), param("workflow", state.workflow)],
      tx,
    ),
  );
  if (existing.length) return true;
  await query(
    "INSERT INTO coordination_cases(tenant_id,id,connection_id,inbox_id,workflow,revision,status,snapshot) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),CAST(:source AS uuid),CAST(:inbox AS uuid),:workflow,1,'active',CAST(:state AS jsonb))",
    [
      ...parameters(tenant, state.id),
      param("source", source.id),
      param("inbox", inboxId),
      param("workflow", state.workflow),
      param("state", JSON.stringify(state)),
    ],
    tx,
  );
  const effect = initialize(state, policy, now);
  await persist(
    tenant,
    state,
    policy,
    effect.contacts,
    effect.result,
    randomUUID(),
    "system",
    JSON.stringify({ type: "activate", inboxId }),
    record.evidence_id,
    now,
    tx,
  );
  return true;
}
export async function applyCommand(
  source: Source,
  id: string,
  raw: string,
  tx: string,
  externalEvidenceId?: string,
) {
  const command = commandSchema.parse(JSON.parse(raw));
  const state = await getCase(source, id, tx, true),
    policy = await policyFor(source, tx);
  if (!policy) throw new CoordinationError("simulation_scope_required", 403);
  const actor = resolveActor(policy, command.actorId);
  const previous = rows<{ request_hash: string; case_revision: number }>(
    await query(
      "SELECT request_hash,case_revision FROM coordination_journal WHERE case_id=CAST(:case AS uuid) AND command_id=CAST(:command AS uuid)",
      [param("case", id), param("command", command.commandId)],
      tx,
    ),
  )[0];
  if (previous) {
    if (previous.request_hash !== digest(raw))
      throw new CoordinationError("command_id_content_conflict");
    return {
      caseId: id,
      revision: previous.case_revision,
      currentRevision: state.revision,
      duplicate: true,
    };
  }
  if (state.revision !== command.expectedRevision)
    throw new CoordinationError("stale_case_revision");
  const evidenceId = externalEvidenceId ?? randomUUID(),
    now = new Date().toISOString();
  const effect = transition(
    state,
    policy,
    actor,
    command.operation,
    evidenceId,
    now,
  );
  if (!externalEvidenceId)
    await storeEvidence(source.tenant_id, evidenceId, raw, tx);
  await persist(
    source.tenant_id,
    effect.state,
    policy,
    effect.contacts,
    effect.result,
    command.commandId,
    actor.id,
    raw,
    evidenceId,
    now,
    tx,
  );
  return {
    caseId: id,
    revision: effect.state.revision,
    status: effect.state.status,
    duplicate: false,
  };
}
export async function executeCommand(source: Source, id: string, raw: string) {
  try {
    return await transaction(source.tenant_id, (tx) =>
      applyCommand(source, id, raw, tx),
    );
  } catch (error) {
    if (
      error instanceof CoordinationError &&
      error.status !== 404 &&
      source.origin === "simulated"
    ) {
      await transaction(source.tenant_id, async (tx) => {
        await getCase(source, id, tx, true);
        const prior = rows(
          await query(
            "SELECT id FROM coordination_rejections WHERE case_id=CAST(:case AS uuid) AND request_hash=:hash AND reason_code=:reason",
            [
              param("case", id),
              param("hash", digest(raw)),
              param("reason", error.code),
            ],
            tx,
          ),
        );
        if (prior.length) return;
        const evidenceId = randomUUID();
        await storeEvidence(source.tenant_id, evidenceId, raw, tx);
        await query(
          "INSERT INTO coordination_rejections(tenant_id,case_id,id,evidence_id,request_hash,reason_code) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),CAST(:id AS uuid),CAST(:evidence AS uuid),:hash,:reason)",
          [
            ...parameters(source.tenant_id, id),
            param("id", randomUUID()),
            param("evidence", evidenceId),
            param("hash", digest(raw)),
            param("reason", error.code),
          ],
          tx,
        );
      });
    }
    throw error;
  }
}
export async function listCases(source: Source) {
  return transaction(source.tenant_id, async (tx) =>
    rows(
      await query(
        "SELECT id,inbox_id,workflow,revision,status,updated_at FROM coordination_cases WHERE connection_id=CAST(:source AS uuid) ORDER BY updated_at DESC LIMIT 50",
        [param("source", source.id)],
        tx,
      ),
    ),
  );
}
export async function caseView(source: Source, id: string, section: string) {
  return transaction(source.tenant_id, async (tx) => {
    const state = await getCase(source, id, tx);
    if (section === "state") return state;
    if (section === "policy") {
      const policy = await policyFor(source, tx);
      return policy
        ? { ...policy, mode: "authenticated_simulator_role_play" }
        : null;
    }
    const table = (
      {
        journal: "coordination_journal",
        contacts: "coordination_contacts",
        claims: "coordination_claims",
        results: "coordination_results",
        rejections: "coordination_rejections",
      } as Record<string, string>
    )[section];
    if (!table) throw new CoordinationError("not_found", 404);
    // Keyset pagination can be added before expanding the bounded case history.
    if (section === "results")
      return rows(
        await query(
          "SELECT r.id,r.case_revision,r.result,r.created_at,a.disposition AS acknowledgement,a.reason AS acknowledgement_reason,(r.case_revision=CAST(:revision AS integer)) AS current FROM coordination_results r LEFT JOIN coordination_result_acks a ON a.tenant_id=r.tenant_id AND a.result_id=r.id WHERE r.case_id=CAST(:case AS uuid) ORDER BY r.created_at DESC LIMIT 50",
          [param("case", id), param("revision", String(state.revision))],
          tx,
        ),
      );
    const columns =
      section === "journal"
        ? "command_id,actor_id,case_revision,evidence_id,state_hash,created_at"
        : "*";
    return rows(
      await query(
        `SELECT ${columns} FROM ${table} WHERE case_id=CAST(:case AS uuid) ORDER BY created_at DESC LIMIT 50`,
        [param("case", id)],
        tx,
      ),
    );
  });
}
export async function acknowledge(source: Source, id: string, raw: string) {
  const input = acknowledgementSchema.parse(JSON.parse(raw));
  return transaction(source.tenant_id, async (tx) => {
    const state = await getCase(source, id, tx, true);
    const prior = rows<{ id: string; request_hash: string }>(
      await query(
        "SELECT id,request_hash FROM coordination_result_acks WHERE id=CAST(:id AS uuid) OR result_id=CAST(:result AS uuid)",
        [param("id", input.acknowledgementId), param("result", input.resultId)],
        tx,
      ),
    )[0];
    if (prior) {
      if (
        prior.request_hash !== digest(raw) ||
        prior.id !== input.acknowledgementId
      )
        throw new CoordinationError("acknowledgement_conflict");
      return { acknowledgementId: prior.id, duplicate: true };
    }
    const result = rows<{ case_revision: number }>(
      await query(
        "SELECT case_revision FROM coordination_results WHERE id=CAST(:result AS uuid) AND case_id=CAST(:case AS uuid)",
        [param("result", input.resultId), param("case", id)],
        tx,
      ),
    )[0];
    if (!result) throw new CoordinationError("result_not_found", 404);
    if (result.case_revision !== state.revision)
      throw new CoordinationError("superseded_result");
    await query(
      "INSERT INTO coordination_result_acks(tenant_id,result_id,id,request_hash,disposition,reason) VALUES(CAST(:tenant AS uuid),CAST(:result AS uuid),CAST(:id AS uuid),:hash,:disposition,:reason)",
      [
        param("tenant", source.tenant_id),
        param("result", input.resultId),
        param("id", input.acknowledgementId),
        param("hash", digest(raw)),
        param("disposition", input.disposition),
        param("reason", input.reason),
      ],
      tx,
    );
    return { acknowledgementId: input.acknowledgementId, duplicate: false };
  });
}
export async function processTimer(tenant: string, jobId: string) {
  return transaction(tenant, async (tx) => {
    // Lock the case before the job, matching command serialization order.
    const job = rows<{
      case_id: string;
      expected_revision: number;
      due_at: string;
      state: string;
    }>(
      await query(
        "SELECT case_id,expected_revision,due_at,state FROM coordination_jobs WHERE id=CAST(:id AS uuid)",
        [param("id", jobId)],
        tx,
      ),
    )[0];
    if (!job) throw new CoordinationError("timer_not_found", 404);
    const row = rows<{ snapshot: CaseState | string }>(
      await query(
        "SELECT snapshot FROM coordination_cases WHERE id=CAST(:case AS uuid) FOR UPDATE",
        [param("case", job.case_id)],
        tx,
      ),
    )[0];
    if (!row) throw new CoordinationError("case_not_found", 404);
    const locked = rows<{ state: string }>(
      await query(
        "SELECT state FROM coordination_jobs WHERE id=CAST(:id AS uuid) FOR UPDATE",
        [param("id", jobId)],
        tx,
      ),
    )[0];
    if (locked?.state === "processed") return;
    const state = decode(row.snapshot),
      now = new Date().toISOString();
    if (state.revision === job.expected_revision) {
      const source: Source = {
        tenant_id: tenant,
        id: state.sourceId,
        origin: "simulated",
      };
      const policy = await policyFor(source, tx);
      if (!policy) throw new CoordinationError("policy_unavailable");
      if (Date.parse(job.due_at) > Date.parse(now)) {
        await enqueue(tenant, state, new Date(job.due_at).toISOString(), tx);
      } else {
        const effect = transition(
          state,
          policy,
          null,
          { type: "tick" },
          jobId,
          now,
        );
        if (effect.state.revision !== state.revision)
          await persist(
            tenant,
            effect.state,
            policy,
            effect.contacts,
            effect.result,
            jobId,
            "system",
            JSON.stringify({ type: "tick", jobId }),
            null,
            now,
            tx,
          );
      }
    }
    await query(
      "UPDATE coordination_jobs SET state='processed',lease_until=NULL WHERE id=CAST(:id AS uuid)",
      [param("id", jobId)],
      tx,
    );
  });
}

export async function readEvidence(
  source: Source,
  id: string,
  evidenceId: string,
) {
  return transaction(source.tenant_id, async (tx) => {
    const state = await getCase(source, id, tx);
    const result = rows(
      await query(
        "SELECT id,origin,original_text,sha256,received_at FROM evidence_items WHERE id=CAST(:evidence AS uuid) AND (id=CAST(:original AS uuid) OR EXISTS(SELECT 1 FROM coordination_journal j WHERE j.case_id=CAST(:case AS uuid) AND j.evidence_id=evidence_items.id) OR EXISTS(SELECT 1 FROM coordination_rejections r WHERE r.case_id=CAST(:case AS uuid) AND r.evidence_id=evidence_items.id) OR EXISTS(SELECT 1 FROM channel_receipts cr WHERE cr.case_id=CAST(:case AS uuid) AND cr.evidence_id=evidence_items.id))",
        [
          param("evidence", evidenceId),
          param("original", state.sourceEvidenceId),
          param("case", id),
        ],
        tx,
      ),
    )[0];
    if (!result) throw new CoordinationError("evidence_not_found", 404);
    return result;
  });
}
