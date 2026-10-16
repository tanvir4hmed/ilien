import {
  CoordinationError,
  type Actor,
  type CaseState,
  type Contact,
  type Obligation,
  type Operation,
  type Outcome,
  type Policy,
} from "./types.js";
const fail = (code: string, status = 409): never => {
  throw new CoordinationError(code, status);
};
const at = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString();
export function resolveActor(policy: Policy, id: string): Actor {
  return (
    policy.actors.find((a) => a.id === id && a.enabled) ??
    fail("actor_not_authorized", 403)
  );
}
function node(state: CaseState, id: string): Obligation {
  return (
    state.obligations.find((o) => o.id === id) ??
    fail("obligation_not_found", 404)
  );
}
function coordinator(actor: Actor) {
  if (actor.role !== "coordinator") fail("coordinator_required", 403);
}
function canRespond(actor: Actor, obligation: Obligation) {
  if (
    actor.id !== obligation.assignee ||
    actor.group !== obligation.group ||
    actor.role !== "respondent"
  )
    fail("responsible_actor_required", 403);
}
function invalidate(
  state: CaseState,
  id: string,
  now: string,
  seen = new Set<string>(),
) {
  if (seen.has(id)) return;
  seen.add(id);
  const o = node(state, id);
  o.status = "waiting";
  delete o.reply;
  delete o.verification;
  delete o.verificationRequested;
  o.revision++;
  o.nextContactAt = now;
  o.reminders = 0;
  o.escalated = false;
  for (const parent of state.obligations.filter((p) =>
    p.dependencies.includes(id),
  ))
    invalidate(state, parent.id, now, seen);
}
function invalidateParents(state: CaseState, id: string, now: string) {
  const seen = new Set<string>();
  for (const parent of state.obligations.filter((p) =>
    p.dependencies.includes(id),
  ))
    invalidate(state, parent.id, now, seen);
}
function graphGuard(state: CaseState, policy: Policy) {
  if (state.obligations.length > policy.maxNodes)
    fail("dependency_fanout_limit");
  function depth(id: string, path: Set<string>): number {
    if (path.has(id)) fail("dependency_cycle");
    const next = new Set(path).add(id);
    return (
      1 +
      Math.max(0, ...node(state, id).dependencies.map((d) => depth(d, next)))
    );
  }
  for (const o of state.obligations)
    if (depth(o.id, new Set()) > policy.maxDepth)
      fail("dependency_depth_limit");
}
function fresh(o: Obligation, now: string, policy: Policy) {
  return (
    !!o.reply &&
    Date.parse(o.reply.validUntil) > Date.parse(now) &&
    Date.parse(o.reply.observedAt) >=
      Date.parse(now) - policy.evidenceAgeSeconds * 1000
  );
}
export function outcome(state: CaseState, terminal: boolean): Outcome {
  const unresolved = state.obligations.filter(
    (o) => o.required && o.status !== "verified",
  );
  const type =
    state.status === "completed"
      ? "completed"
      : state.status === "cancelled"
        ? "cancelled"
        : state.status === "handed_off"
          ? "handed_off"
          : state.obligations.some((o) => o.status === "verified")
            ? "partial"
            : "blocked";
  return {
    outcome: type,
    terminal,
    scope: "communication_only",
    origin: "simulated",
    requirements: state.obligations.map((o) => ({
      id: o.id,
      status: o.status,
      evidenceIds: [o.reply?.evidenceId, o.verification?.evidenceId].filter(
        (x): x is string => !!x,
      ),
    })),
    unresolvedObligationIds: unresolved.map((o) => o.id),
  };
}
function advance(
  state: CaseState,
  policy: Policy,
  now: string,
): { contacts: Contact[]; result?: Outcome } {
  const contacts: Contact[] = [];
  const wasBlocked = state.status === "blocked";
  if (["completed", "cancelled", "handed_off"].includes(state.status))
    return { contacts };
  for (const o of state.obligations) {
    const reporterAllowed =
      !o.reply ||
      policy.actors.some(
        (a) =>
          a.enabled &&
          a.id === o.reply!.actorId &&
          a.group === o.group &&
          a.role === "respondent",
      );
    const verifierAllowed =
      !o.verification ||
      policy.actors.some(
        (a) =>
          a.enabled &&
          a.id === o.verification!.actorId &&
          a.group === o.group &&
          a.role === "verifier",
      );
    if (
      o.reply &&
      (!fresh(o, now, policy) || !reporterAllowed || !verifierAllowed)
    )
      invalidate(state, o.id, now);
  }
  if (
    state.obligations
      .filter((o) => o.required)
      .every((o) => o.status === "verified")
  ) {
    state.status = "completed";
    return { contacts, result: outcome(state, true) };
  }
  if (Date.parse(state.deadline) <= Date.parse(now)) {
    state.status = "blocked";
    return { contacts, result: outcome(state, true) };
  }
  if (state.status === "paused" || state.takeoverBy) return { contacts };
  for (const o of state.obligations) {
    if (
      o.status === "answered" &&
      !o.verificationRequested &&
      o.dependencies.every((id) => node(state, id).status === "verified")
    ) {
      const verifier = policy.actors.find(
        (a) =>
          a.enabled &&
          a.group === o.group &&
          a.role === "verifier" &&
          a.id !== o.reply?.actorId,
      );
      if (!verifier || state.contacts >= policy.maxContacts) {
        o.status = "blocked";
        continue;
      }
      contacts.push({
        obligationId: o.id,
        actorId: verifier.id,
        kind: "verify_request",
        question: `Independently review the reported claim for ${o.id}; verify the exact subject and reply revision, evidence validity and prerequisites.`,
        subject: state.subject,
        sourceEvidenceId: state.sourceEvidenceId,
        replyEvidenceId: o.reply!.evidenceId,
        replyRevision: o.reply!.revision,
        origin: "simulated",
      });
      state.contacts++;
      o.verificationRequested = true;
    }
    if (
      o.status !== "waiting" ||
      o.dependencies.some((id) => node(state, id).status !== "verified") ||
      Date.parse(o.nextContactAt) > Date.parse(now)
    )
      continue;
    if (state.contacts >= policy.maxContacts) {
      o.status = "blocked";
      continue;
    }
    let kind: Contact["kind"] = "ask";
    if (o.reminders > 0) {
      if (o.reminders <= policy.maxReminders) {
        kind = "reminder";
      } else if (!o.escalated) {
        const fallback = policy.actors.find(
          (a) =>
            a.enabled &&
            a.group === o.group &&
            a.role === "respondent" &&
            a.id !== o.assignee,
        );
        if (!fallback) {
          o.status = "blocked";
          continue;
        }
        o.assignee = fallback.id;
        o.escalated = true;
        kind = "escalation";
        o.revision++;
      } else {
        o.status = "blocked";
        continue;
      }
    }
    const recipient = resolveActor(policy, o.assignee);
    if (recipient.group !== o.group || recipient.role !== "respondent")
      fail("invalid_responsibility", 403);
    contacts.push({
      obligationId: o.id,
      actorId: o.assignee,
      kind,
      question: o.question,
      subject: state.subject,
      sourceEvidenceId: state.sourceEvidenceId,
      origin: "simulated",
    });
    state.contacts++;
    o.reminders++;
    o.nextContactAt = at(now, policy.reminderSeconds);
  }
  const blocked = state.obligations.some(
    (o) => o.required && ["blocked", "disputed"].includes(o.status),
  );
  state.status = blocked ? "blocked" : "active";
  return {
    contacts,
    ...(blocked && !wasBlocked ? { result: outcome(state, false) } : {}),
  };
}
export function initialize(state: CaseState, policy: Policy, now: string) {
  graphGuard(state, policy);
  return { state, ...advance(state, policy, now) };
}
export function transition(
  input: CaseState,
  policy: Policy,
  actor: Actor | null,
  operation: Operation | { type: "tick" },
  evidenceId: string,
  now: string,
) {
  const state = structuredClone(input);
  if (state.configurationVersion !== policy.version)
    fail("configuration_changed_review_required");
  if (state.revision >= 500 && operation.type === "tick") {
    state.revision++;
    state.status = "handed_off";
    return { state, contacts: [] as Contact[], result: outcome(state, true) };
  }
  if (
    state.revision >= 500 &&
    !["cancel", "handoff", "report"].includes(operation.type)
  )
    fail("case_revision_limit_handoff_required");
  if (operation.type !== "tick" && !actor) fail("actor_required", 403);
  const op = operation;
  if (op.type === "tick") {
    if (
      ["completed", "cancelled", "handed_off"].includes(state.status) ||
      (state.status === "blocked" &&
        Date.parse(state.deadline) <= Date.parse(now))
    )
      return { state, contacts: [] as Contact[] };
  } else if (op.type === "reopen") {
    coordinator(actor!);
    if (["cancelled", "handed_off"].includes(state.status))
      fail("terminal_case");
    invalidate(state, op.obligationId, now);
    state.status = "active";
    state.deadline = at(now, policy.deadlineSeconds);
  } else {
    if (["completed", "cancelled", "handed_off"].includes(state.status))
      fail("terminal_case");
    if (
      Date.parse(state.deadline) <= Date.parse(now) &&
      !["cancel", "handoff", "report"].includes(op.type)
    )
      fail("case_deadline_elapsed");
    switch (op.type) {
      case "reply": {
        const o = node(state, op.obligationId);
        canRespond(actor!, o);
        if (o.revision !== op.expectedObligationRevision)
          fail("stale_obligation");
        if (op.subjectRevision !== state.subject.revision)
          fail("subject_revision_mismatch");
        if (
          Date.parse(op.observedAt) > Date.parse(now) ||
          Date.parse(op.validUntil) <= Date.parse(now) ||
          Date.parse(op.observedAt) <
            Date.parse(now) - policy.evidenceAgeSeconds * 1000 ||
          Date.parse(op.validUntil) >
            Date.parse(op.observedAt) + policy.evidenceAgeSeconds * 1000
        )
          fail("invalid_evidence_validity");
        invalidateParents(state, o.id, now);
        o.revision++;
        o.reply = {
          revision: o.revision,
          evidenceId,
          actorId: actor!.id,
          statement: op.statement,
          observedAt: op.observedAt,
          validUntil: op.validUntil,
          subjectRevision: op.subjectRevision,
        };
        delete o.verification;
        delete o.verificationRequested;
        o.status = "answered";
        break;
      }
      case "verify": {
        const o = node(state, op.obligationId);
        if (
          actor!.role !== "verifier" ||
          actor!.group !== o.group ||
          actor!.id === o.reply?.actorId
        )
          fail("independent_verifier_required", 403);
        if (
          !o.reply ||
          o.reply.revision !== op.replyRevision ||
          !fresh(o, now, policy)
        )
          fail("stale_or_missing_reply");
        if (o.dependencies.some((id) => node(state, id).status !== "verified"))
          fail("unresolved_dependency");
        invalidateParents(state, o.id, now);
        o.revision++;
        o.status = op.accept ? "verified" : "disputed";
        o.verification = {
          actorId: actor!.id,
          evidenceId,
          replyRevision: op.replyRevision,
          at: now,
        };
        break;
      }
      case "add_child": {
        const parent = node(state, op.parentId);
        if (actor!.role !== "coordinator") canRespond(actor!, parent);
        if (!policy.groups.includes(op.group))
          fail("group_outside_service_scope", 403);
        if (state.obligations.some((o) => o.id === op.obligationId))
          fail("obligation_id_conflict");
        const assigned = policy.actors.find(
          (a) => a.enabled && a.group === op.group && a.role === "respondent",
        );
        if (!assigned) fail("no_responsible_actor");
        invalidate(state, parent.id, now);
        parent.dependencies.push(op.obligationId);
        state.obligations.push({
          id: op.obligationId,
          group: op.group,
          kind: op.kind,
          question: op.question,
          required: true,
          dependencies: [],
          assignee: assigned!.id,
          revision: 1,
          status: "waiting",
          reminders: 0,
          escalated: false,
          nextContactAt: now,
        });
        graphGuard(state, policy);
        break;
      }
      case "link_dependency": {
        coordinator(actor!);
        const o = node(state, op.obligationId);
        node(state, op.dependencyId);
        if (o.dependencies.includes(op.dependencyId))
          fail("dependency_already_linked");
        o.dependencies.push(op.dependencyId);
        graphGuard(state, policy);
        invalidate(state, o.id, now);
        break;
      }
      case "reassign": {
        coordinator(actor!);
        const o = node(state, op.obligationId),
          replacement = resolveActor(policy, op.actorId);
        if (replacement.group !== o.group || replacement.role !== "respondent")
          fail("invalid_responsibility", 403);
        invalidate(state, o.id, now);
        o.assignee = replacement.id;
        break;
      }
      case "pause":
        coordinator(actor!);
        state.status = "paused";
        break;
      case "resume":
        coordinator(actor!);
        if (state.status !== "paused") fail("case_not_paused");
        state.status = "active";
        break;
      case "takeover":
        coordinator(actor!);
        state.takeoverBy = actor!.id;
        break;
      case "release":
        coordinator(actor!);
        delete state.takeoverBy;
        break;
      case "cancel":
        coordinator(actor!);
        state.status = "cancelled";
        break;
      case "handoff":
        coordinator(actor!);
        state.status = "handed_off";
        break;
      case "report":
        coordinator(actor!);
        break;
    }
  }
  state.revision++;
  const effect = advance(state, policy, now);
  if (op.type === "report" || op.type === "cancel" || op.type === "handoff")
    effect.result = outcome(state, op.type !== "report");
  return { state, ...effect };
}
export function nextWake(
  state: CaseState,
  policy: Policy,
  now: string,
): string | null {
  if (
    ["completed", "cancelled", "handed_off"].includes(state.status) ||
    Date.parse(state.deadline) <= Date.parse(now)
  )
    return null;
  const times = [Date.parse(state.deadline)];
  for (const o of state.obligations) {
    if (o.reply)
      times.push(
        Math.min(
          Date.parse(o.reply.validUntil),
          Date.parse(o.reply.observedAt) + policy.evidenceAgeSeconds * 1000,
        ),
      );
    if (
      state.status !== "paused" &&
      !state.takeoverBy &&
      o.status === "waiting" &&
      o.dependencies.every((id) => node(state, id).status === "verified")
    )
      times.push(Date.parse(o.nextContactAt));
  }
  return new Date(
    Math.max(Date.parse(now) + 1000, Math.min(...times)),
  ).toISOString();
}
