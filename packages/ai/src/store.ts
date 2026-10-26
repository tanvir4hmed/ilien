import {needsCasePlanning} from "./scheduling.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import {
  getCase,
  policyFor,
  applyCommand,
  type Source,
} from "../../coordination/src/service.js";
import { resolveActor, transition } from "../../coordination/src/engine.js";
import { CoordinationError } from "../../coordination/src/types.js";
import {
  contactCurrent,
  type Delivery,
  type Binding,
} from "../../channels/src/intents.js";
import {
  MODEL_ID,
  PROMPT_VERSION,
  RUN_LIMITS,
  hash,
  groundedQuote,
  decode,
  proposalSchema,
  serializeProposal,
  type Context,
  type Evidence,
  type Knowledge,
  type Proposal,
  type Run,
} from "./contracts.js";
import { pausedFor } from "../../operations/src/controls.js";
import { authoredReplyText } from "../../channels/src/text.js";
import { autonomousGate } from "./autonomy.js";
import { caseHeld } from "../../operations/src/supervision.js";
import type { Operation } from "../../coordination/src/types.js";
import { configurationFor } from "../../product/src/configuration.js";
function fail(s: string): never {
  throw new CoordinationError(s);
}
const args = (source: Source) => [
  param("tenant", source.tenant_id),
  param("source", source.id),
];
export async function settings(source: Source, tx: string) {
  return rows<{ enabled: boolean; auto_receipts: boolean; revision: number; execution_mode: "autonomous" | "review" }>(
    await query(
      "SELECT * FROM ai_settings WHERE connection_id=CAST(:source AS uuid) FOR SHARE",
      [param("source", source.id)],
      tx,
    ),
  )[0];
}
export async function enqueueAgent(
  source: Source,
  caseId: string,
  receiptId: string | null,
  requestKey: string,
  tx: string,
  automatic = false,
) {
  const state = await getCase(source, caseId, tx, true);
  if (await pausedFor(source, "agent", tx)) return { state: "paused" };
  const config = await settings(source, tx);
  if (!config?.enabled || (automatic && !config.auto_receipts))
    return { state: "disabled" };
  if (
    (state.status !== "active" && !(state.autonomous && state.status === "blocked")) ||
    state.takeoverBy ||
    Date.parse(state.deadline) <= Date.now()
  )
    return { state: "ineligible" };
  // Tenant lock serializes admission across cases: rejected, failed and uncertain runs count too.
  await query(
    "SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text",
    [param("key", `ai-budget/${source.tenant_id}`)],
    tx,
  );
  const previous = rows<{
    id: string;
    case_id: string;
    receipt_id: string | null;
    state: string;
  }>(
    await query(
      "SELECT id,case_id,receipt_id,state FROM ai_runs WHERE connection_id=CAST(:source AS uuid) AND request_key=:key",
      [...args(source), param("key", requestKey)],
      tx,
    ),
  )[0];
  if (previous) {
    if (previous.case_id !== caseId || previous.receipt_id !== receiptId)
      fail("ai_request_id_conflict");
    return { runId: previous.id, state: previous.state, duplicate: true };
  }
  if (receiptId) {
    const receipt = rows(
      await query(
        "SELECT id FROM channel_receipts WHERE id=CAST(:receipt AS uuid) AND case_id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid) AND status='needs_review' AND reason='unstructured_reply'",
        [...args(source), param("case", caseId), param("receipt", receiptId)],
        tx,
      ),
    );
    if (!receipt.length) fail("ai_receipt_not_eligible");
  }
  const count = rows<{
    daily: number;
    case_daily: number;
    case_total: number;
    same_input: number;
  }>(
    await query(
      "SELECT count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int AS daily,count(*) FILTER(WHERE case_id=CAST(:case AS uuid) AND created_at>now()-interval '24 hours')::int AS case_daily,count(*) FILTER(WHERE case_id=CAST(:case AS uuid))::int AS case_total,count(*) FILTER(WHERE case_id=CAST(:case AS uuid) AND expected_revision=CAST(:rev AS int) AND receipt_id IS NOT DISTINCT FROM CAST(NULLIF(:receipt,'') AS uuid))::int AS same_input FROM ai_runs",
      [
        param("case", caseId),
        param("rev", String(state.revision)),
        param("receipt", receiptId ?? ""),
      ],
      tx,
    ),
  )[0]!;
  // A material case has four branches plus independent verification/children.
  // Admission must allow that complete bounded workflow, not stop at branch 3.
  if (count.daily >= RUN_LIMITS.tenantDaily || count.case_daily >= RUN_LIMITS.caseDaily || count.case_total >= RUN_LIMITS.caseLifetime)
    return { state: "budget_exhausted" };
  if (count.same_input >= RUN_LIMITS.sameInput) return { state: "no_progress_limit" };
  const id = randomUUID();
  await query(
    "INSERT INTO ai_runs(tenant_id,connection_id,case_id,id,receipt_id,expected_revision,request_key,model_id,prompt_version,settings_revision) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:case AS uuid),CAST(:id AS uuid),CAST(NULLIF(:receipt,'') AS uuid),CAST(:revision AS int),:key,:model,:prompt,CAST(:settings AS int))",
    [
      ...args(source),
      param("case", caseId),
      param("id", id),
      param("receipt", receiptId ?? ""),
      param("revision", String(state.revision)),
      param("key", requestKey),
      param("model", MODEL_ID),
      param("prompt", PROMPT_VERSION),
      param("settings", String(config.revision)),
    ],
    tx,
  );
  return { runId: id, state: "pending" };
}
export async function buildContext(
  source: Source,
  run: Run,
  tx: string,
): Promise<Context> {
  const state = await getCase(source, run.case_id, tx, true),
    policy = await policyFor(source, tx),
    cfg = await settings(source, tx);
  if (!cfg?.enabled || cfg.revision !== run.settings_revision)
    fail("ai_configuration_changed");
  if (!policy || state.configurationVersion !== policy.version)
    fail("ai_policy_changed");
  if (
    state.revision !== run.expected_revision ||
    (state.status !== "active" && !(state.autonomous && state.status === "blocked")) ||
    state.takeoverBy ||
    Date.parse(state.deadline) <= Date.now()
  )
    fail("ai_stale_context");
  const actor = policy.actors.find(
    (a) => a.enabled && a.role === "coordinator",
  );
  if (!actor) fail("ai_coordinator_unavailable");
  const context: Context = {
    executionMode: cfg.execution_mode,
    state,
    policy,
    policyHash: hash(JSON.stringify(policy)),
    actorId: actor.id,
    evidence: [],
    knowledge: [],
    participantProfiles: ((await configurationFor(source.id,tx)).configuration.messageProfiles ?? []).map(({group,channel,language,style,format,factKeys})=>({group,channel,language,style,format,factKeys})),
  };
  const ids = new Set([
    state.sourceEvidenceId,
    ...(state.sourceQuestions ?? []).flatMap(q=>q.evidenceId ? [q.evidenceId] : []),
    ...state.obligations.flatMap((o) =>
      [o.reply?.evidenceId, o.verification?.evidenceId,...(o.reply?.facts ?? []).map(f=>f.evidenceId),...(o.retainedFacts ?? []).map(f=>f.evidenceId)].filter(
        (v): v is string => !!v,
      ),
    ),
  ]);
  // Original evidence is fetched by explicit case-linked IDs, never model-authored SQL.
  for (const id of ids) {
    const e = rows<{
      id: string;
      original_text: string;
      sha256: string;
      origin: string;
      channel_text: string | null;
    }>(
      await query(
        "SELECT e.id,e.original_text,e.sha256,e.origin,(SELECT normalized->>'text' FROM channel_receipts WHERE evidence_id=e.id AND case_id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid) LIMIT 1) AS channel_text FROM evidence_items e WHERE e.id=CAST(:id AS uuid)",
        [param("id", id), param("case", state.id), param("source", source.id)],
        tx,
      ),
    )[0];
    if (e)
      context.evidence.push({
        id: e.id,
        text:
          e.channel_text !== null
            ? authoredReplyText(e.channel_text)
            : e.original_text,
        sha256:
          e.channel_text !== null
            ? hash(authoredReplyText(e.channel_text))
            : e.sha256,
        ...(e.channel_text !== null
          ? {
              representation: "authored_channel_text" as const,
              originalSha256: e.sha256,
            }
          : {}),
        origin: e.origin,
      });
  }
  if (run.receipt_id) {
    const r = rows<{
      id: string;
      evidence_id: string;
      binding_id: string;
      delivery_id: string;
      normalized: { text: string } | string;
      created_at: string;
    }>(
      await query(
        "SELECT id,evidence_id,binding_id,delivery_id,normalized,created_at FROM channel_receipts WHERE id=CAST(:id AS uuid) AND case_id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid) AND status='needs_review' AND reason='unstructured_reply'",
        [
          ...args(source),
          param("id", run.receipt_id),
          param("case", run.case_id),
        ],
        tx,
      ),
    )[0];
    if (!r) fail("ai_receipt_changed");
    const b = rows<Binding>(
      await query(
        "SELECT * FROM channel_bindings WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid) FOR UPDATE",
        [...args(source), param("id", r.binding_id)],
        tx,
      ),
    )[0];
    const d = rows<Delivery>(
      await query(
        "SELECT * FROM channel_deliveries WHERE id=CAST(:id AS uuid) AND case_id=CAST(:case AS uuid)",
        [param("id", r.delivery_id), param("case", state.id)],
        tx,
      ),
    )[0];
    if (!b?.enabled || !d || b.actor_id !== d.actor_id)
      fail("ai_receipt_identity_changed");
    d.request = decode(d.request);
    if (
      !contactCurrent(state, d) ||
      !["accepted", "uncertain", "sending"].includes(d.status)
    )
      fail("ai_contact_changed");
    context.actorId = b.actor_id;
    const stamp=r.created_at.replace(" ","T");
    const receivedAt=new Date(/[Zz]|[+-]\d\d(?::?\d\d)?$/.test(stamp)?stamp:stamp+"Z").toISOString();
    context.receipt = {
      receivedAt,
      expiresAt:new Date(Date.parse(receivedAt)+policy.evidenceAgeSeconds*1000).toISOString(),
      id: r.id,
      evidenceId: r.evidence_id,
      deliveryId: d.id,
      bindingId: b.id,
      actorId: b.actor_id,
      obligationId: d.obligation_id,
      obligationRevision: d.obligation_revision,
      kind: d.request.contact.kind,
      replyRevision: d.request.contact.replyRevision,
      text: authoredReplyText(decode(r.normalized).text),
    };
    const e = rows<{
      id: string;
      original_text: string;
      sha256: string;
      origin: string;
    }>(
      await query(
        "SELECT id,original_text,sha256,origin FROM evidence_items WHERE id=CAST(:id AS uuid)",
        [param("id", r.evidence_id)],
        tx,
      ),
    )[0]!;
    context.evidence.push({
      id: e.id,
      text: context.receipt.text,
      sha256: hash(context.receipt.text),
      representation: "authored_channel_text",
      originalSha256: e.sha256,
      origin: e.origin,
    });
  }
  // Do not silently truncate originals or remove negation. Oversized contexts require review.
  if (Buffer.byteLength(JSON.stringify(context)) > 24000)
    fail("ai_context_limit_requires_review");
  return context;
}
export async function retrieve(
  source: Source,
  groups: string[],
  search: string,
  tx: string,
): Promise<Knowledge[]> {
  return rows<Knowledge>(
    await query(
      "SELECT k.id,k.document_key,k.version,k.group_id,k.title,k.body,k.sha256,k.effective_at,k.expires_at FROM ai_knowledge k WHERE k.connection_id=CAST(:source AS uuid) AND k.group_id IN (SELECT jsonb_array_elements_text(CAST(:groups AS jsonb))) AND NOT k.revoked AND k.effective_at<=now() AND k.expires_at>now() AND NOT EXISTS(SELECT 1 FROM ai_knowledge newer WHERE newer.connection_id=k.connection_id AND newer.document_key=k.document_key AND newer.version>k.version AND newer.effective_at<=now()) AND to_tsvector('simple',k.title || ' ' || k.body) @@ websearch_to_tsquery('simple',:search) ORDER BY ts_rank(to_tsvector('simple',k.title || ' ' || k.body),websearch_to_tsquery('simple',:search)) DESC,k.id LIMIT 2",
      [
        ...args(source),
        param("groups", JSON.stringify(groups)),
        param("search", search),
      ],
      tx,
    ),
  );
}
export function executionActor(context: Context, op: Operation) {
  if(context.receipt && context.state.autonomous && ["clarify","reroute","source_query"].includes(op.type)) {
    const actor=context.policy.actors.find(a=>a.enabled && a.role==="coordinator");
    if(!actor) fail("ai_coordinator_unavailable");
    return actor.id;
  }
  return context.actorId;
}
export function gate(context: Context, proposal: Proposal) {
  if (proposal.disposition !== "propose") {
    if (proposal.operation) fail("ai_nonproposal_operation");
    return;
  }
  const op = proposal.operation;
  if (!op || !proposal.citations.length) fail("ai_grounding_required");
  const docs = new Map<string, string>([
    ...context.evidence.map((e) => [e.id, e.text] as const),
    ...context.knowledge.map((k) => [k.id, k.body] as const),
  ]);
  if (context.receipt)
    docs.set(context.receipt.evidenceId, context.receipt.text);
  for (const c of proposal.citations)
    if (!docs.has(c.ref) || !groundedQuote(docs.get(c.ref)!, c.quote))
      fail("ai_citation_mismatch");
  if (
    !proposal.citations.some((c) =>
      context.evidence.some((e) => e.id === c.ref),
    )
  )
    fail("ai_original_evidence_required");
  const r = context.receipt;
  if (r) {
    if (!proposal.citations.some((c) => c.ref === r.evidenceId))
      fail("ai_receipt_citation_required");
    if (op.type === "reply" || op.type === "decide") {
      if (
        op.obligationId !== r.obligationId ||
        op.expectedObligationRevision !== r.obligationRevision ||
        op.subjectRevision !== context.state.subject.revision
      )
        fail("ai_reply_scope");
      if(op.timeBasis === "received" && (!context.state.autonomous || op.observedAt !== r.receivedAt || op.validUntil !== r.expiresAt)) fail("ai_reported_time_scope");
      if(op.type==="decide" && context.state.obligations.find(o=>o.id===r.obligationId)?.proposal?.sha256 !== op.proposalHash) fail("ai_decision_scope");
      if(op.type==="decide") {
        if(/\b(if|unless|conditional|subject to|not approved yet|pending approval)\b|শর্তসাপেক্ষ|অনুমোদন বাকি/iu.test(r.text)) fail("ai_conditional_decision_requires_clarification");
        const yes=/\b(approved?|yes|agree|okay|ok)\b|অনুমোদন|সম্মত/iu.test(r.text);
        const caveat=/\b(not|no|reject|decline|maybe|perhaps|if|unless|subject to|could|might|would|but|however)\b|নয়|হয়নি|হয়নি|অসম্মত/iu.test(r.text);
        const no=/\b(no|not approved|reject(?:ed)?|declin(?:e|ed))\b|অসম্মত/iu.test(r.text);
        if((op.choice==="approve" && (!yes || caveat)) || (op.choice==="reject" && !no)) fail("ai_explicit_decision_required");
      }
      if(op.type==="reply") {
        if(context.state.autonomous && /\b(wrong department|do not own|don't own|not our department)\b/iu.test(r.text)) fail("ai_wrong_department_requires_routing");
        for(const fact of op.facts ?? []) {
          if(!groundedQuote(r.text,fact.quote) || !groundedQuote(fact.quote,fact.value) || (fact.unit && !groundedQuote(fact.quote,fact.unit))) fail("ai_fact_not_grounded");
          if(/\b(maybe|possibly|might|unsure|unconfirmed)\b|সম্ভবত|নিশ্চিত নই/iu.test(fact.quote)) fail("ai_uncertain_fact_requires_clarification");
          const negation=/\b(not|no|never|without)\b|নয়|নয়|হয়নি|হয়নি|অনুমতি নেই/iu;
          if(negation.test(fact.quote) && !negation.test(fact.value)) fail("ai_fact_negation_lost");
        }
        if(op.progress && (!op.statusQuote || !groundedQuote(r.text,op.statusQuote))) fail("ai_progress_not_grounded");
        if(op.progress === "ready" && (!/ready|complete|finished|প্রস্তুত|সম্পন্ন|শেষ/iu.test(op.statusQuote!) || /\b(not|will|would|could|expect|expected|tomorrow)\b|pending|in progress|হয়নি|হয়নি|অসম্পূর্ণ|হবে/iu.test(op.statusQuote!))) fail("ai_completion_not_explicit");
      }
    } else if (op.type === "verify") {
      if (
        op.obligationId !== r.obligationId ||
        r.kind !== "verify_request" ||
        op.replyRevision !== r.replyRevision
      )
        fail("ai_verify_scope");
    } else if (op.type === "add_child") {
      if (op.parentId !== r.obligationId) fail("ai_child_scope");
    } else if(context.state.autonomous && (op.type==="clarify" || op.type==="reroute")) {
      if(op.obligationId!==r.obligationId) fail("ai_reply_scope");
      if(op.type==="reroute" && !r.text.toLowerCase().replaceAll("_"," ").includes(op.group.toLowerCase().replaceAll("_"," "))) fail("ai_route_owner_not_identified");
    } else if(context.state.autonomous && op.type==="source_query") {
      // Routed back only to the authenticated original source, not an arbitrary address.
    } else fail("ai_receipt_operation_forbidden");
  } else if (
    !["add_child", "link_dependency", "reopen", "reassign", "report", ...(context.state.autonomous ? ["route_initial","clarify","reroute","attach_proposal","relay_decision","source_query"] : [])].includes(
      op.type,
    )
  )
    fail("ai_operation_forbidden");
  const statement=op.type==="attach_proposal" ? op.statement : op.type==="add_child" ? op.proposalStatement : undefined;
  if(statement) {
    const quoted=proposal.citations.map(c=>c.quote).join(" ");
    const numbers=statement.match(/\b\d+(?:[.:]\d+)*\b/g) ?? [];
    const citedNumbers=new Set(quoted.match(/\b\d+(?:[.:]\d+)*\b/g) ?? []);
    if(numbers.some(number=>!citedNumbers.has(number))) fail("ai_proposal_number_not_grounded");
  }
  // Preview is pure: no channels, SQL, credentials or external effects.
  transition(
    context.state,
    context.policy,
    resolveActor(context.policy, executionActor(context,op)),
    op,
    r?.evidenceId ?? context.state.sourceEvidenceId,
    new Date().toISOString(),
  );
}
export async function listRuns(source: Source, caseId: string) {
  return transaction(source.tenant_id, async (tx) => {
    await getCase(source, caseId, tx);
    return rows(
      await query(
        "SELECT id,receipt_id,expected_revision,state,reason,model_id,prompt_version,proposal,proposal_hash,input_tokens,output_tokens,reserved_tokens,created_at,updated_at FROM ai_runs WHERE case_id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid) ORDER BY created_at DESC LIMIT 50",
        [...args(source), param("case", caseId)],
        tx,
      ),
    );
  });
}
export async function runDetail(source: Source, id: string) {
  return transaction(source.tenant_id, async (tx) => {
    const run = rows<Run>(
      await query(
        "SELECT * FROM ai_runs WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid)",
        [...args(source), param("id", id)],
        tx,
      ),
    )[0];
    if (!run) fail("ai_run_not_found");
    return {
      run,
      execution: rows(await query(
        "SELECT actor_id,proposal_hash,policy_hash,settings_revision,case_revision,operation,created_at FROM ai_executions WHERE run_id=CAST(:id AS uuid)",
        [param("id", id)], tx,
      ))[0] ?? null,
      steps: rows(
        await query(
          "SELECT step,observation,created_at FROM ai_steps WHERE run_id=CAST(:id AS uuid) ORDER BY step",
          [param("id", id)],
          tx,
        ),
      ),
      review:
        rows(
          await query(
            "SELECT reviewer,disposition,proposal_hash,reason,created_at FROM ai_reviews WHERE run_id=CAST(:id AS uuid)",
            [param("id", id)],
            tx,
          ),
        )[0] ?? null,
    };
  });
}

/** Idempotent application transaction; machine execution is never recorded as a human review. */
export async function executeAutonomousRun(source: Source, id: string) {
  return transaction(source.tenant_id, async (tx) => {
    const initial = rows<Run>(await query(
      "SELECT * FROM ai_runs WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid)",
      [...args(source), param("id", id)], tx,
    ))[0];
    if (!initial) fail("ai_run_not_found");
    await getCase(source, initial.case_id, tx, true);
    const run = rows<Run>(await query(
      "SELECT * FROM ai_runs WHERE id=CAST(:id AS uuid) FOR UPDATE", [param("id", id)], tx,
    ))[0]!;
    if (run.state === "executed") return { state: "executed", duplicate: true };
    if (run.state !== "proposed" || !run.proposal || !run.context) return { state: run.state };
    if (await pausedFor(source, "agent", tx)) fail("agent_processing_paused");
    if (await caseHeld(run.case_id, tx)) fail("case_integrity_review_required");
    const fresh = await buildContext(source, run, tx), original = decode(run.context);
    if (fresh.executionMode !== "autonomous" || fresh.policyHash !== original.policyHash)
      fail("ai_autonomous_configuration_changed");
    for (const k of [...original.knowledge].sort((a,b) => a.document_key.localeCompare(b.document_key))) {
      await query("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text", [param("key", `knowledge/${source.tenant_id}/${source.id}/${k.document_key}`)], tx);
      const valid = rows(await query(
        "SELECT id FROM ai_knowledge k WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid) AND sha256=:hash AND NOT revoked AND effective_at<=now() AND expires_at>now() AND NOT EXISTS(SELECT 1 FROM ai_knowledge n WHERE n.connection_id=k.connection_id AND n.document_key=k.document_key AND n.version>k.version AND n.effective_at<=now()) FOR SHARE OF k",
        [...args(source), param("id", k.id), param("hash", k.sha256)], tx,
      ));
      if (!valid.length || !fresh.policy.groups.includes(k.group_id)) fail("ai_knowledge_changed");
    }
    fresh.knowledge = original.knowledge;
    const proposal = proposalSchema.parse(decode(run.proposal));
    if (hash(serializeProposal(proposal)) !== run.proposal_hash) fail("ai_proposal_hash_mismatch");
    const operation = autonomousGate(fresh, proposal);
    const applied = await applyCommand(source, run.case_id, JSON.stringify({
      commandId: run.id, expectedRevision: run.expected_revision, actorId: executionActor(fresh,operation), operation,
    }), tx, fresh.receipt?.evidenceId ?? fresh.state.sourceEvidenceId);
    await query(
      "INSERT INTO ai_executions(tenant_id,run_id,actor_id,proposal_hash,policy_hash,settings_revision,case_revision,operation) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),:actor,:hash,:policy,CAST(:settings AS int),CAST(:revision AS int),CAST(:operation AS jsonb))",
      [...args(source), param("id", id), param("actor", executionActor(fresh,operation)), param("hash", run.proposal_hash!), param("policy", fresh.policyHash), param("settings", String(run.settings_revision)), param("revision", String(applied.revision)), param("operation", JSON.stringify(operation))], tx,
    );
    if (fresh.receipt) await query("UPDATE channel_receipts SET status='applied',reason='autonomous_grounded_interpretation' WHERE id=CAST(:id AS uuid)", [param("id", fresh.receipt.id)], tx);
    await query("UPDATE ai_runs SET state='executed',reason='autonomous_policy_gated_execution',updated_at=now() WHERE id=CAST(:id AS uuid)", [param("id", id)], tx);
    return { state: "executed", revision: applied.revision, duplicate: false };
  });
}

/** One durable run per meaningful revision; idle waiting never polls a model. */
export async function enqueueAutonomousCase(source: Source, caseId: string, tx: string, trigger?:string) {
  const cfg = await settings(source, tx);
  if (!cfg?.enabled || cfg.execution_mode !== "autonomous") return;
  const state = await getCase(source, caseId, tx);
  if(!needsCasePlanning(state,trigger))return;
  await enqueueAgent(source, caseId, null, `autonomous/${caseId}/${state.revision}`, tx);
}

/** A concurrent branch may advance the case before a queued reply is interpreted. */
export async function refreshStaleRun(source: Source, run: Run, tx: string) {
  const cfg = await settings(source, tx);
  if (!cfg?.enabled || cfg.execution_mode !== "autonomous" || cfg.revision !== run.settings_revision) return;
  const state = await getCase(source, run.case_id, tx);
  if (state.status !== "active" || state.revision === run.expected_revision) return;
  if (run.receipt_id && !rows(await query(
    "SELECT id FROM channel_receipts WHERE id=CAST(:id AS uuid) AND case_id=CAST(:case AS uuid) AND connection_id=CAST(:source AS uuid) AND status='needs_review' AND reason='unstructured_reply'",
    [...args(source), param("id", run.receipt_id), param("case", run.case_id)], tx,
  )).length) return;
  await enqueueAgent(source, run.case_id, run.receipt_id, `refresh/${run.id}/${state.revision}`, tx, !!run.receipt_id);
}
const reviewSchema = z.strictObject({
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  disposition: z.enum(["approve", "reject"]),
  reason: z.string().min(1).max(1000),
});
export async function reviewRun(
  source: Source,
  id: string,
  raw: string,
  reviewer: string,
) {
  const input = reviewSchema.parse(JSON.parse(raw));
  return transaction(source.tenant_id, async (tx) => {
    const found = rows<Run>(
      await query(
        "SELECT * FROM ai_runs WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid)",
        [...args(source), param("id", id)],
        tx,
      ),
    )[0];
    if (!found) fail("ai_run_not_found");
    await getCase(source, found.case_id, tx, true);
    const run = rows<Run>(
      await query(
        "SELECT * FROM ai_runs WHERE id=CAST(:id AS uuid) FOR UPDATE",
        [param("id", id)],
        tx,
      ),
    )[0]!;
    if (run.proposal_hash !== input.proposalHash)
      fail("ai_proposal_hash_mismatch");
    const prior = rows<{ disposition: string; reason: string }>(
      await query(
        "SELECT disposition,reason FROM ai_reviews WHERE run_id=CAST(:id AS uuid)",
        [param("id", id)],
        tx,
      ),
    )[0];
    if (prior) {
      if (
        prior.disposition !== input.disposition ||
        prior.reason !== input.reason
      )
        fail("ai_review_conflict");
      return { runId: id, state: run.state, duplicate: true };
    }
    if (!["proposed", "needs_review", "waiting"].includes(run.state))
      fail("ai_not_reviewable");
    if (input.disposition === "approve") {
      const fresh = await buildContext(source, run, tx),
        original = decode(run.context!);
      if (fresh.policyHash !== original.policyHash) fail("ai_policy_changed");
      for (const k of [...original.knowledge].sort((a, b) =>
        a.document_key.localeCompare(b.document_key),
      )) {
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text",
          [
            param(
              "key",
              `knowledge/${source.tenant_id}/${source.id}/${k.document_key}`,
            ),
          ],
          tx,
        );
        const valid = rows(
          await query(
            "SELECT id FROM ai_knowledge k WHERE id=CAST(:id AS uuid) AND connection_id=CAST(:source AS uuid) AND sha256=:hash AND NOT revoked AND effective_at<=now() AND expires_at>now() AND NOT EXISTS(SELECT 1 FROM ai_knowledge n WHERE n.connection_id=k.connection_id AND n.document_key=k.document_key AND n.version>k.version AND n.effective_at<=now()) FOR SHARE OF k",
            [...args(source), param("id", k.id), param("hash", k.sha256)],
            tx,
          ),
        );
        if (!valid.length || !fresh.policy.groups.includes(k.group_id))
          fail("ai_knowledge_changed");
      }
      fresh.knowledge = original.knowledge;
      const proposal = proposalSchema.parse(decode(run.proposal!));
      gate(fresh, proposal);
      if (proposal.disposition !== "propose" || !proposal.operation)
        fail("ai_no_effect_to_approve");
      // Exact proposal, current case, original actor and explicit review; no model credential executes effects.
      await applyCommand(
        source,
        run.case_id,
        JSON.stringify({
          commandId: run.id,
          expectedRevision: run.expected_revision,
          actorId: fresh.actorId,
          operation: proposal.operation,
        }),
        tx,
        fresh.receipt?.evidenceId ?? fresh.state.sourceEvidenceId,
      );
      if (fresh.receipt)
        await query(
          "UPDATE channel_receipts SET status='applied',reason='operator_reviewed_ai_interpretation' WHERE id=CAST(:id AS uuid)",
          [param("id", fresh.receipt.id)],
          tx,
        );
    }
    await query(
      "INSERT INTO ai_reviews(tenant_id,run_id,reviewer,disposition,proposal_hash,reason) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),:reviewer,:disposition,:hash,:reason)",
      [
        ...args(source),
        param("id", id),
        param("reviewer", reviewer),
        param("disposition", input.disposition),
        param("hash", input.proposalHash),
        param("reason", input.reason),
      ],
      tx,
    );
    const state = input.disposition === "approve" ? "approved" : "rejected";
    await query(
      "UPDATE ai_runs SET state=:state,updated_at=now() WHERE id=CAST(:id AS uuid)",
      [param("state", state), param("id", id)],
      tx,
    );
    return { runId: id, state };
  });
}
