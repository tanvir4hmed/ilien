import { createHash } from "node:crypto";
import {
  CoordinationError,
  type Actor,
  type CaseState,
  type Contact,
  type Obligation,
  type Operation,
  type Outcome,
  type Policy,
  type ReportedFact,
} from "./types.js";
const fail = (code: string, status = 409): never => {
  throw new CoordinationError(code, status);
};
const at = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString();
export const satisfied = (o: Obligation) => !!o.skipped || o.status === "verified" || o.status === "accepted";
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
  // A new prerequisite or expired fact does not withdraw an instruction/hold.
  // Keep its attributed wording until its author explicitly withdraws it.
  o.retainedRestrictions=o.reply?.restrictions ?? o.retainedRestrictions;
  delete o.reply;
  delete o.retainedFacts;
  delete o.conflicts;
  delete o.skipped;
  delete o.satisfiedFrom;
  delete o.decision;
  // A changed prerequisite invalidates the proposed business terms as well.
  // They must be assembled again from the current dependency evidence.
  if(o.kind === "decision") delete o.proposal;
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
  const depths = new Map<string, number>();
  function depth(id: string, path: Set<string>): number {
    if (path.has(id)) fail("dependency_cycle");
    const known = depths.get(id);
    if (known !== undefined) return known;
    const next = new Set(path).add(id);
    const value =
      1 +
      Math.max(0, ...node(state, id).dependencies.map((d) => depth(d, next)));
    depths.set(id, value);
    return value;
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
function knownFacts(o:Obligation,state:CaseState,now:string):ReportedFact[] {
  const candidates=[...(o.retainedFacts ?? []),...(o.reply?.facts ?? []).map(f=>({...f,evidenceId:f.evidenceId ?? o.reply!.evidenceId,actorId:f.actorId ?? o.reply!.actorId,subjectRevision:f.subjectRevision ?? o.reply!.subjectRevision,reportedAt:f.reportedAt ?? o.reply!.observedAt,validUntil:f.validUntil ?? o.reply!.validUntil}))];
  return [...new Map(candidates.filter(f=>f.actorId===o.assignee && f.subjectRevision===state.subject.revision && Date.parse(f.validUntil)>Date.parse(now)).map(f=>[JSON.stringify([f.scope??state.subject.id,f.key]),f])).values()];
}
function rememberDecisionNotices(state:CaseState,contacts:Contact[]) {
  for(const c of contacts.filter(c=>c.kind==="decision_notice" && c.decisionId && c.decisionHash)) {
    if(state.decisionNotices?.some(n=>n.decisionId===c.decisionId && n.decisionHash===c.decisionHash && n.actorId===c.actorId))continue;
    state.decisionNotices=[...(state.decisionNotices ?? []),{decisionId:c.decisionId!,decisionHash:c.decisionHash!,obligationId:c.obligationId,actorId:c.actorId}];
  }
}
export function outcome(state: CaseState, terminal: boolean): Outcome {
  const unresolved = state.obligations.filter(
    (o) => o.required && !satisfied(o),
  );
  const type =
    state.status === "completed"
      ? "completed"
      : state.status === "cancelled"
        ? "cancelled"
        : state.status === "handed_off"
          ? "handed_off"
          : state.autonomous && state.status === "active" ? "in_progress"
          : state.obligations.some(satisfied)
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
  const alert=(reason:string)=>{
    const supervisor=policy.actors.find(a=>a.id===policy.supervisorActorId&&a.enabled&&a.role==="coordinator");
    if(supervisor&&state.obligations[0]&&state.attentionNotified!==reason&&state.contacts<policy.maxContacts){
      contacts.push({obligationId:state.obligations[0].id,actorId:supervisor.id,kind:"operator_attention",question:`Assistance needed for ${state.subject.id}: ${reason}. Reply with missing information or an explicit requested response-deadline extension. No business approval is inferred.`,subject:state.subject,sourceEvidenceId:state.sourceEvidenceId,origin:state.origin});
      state.contacts++;state.attentionNotified=reason;
    }
  };
  if (["completed", "cancelled", "handed_off"].includes(state.status))
    return { contacts };
  if(Date.parse(state.deadline)<=Date.parse(now) && !state.takeoverBy && state.status!=="paused" &&
      (policy.autoExtendSeconds ?? 0)>0 && (state.extensions ?? 0)<(policy.maxExtensions ?? 0) &&
      (!state.businessDeadline || Date.parse(state.businessDeadline)>Date.parse(now))) {
    state.deadline=new Date(Math.min(Date.parse(at(now,policy.autoExtendSeconds!)),state.businessDeadline?Date.parse(state.businessDeadline):Infinity)).toISOString();
    state.extensions=(state.extensions ?? 0)+1;
    state.attentionReason="response_sla_extended_by_policy";
  }
  if (state.awaitingPlan) {
    if(Date.parse(state.deadline) <= Date.parse(now)) {
      state.status="blocked";
      state.attentionReason="response_deadline_elapsed";
      alert(state.attentionReason);
      return {contacts,result:outcome(state,false)};
    }
    return { contacts };
  }
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
    if (o.status === "answered" && o.acceptance === "responsible_reply" &&
        o.dependencies.every(id => satisfied(node(state,id))) &&
        (o.kind !== "completion" || o.reply?.progress === "ready")) {
      o.status = o.decision?.choice === "reject" ? "disputed" : "accepted";
    }
  }
  if (
    !state.planningPending && !state.sourceQuestions?.some(q=>!q.answer) && state.obligations.some(o => o.required) && state.obligations
      .filter((o) => o.required)
      .every(satisfied)
  ) {
    state.status = "completed";
    return { contacts, result: outcome(state, true) };
  }
  if (Date.parse(state.deadline) <= Date.parse(now)) {
    state.status = "blocked";
    state.attentionReason="response_deadline_elapsed";
    alert(state.attentionReason);
    return { contacts, result: outcome(state, false) };
  }
  if (state.status === "paused" || state.takeoverBy) return { contacts };
  if(state.planningPending)return {contacts};
  for (const o of state.obligations) {
    if (
      o.status === "answered" &&
      o.acceptance !== "responsible_reply" &&
      !o.verificationRequested &&
      o.dependencies.every((id) => satisfied(node(state, id)))
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
      o.skipped || o.status !== "waiting" ||
      o.dependencies.some((id) => !satisfied(node(state, id))) ||
      (o.kind === "decision" && !o.proposal) ||
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
    const approval = state.autonomous && o.kind === "completion"
      ? o.dependencies.map(id=>node(state,id)).find(d=>d.kind === "decision" && d.decision?.choice === "approve" && satisfied(d)) : undefined;
    if (approval?.proposal && fresh(approval,now,policy)) {
      const contact = contacts[contacts.length-1]!;
      contact.kind = "decision_notice";
      contact.decisionId = approval.id;
      contact.decisionHash = approval.proposal.sha256;
      contact.question = `Authorized decision: ${approval.proposal.statement}. ${o.question}`;
    }
    state.contacts++;
    o.reminders++;
    o.nextContactAt = at(now, policy.reminderSeconds);
  }
  const blocked = state.obligations.some(
    (o) => o.required && ["blocked", "disputed"].includes(o.status),
  );
  state.status = blocked ? "blocked" : "active";
  if(blocked){state.attentionReason=state.attentionReason ?? "required_response_unavailable";alert(state.attentionReason);}
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
  if (
    operation.type === "tick" &&
    ["completed", "cancelled", "handed_off"].includes(state.status)
  )
    return { state, contacts: [] as Contact[] };
  if (
    operation.type === "tick" &&
    state.configurationVersion !== policy.version
  ) {
    state.status = "paused";
    state.revision++;
    return { state, contacts: [] as Contact[], result: outcome(state, false) };
  }
  if (
    state.configurationVersion !== policy.version &&
    !["adopt_configuration", "cancel", "handoff"].includes(operation.type)
  )
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
  if(state.autonomous && ["route_initial","attach_proposal","clarify","reroute","add_child","link_dependency","select_channel","skip_optional","satisfy_from","relay_decision","source_query"].includes(op.type))state.planningPending=false;
  const extraContacts: Contact[] = [];
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
        !["cancel", "handoff", "report", "adopt_configuration", "extend_deadline", "takeover", "pause","clarify_attention","source_response"].includes(op.type)
    )
      fail("case_deadline_elapsed");
    switch (op.type) {
      case "continue_plan":coordinator(actor!);state.planningPending=false;break;
      case "clarify_attention": {
        coordinator(actor!);
        if(actor!.id!==policy.supervisorActorId || (state.supervisorClarifications??0)>=4 || state.contacts>=policy.maxContacts)fail("supervisor_clarification_limit");
        const o=state.obligations[0];if(!o)fail("obligation_not_found");
        extraContacts.push({obligationId:o!.id,actorId:actor!.id,kind:"operator_attention",question:op.question,subject:state.subject,sourceEvidenceId:state.sourceEvidenceId,origin:state.origin});state.contacts++;state.supervisorClarifications=(state.supervisorClarifications??0)+1;break;
      }
      case "extend_deadline": {
        coordinator(actor!);
        if(Date.parse(op.deadline)<=Date.parse(now) || Date.parse(op.deadline)>Date.parse(now)+policy.deadlineSeconds*1000) fail("extension_outside_policy");
        if(state.businessDeadline && Date.parse(op.deadline)>Date.parse(state.businessDeadline)) fail("business_deadline_requires_source_amendment");
        state.deadline=op.deadline;state.status="active";delete state.attentionReason;
        state.planningPending=true;
        delete state.attentionNotified;
        for(const o of state.obligations)if(o.status==="blocked"){o.status="waiting";o.reminders=0;o.escalated=false;o.nextContactAt=now;}
        break;
      }
      case "skip_optional": {
        coordinator(actor!);const o=node(state,op.obligationId);
        if(!o.optional || o.kind==="decision" || o.kind==="completion" || o.requiredFacts?.length || state.obligations.some(n=>n.dependencies.includes(o.id)))fail("mandatory_requirement_cannot_be_skipped");
        o.skipped={reason:op.reason,evidenceId};o.required=false;o.revision++;
        break;
      }
      case "satisfy_from": {
        coordinator(actor!);const o=node(state,op.obligationId),existing=node(state,op.evidenceTaskId);
        if(o.id===existing.id || !["fact","evidence","acknowledgement"].includes(o.kind) || o.kind!==existing.kind || o.group!==existing.group || o.assignee!==existing.assignee || !satisfied(existing) || !fresh(existing,now,policy) || existing.conflicts?.length || !o.requiredFacts?.length || o.requiredFacts.some(k=>!existing.reply?.facts?.some(f=>f.key===k)) || o.question!==existing.question || o.acceptance!==existing.acceptance)fail("equivalent_authorized_evidence_required");
        if(o.dependencies.some(id=>!satisfied(node(state,id))))fail("unresolved_dependency");
        o.dependencies=[...new Set([...o.dependencies,existing.id])];graphGuard(state,policy);
        o.reply=structuredClone(existing.reply);o.verification=structuredClone(existing.verification);o.status=existing.status;o.satisfiedFrom=existing.id;o.revision++;
        break;
      }
      case "select_channel": {
        coordinator(actor!);const o=node(state,op.obligationId);
        if(satisfied(o))fail("requirement_already_satisfied");
        if(!["waiting","blocked"].includes(o.status))fail("channel_change_requires_unanswered_task");
        if(o.preferredChannel===op.channel)fail("channel_unchanged");
        o.preferredChannel=op.channel;o.channelReason=op.reason;o.nextContactAt=now;
        o.revision++;o.reminders=0;o.status="waiting";o.escalated=false;
        break;
      }
      case "source_query": {
        coordinator(actor!); if(!state.autonomous) fail("autonomous_mission_required");
        if((state.sourceQuestions?.length ?? 0)>=8) fail("source_question_limit");
        if(state.sourceQuestions?.some(q=>q.id===op.questionId || q.question.trim().toLowerCase()===op.question.trim().toLowerCase())) fail("duplicate_source_question");
        state.sourceQuestions=[...(state.sourceQuestions ?? []),{id:op.questionId,question:op.question}];
        const supervisor=policy.actors.find(a=>a.id===policy.supervisorActorId&&a.enabled&&a.role==="coordinator");
        if(supervisor && state.obligations[0] && state.contacts<policy.maxContacts){extraContacts.push({obligationId:state.obligations[0].id,actorId:supervisor.id,kind:"source_question",sourceQuestionId:op.questionId,question:op.question,subject:state.subject,sourceEvidenceId:state.sourceEvidenceId,origin:state.origin});state.contacts++;}
        break;
      }
      case "source_response": {
        coordinator(actor!);
        const q=state.sourceQuestions?.find(q=>q.id===op.questionId && !q.answer);
        if(!q) fail("source_question_not_open");
        q!.answer=op.answer; q!.evidenceId=evidenceId;
        state.planningPending=true;
        break;
      }
      case "route_initial": {
        coordinator(actor!);
        if (!state.autonomous || !state.awaitingPlan) fail("initial_routing_already_complete");
        if (!policy.groups.includes(op.group)) fail("group_outside_service_scope",403);
        const owner=policy.actors.find(a=>a.enabled && a.group===op.group && a.role==="respondent");
        if(!owner) fail("no_responsible_actor");
        const o=node(state,op.obligationId);
        if(o.dependencies.length) fail("initial_prerequisite_required");
        o.group=op.group; o.assignee=owner!.id; o.question=op.question;
        o.preferredChannel=op.channel ?? owner!.preferredChannel;o.channelReason=op.channelReason;
        state.awaitingPlan=false;
        break;
      }
      case "clarify": {
        coordinator(actor!);
        if (!state.autonomous) fail("autonomous_mission_required");
        const o = node(state,op.obligationId);
        if ((o.clarificationCount ?? 0) >= 4) fail("clarification_limit_source_attention");
        if (o.question.trim().toLowerCase() === op.question.trim().toLowerCase()) fail("duplicate_clarification");
        const retained=knownFacts(o,state,now),proposal=o.proposal,restrictions=o.reply?.restrictions ?? o.retainedRestrictions,conflicts=o.conflicts;
        invalidate(state,o.id,now);
        o.retainedFacts=retained;
        o.retainedRestrictions=restrictions;o.conflicts=conflicts;
        if(op.channel){o.preferredChannel=op.channel;o.channelReason=op.channelReason;}
        if(proposal && o.dependencies.every(id=>satisfied(node(state,id))))o.proposal=proposal;
        o.question = op.question;
        o.clarificationCount = (o.clarificationCount ?? 0)+1;
        break;
      }
      case "reroute": {
        coordinator(actor!);
        if (!state.autonomous || !policy.groups.includes(op.group)) fail("group_outside_service_scope",403);
        const o=node(state,op.obligationId);
        if (o.group === op.group) fail("routing_unchanged");
        const owner=policy.actors.find(a=>a.enabled && a.group===op.group && a.role==="respondent");
        if (!owner) fail("no_responsible_actor");
        invalidate(state,o.id,now); o.group=op.group; o.assignee=owner!.id;
        break;
      }
      case "relay_decision": {
        coordinator(actor!);
        if (!state.autonomous) fail("autonomous_mission_required");
        const o=node(state,op.obligationId), d=node(state,op.decisionId);
        if (!d.proposal || d.decision?.choice!=="approve" || !satisfied(d) || !fresh(d,now,policy)) fail("current_approved_decision_required");
        const key=`${d.id}/${d.proposal!.sha256}/${d.reply!.revision}`;
        if (o.relayKeys?.includes(key)) fail("decision_already_relayed");
        if (state.contacts>=policy.maxContacts) fail("contact_budget_exhausted");
        o.relayKeys=[...(o.relayKeys ?? []),key];
        extraContacts.push({obligationId:o.id,actorId:o.assignee,kind:"decision_notice",decisionId:d.id,decisionHash:d.proposal!.sha256,question:`Authorized decision: ${d.proposal!.statement}. Decision by ${d.decision!.actorId}. This notice concerns your assigned responsibility only.`,subject:state.subject,sourceEvidenceId:state.sourceEvidenceId,origin:"simulated"});
        state.contacts++;
        break;
      }
      case "adopt_configuration": {
        coordinator(actor!);
        if (op.version !== policy.version)
          fail("configuration_version_mismatch");
        for (const o of state.obligations) {
          if (!policy.groups.includes(o.group))
            fail("existing_group_outside_scope");
          const assigned =
            policy.actors.find(
              (a) =>
                a.enabled &&
                a.group === o.group &&
                a.role === "respondent" &&
                a.id === o.assignee,
            ) ??
            policy.actors.find(
              (a) =>
                a.enabled && a.group === o.group && a.role === "respondent",
            );
          if (
            !assigned ||
            (!state.autonomous || o.acceptance === "independent") && !policy.actors.some(
              (a) => a.enabled && a.group === o.group && a.role === "verifier",
            )
          )
            fail("existing_authority_unavailable");
          o.assignee = assigned!.id;
        }
        graphGuard(state, policy);
        const seen = new Set<string>();
        for (const o of state.obligations) invalidate(state, o.id, now, seen);
        state.configurationVersion = policy.version;
        break;
      }
      case "amend_subject": {
        coordinator(actor!);
        if (op.subjectRevision === state.subject.revision)
          fail("new_subject_revision_required");
        state.subject.revision = op.subjectRevision;
        state.goal = op.goal;
        state.missionRevision = (state.missionRevision ?? 1) + 1;
        state.amendmentEvidenceIds = [
          ...(state.amendmentEvidenceIds ?? []),
          evidenceId,
        ];
        const seen = new Set<string>();
        for (const o of state.obligations) invalidate(state, o.id, now, seen);
        break;
      }
      case "attach_proposal": {
        coordinator(actor!);
        const o = node(state, op.obligationId);
        if (o.kind !== "decision") fail("decision_obligation_required");
        if(o.dependencies.some(id=>!satisfied(node(state,id)))) fail("unresolved_dependency");
        if (
          o.proposal &&
          (o.proposal.id !== op.proposalId ||
            op.proposalRevision <= o.proposal.revision)
        )
          fail("new_proposal_revision_required");
        invalidate(state, o.id, now);
        const subjectRevision = state.subject.revision;
        const sha256 = createHash("sha256")
          .update(
            JSON.stringify({
              id: op.proposalId,
              revision: op.proposalRevision,
              statement: op.statement,
              subjectRevision,
            }),
          )
          .digest("hex");
        o.proposal = {
          id: op.proposalId,
          revision: op.proposalRevision,
          statement: op.statement,
          subjectRevision,
          sha256,
          evidenceId,
        };
        break;
      }
      case "decide":
      case "reply": {
        const o = node(state, op.obligationId);
        canRespond(actor!, o);
          if(op.type==="decide" && actor!.approvalScopes && !actor!.approvalScopes.includes("*") && !actor!.approvalScopes.includes(state.subject.type))fail("approval_scope_not_authorized",403);
        if (op.type === "reply" && o.kind === "decision")
          fail("bound_decision_required");
        if(op.type === "decide" && o.dependencies.some(id=>!satisfied(node(state,id)))) fail("unresolved_dependency");
        if (
          op.type === "decide" &&
          (o.kind !== "decision" ||
            !o.proposal ||
            o.proposal.sha256 !== op.proposalHash ||
            o.proposal.subjectRevision !== state.subject.revision)
        )
          fail("current_proposal_required");
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
        const factIdentity=(f:ReportedFact | {key:string;scope?:string})=>JSON.stringify([f.scope??state.subject.id,f.key]);
        const collected=op.type==="reply" && state.autonomous ? new Map(knownFacts(o,state,now).map(f=>[factIdentity(f),f])) : new Map<string,ReportedFact>();
        const restrictions=(o.reply?.restrictions ?? o.retainedRestrictions ?? []).filter(r=>!(op.type==="reply"&&op.withdrawRestrictions?.includes(r.text)&&r.actorId===actor!.id));
        if(op.type==="reply")for(const fact of op.facts ?? []) {
          const incoming={...fact,evidenceId,actorId:actor!.id,subjectRevision:op.subjectRevision,reportedAt:op.observedAt,validUntil:op.validUntil};
          const previous=collected.get(factIdentity(fact));
          if(previous && (previous.value!==fact.value || previous.unit!==fact.unit) && !op.corrects?.includes(fact.key)) {
            o.conflicts=[...(o.conflicts ?? []).filter(c=>c.key!==fact.key),{key:fact.key,previous,incoming}];
          } else {collected.set(factIdentity(fact),incoming);o.conflicts=o.conflicts?.filter(c=>c.key!==fact.key || factIdentity(c.incoming)!==factIdentity(fact));}
        }
        if(collected.size>12)fail("collected_fact_limit");
        invalidateParents(state, o.id, now);
        o.revision++;
        o.reply = {
          revision: o.revision,
          evidenceId,
          actorId: actor!.id,
          statement:
            op.type === "decide" ? `${op.choice}: ${op.reason}` : op.statement,
          observedAt: op.observedAt,
          validUntil: new Date(Math.min(Date.parse(op.validUntil),...[...collected.values()].map(f=>Date.parse(f.validUntil)))).toISOString(),
          subjectRevision: op.subjectRevision,
          timeBasis: op.timeBasis ?? "observed",
          ...(op.type === "reply" ? {facts:[...collected.values()],progress:op.progress,statusQuote:op.statusQuote} : {}),
          restrictions:[...restrictions,...(op.type==="reply" ? (op.restrictions ?? []).map(text=>({text,actorId:actor!.id,evidenceId})) : [])].filter((v,i,a)=>a.findIndex(x=>x.text===v.text&&x.actorId===v.actorId)===i),
        };
        delete o.retainedFacts;
        if (op.type === "decide")
          o.decision = {
            proposalHash: op.proposalHash,
            choice: op.choice,
            reason: op.reason,
            actorId: actor!.id,
            evidenceId,
          };
        delete o.verification;
        delete o.verificationRequested;
        o.status = "answered";
        if(o.conflicts?.length) {o.status="waiting";o.question=`Please resolve conflicting reports: ${o.conflicts.map(c=>`${c.key}: previously ${c.previous.value} ${c.previous.unit ?? ""}, now ${c.incoming.value} ${c.incoming.unit ?? ""}`).join("; ")}. Explicitly identify corrections; no changed value is accepted yet.`;o.reminders=0;o.nextContactAt=now;state.attentionReason="conflicting_participant_facts";}
        if (o.kind === "completion" && op.type === "reply" && op.progress !== "ready") {
          o.status="waiting"; o.nextContactAt=now; o.reminders=0;
        }
        const missing=op.type === "reply" ? (o.requiredFacts ?? []).filter(key=>!o.reply!.facts?.some(f=>f.key===key)) : [];
        if(state.autonomous && missing.length && (o.kind!=="completion" || (op.type==="reply" && op.progress==="ready"))) {
          o.status="waiting";o.nextContactAt=now;o.reminders=0;
          o.question=(o.conflicts?.length ? `${o.question}\n` : "")+`Please confirm ${missing.map(k=>k.replaceAll("_"," ")).join(", ")} for ${state.subject.id}. Preserve quantities, units, timing and uncertainty; no completion is inferred from missing information.`;
        }
        if(state.autonomous && o.status==="answered")state.planningPending=true;
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
        if (o.dependencies.some((id) => !satisfied(node(state, id))))
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
        if(state.autonomous)state.planningPending=true;
        break;
      }
      case "add_child": {
        const parent = node(state, op.parentId);
        if (actor!.role !== "coordinator") canRespond(actor!, parent);
        if (!policy.groups.includes(op.group))
          fail("group_outside_service_scope", 403);
        if (state.obligations.some((o) => o.id === op.obligationId))
          fail("obligation_id_conflict");
        const questionKey = (text: string) =>
          text.replace(/\s+/gu, " ").trim().toLowerCase();
        if (
          state.obligations.some(
            (o) =>
              o.group === op.group &&
              questionKey(o.question) === questionKey(op.question),
          )
        )
          fail("duplicate_question_use_existing");
        const assigned = policy.actors.find(
          (a) => a.enabled && a.group === op.group && a.role === "respondent",
        );
        if (!assigned) fail("no_responsible_actor");
        const retained=knownFacts(parent,state,now),restrictions=parent.reply?.restrictions ?? parent.retainedRestrictions;
        invalidate(state, parent.id, now);
        parent.retainedFacts=retained;parent.retainedRestrictions=restrictions;
        parent.dependencies.push(op.obligationId);
        state.obligations.push({
          id: op.obligationId,
          group: op.group,
          kind: op.kind,
          question: op.question,
          required: true,
          dependencies: [],
          assignee: assigned!.id,
          preferredChannel:assigned!.preferredChannel,
          revision: 1,
          status: "waiting",
          reminders: 0,
          escalated: false,
          nextContactAt: now,
          acceptance: state.autonomous ? "responsible_reply" : "independent",
        });
        if (op.proposalStatement) {
          if (op.kind !== "decision" || !state.autonomous) fail("decision_obligation_required");
          const child=state.obligations[state.obligations.length-1]!;
          const proposal={id:`proposal_${child.id}`, revision:1,statement:op.proposalStatement,subjectRevision:state.subject.revision};
          child.proposal={...proposal,sha256:createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),evidenceId};
        }
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
        const retained=knownFacts(o,state,now),restrictions=o.reply?.restrictions ?? o.retainedRestrictions;
        invalidate(state, o.id, now);
        o.retainedFacts=retained;o.retainedRestrictions=restrictions;
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
  effect.contacts.unshift(...extraContacts);
  rememberDecisionNotices(state,effect.contacts);
  for(const notice of state.decisionNotices ?? []) {
    const decision=state.obligations.find(o=>o.id===notice.decisionId);
    if(notice.withdrawn || (decision?.proposal?.sha256===notice.decisionHash && decision.decision?.choice==="approve" && satisfied(decision)))continue;
    if(state.contacts>=policy.maxContacts) {state.status="blocked";effect.result=outcome(state,false);continue;}
    notice.withdrawn=true;
    effect.contacts.push({obligationId:notice.obligationId,actorId:notice.actorId,kind:"decision_update",decisionId:notice.decisionId,decisionHash:notice.decisionHash,question:"Correction: the previously communicated approval is no longer current because its supporting information changed. No replacement approval is implied. A revised authorized decision is required before relying on that earlier approval.",subject:state.subject,sourceEvidenceId:state.sourceEvidenceId,origin:"simulated"});
    state.contacts++;
  }
  if (op.type === "report" || op.type === "cancel" || op.type === "handoff")
    effect.result = outcome(state, op.type !== "report");
  else if (state.autonomous && op.type !== "tick" && !effect.result)
    effect.result=outcome(state,false);
  return { state, ...effect };
}
export function nextWake(
  state: CaseState,
  policy: Policy,
  now: string,
): string | null {
  if (state.configurationVersion !== policy.version) return null;
  if (
    ["completed", "cancelled", "handed_off"].includes(state.status) ||
    Date.parse(state.deadline) <= Date.parse(now)
  )
    return null;
  // Initial planning and decision assembly are event-driven, not one-second timers.
  // A due root/question without a proposal must not continually invalidate AI runs.
  if(state.awaitingPlan || state.planningPending) return state.deadline;
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
      !o.skipped &&
      (o.kind !== "decision" || !!o.proposal) &&
      o.dependencies.every((id) => satisfied(node(state, id)))
    )
      times.push(Date.parse(o.nextContactAt));
  }
  return new Date(
    Math.max(Date.parse(now) + 1000, Math.min(...times)),
  ).toISOString();
}
