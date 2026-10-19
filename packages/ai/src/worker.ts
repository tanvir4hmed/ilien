import { randomUUID } from "node:crypto";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import { getCase, type Source } from "../../coordination/src/service.js";
import { CoordinationError } from "../../coordination/src/types.js";
import { buildContext, gate, retrieve } from "./store.js";
import {
  MODEL_ID,
  PROMPT_VERSION,
  hash,
  decode,
  type Run,
  type Context,
} from "./contracts.js";
import { plan } from "./planner.js";
import { caseHeld } from "../../operations/src/supervision.js";
import { pausedFor } from "../../operations/src/controls.js";
export async function processRun(tenant: string, id: string) {
  const lease = randomUUID();
  const claimed = await transaction(tenant, async (tx) => {
    const initial = rows<Run>(
      await query(
        "SELECT * FROM ai_runs WHERE id=CAST(:id AS uuid)",
        [param("id", id)],
        tx,
      ),
    )[0];
    if (!initial) return null;
    const source: Source = {
      tenant_id: tenant,
      id: initial.connection_id,
      origin: "simulated",
    };
    await getCase(source, initial.case_id, tx, true);
    if (
      (await pausedFor(source, "agent", tx)) ||
      (await caseHeld(initial.case_id, tx))
    )
      return null;
    const run = rows<Run>(
      await query(
        "SELECT * FROM ai_runs WHERE id=CAST(:id AS uuid) FOR UPDATE",
        [param("id", id)],
        tx,
      ),
    )[0]!;
    if (run.state === "running") {
      if (Date.now() - Date.parse(run.started_at!) < 150000)
        throw new Error("ai_run_busy");
      await query(
        "UPDATE ai_runs SET state='uncertain',reason='worker_interrupted_no_automatic_inference_retry',updated_at=now() WHERE id=CAST(:id AS uuid)",
        [param("id", id)],
        tx,
      );
      return null;
    }
    if (run.state !== "pending") return null;
    let context: Context;
    try {
      if (run.model_id !== MODEL_ID || run.prompt_version !== PROMPT_VERSION)
        throw new CoordinationError("ai_release_changed");
      context = await buildContext(source, run, tx);
    } catch (e) {
      if (!(e instanceof CoordinationError)) throw e;
      await query(
        "UPDATE ai_runs SET state='needs_review',reason=:reason,updated_at=now() WHERE id=CAST(:id AS uuid)",
        [param("id", id), param("reason", e.code)],
        tx,
      );
      return null;
    }
    await query(
      "UPDATE ai_runs SET state='running',lease_token=CAST(:lease AS uuid),started_at=now(),context=CAST(:context AS jsonb),context_hash=:hash,updated_at=now() WHERE id=CAST(:id AS uuid)",
      [
        param("id", id),
        param("lease", lease),
        param("context", JSON.stringify(context)),
        param("hash", hash(JSON.stringify(context))),
      ],
      tx,
    );
    return { source, run, context };
  });
  if (!claimed) return;
  const { source, run, context } = claimed;
  const current = () =>
    transaction(tenant, async (tx) => {
      if (await pausedFor(source, "agent", tx))
        throw new CoordinationError("agent_processing_paused");
      const fresh = await buildContext(source, run, tx);
      if (fresh.policyHash !== context.policyHash)
        throw new CoordinationError("ai_policy_changed");
    });
  try {
    const result = await plan(context, run.model_id, {
      stillCurrent: current,
      retrieve: (search) =>
        transaction(tenant, (tx) =>
          retrieve(source, context.policy.groups, search, tx),
        ),
      record: (step, observation) =>
        transaction(tenant, async (tx) => {
          await query(
            "INSERT INTO ai_steps(tenant_id,run_id,step,observation) VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:step AS int),CAST(:observation AS jsonb))",
            [
              param("tenant", tenant),
              param("id", id),
              param("step", String(step)),
              param("observation", JSON.stringify(observation)),
            ],
            tx,
          );
          const usage = (
            observation as {
              usage?: { inputTokens?: number; outputTokens?: number };
            }
          ).usage;
          await query(
            "UPDATE ai_runs SET input_tokens=input_tokens+CAST(:input AS int),output_tokens=output_tokens+CAST(:output AS int),updated_at=now() WHERE id=CAST(:id AS uuid) AND lease_token=CAST(:lease AS uuid)",
            [
              param("input", String(usage?.inputTokens ?? 0)),
              param("output", String(usage?.outputTokens ?? 0)),
              param("id", id),
              param("lease", lease),
            ],
            tx,
          );
        }),
    });
    await transaction(tenant, async (tx) => {
      if (await pausedFor(source, "agent", tx))
        throw new CoordinationError("agent_processing_paused");
      const fresh = await buildContext(source, run, tx);
      if (fresh.policyHash !== context.policyHash)
        throw new CoordinationError("ai_policy_changed");
      gate(context, result.proposal);
      const raw = JSON.stringify(result.proposal);
      const status =
        result.proposal.disposition === "propose"
          ? "proposed"
          : result.proposal.disposition === "wait"
            ? "waiting"
            : "needs_review";
      await query(
        "UPDATE ai_runs SET state=:state,reason=:reason,proposal=CAST(:proposal AS jsonb),proposal_hash=:hash,context=CAST(:context AS jsonb),context_hash=:contextHash,input_tokens=CAST(:input AS int),output_tokens=CAST(:output AS int),updated_at=now() WHERE id=CAST(:id AS uuid) AND state='running' AND lease_token=CAST(:lease AS uuid)",
        [
          param("state", status),
          param(
            "reason",
            result.proposal.disposition === "propose"
              ? "operator_semantic_review_required"
              : result.proposal.disposition,
          ),
          param("proposal", raw),
          param("hash", hash(raw)),
          param("context", JSON.stringify(context)),
          param("contextHash", hash(JSON.stringify(context))),
          param("input", String(result.inputTokens)),
          param("output", String(result.outputTokens)),
          param("id", id),
          param("lease", lease),
        ],
        tx,
      );
    });
  } catch (error) {
    const reason =
      error instanceof CoordinationError
        ? error.code
        : error instanceof Error && /^ai_[a-z_]+$/.test(error.message)
          ? error.message
          : "model_or_validation_unavailable";
    // An unknown provider outcome consumes the reserved allowance; never blindly re-run inference.
    await transaction(tenant, (tx) =>
      query(
        "UPDATE ai_runs SET state='needs_review',reason=:reason,context=CAST(:context AS jsonb),context_hash=:hash,updated_at=now() WHERE id=CAST(:id AS uuid) AND state='running' AND lease_token=CAST(:lease AS uuid)",
        [
          param("id", id),
          param("lease", lease),
          param("reason", reason),
          param("context", JSON.stringify(context)),
          param("hash", hash(JSON.stringify(context))),
        ],
        tx,
      ),
    );
  }
}
