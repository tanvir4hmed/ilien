import { randomBytes, randomUUID } from "node:crypto";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import {
  CoordinationError,
  type CaseState,
  type Contact,
  type Policy,
} from "../../coordination/src/types.js";
import { communicationContext } from "../../domain-packs/src/communication.js";
import { configurationFor } from "../../product/src/configuration.js";
import type { MessageProfile, Fact } from "../../contracts/src/communication.js";
import { chooseBinding } from "./routing.js";

export interface Binding {
  id: string;
  actor_id: string;
  channel: "whatsapp" | "email";
  address: string;
  enabled: boolean;
  last_inbound_at?: string;
}
export interface Delivery {
  id: string;
  connection_id: string;
  case_id: string;
  contact_id: string;
  binding_id: string;
  actor_id: string;
  channel: "whatsapp" | "email";
  address: string;
  token: string;
  obligation_id: string;
  obligation_revision: number;
  status: string;
  provider_message_id?: string;
  request: {
    contact: Contact;
    subject: CaseState["subject"];
    obligationRevision: number;
    deadline: string;
    claim?: unknown;
    proposal?: unknown;
    sourceContext?: Record<string, unknown>;
    profile?: MessageProfile;
    facts?: (Fact & {evidenceId:string; actorId:string;validUntil?:string;reportedAt?:string;subjectRevision?:string})[];
    autonomous?:boolean;
    instructions?: {text:string; actorId:string; evidenceId:string}[];
    routingReason?: string;
    demo?: boolean;
    demoActorId?: string;
    department?: string;
  };
}
export const decode = <T>(v: T | string): T =>
  typeof v === "string" ? JSON.parse(v) : v;

/** Contact content comes only from the deterministic coordinator, never an API send body. */
export async function createDelivery(
  tenant: string,
  state: CaseState,
  contactId: string,
  contact: Contact,
  tx: string,
  bindingId?: string,
) {
  const configuration=(await configurationFor(state.sourceId,tx)).configuration;
  const obligation = state.obligations.find(o=>o.id===contact.obligationId);
  if(!obligation)throw new CoordinationError("obligation_not_found",404);
  const demo=state.origin==="simulated" && configuration.demoRouting?.enabled===true;
  const bindingActor=demo ? configuration.demoRouting!.actorId : contact.actorId;
  const bindings = rows<Binding>(
    await query(
      `SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND actor_id=:actor AND enabled ${bindingId ? "AND id=CAST(:binding AS uuid)" : ""} ORDER BY priority,id`,
      [
        param("source", state.sourceId),
        param("actor", bindingActor),
        ...(bindingId ? [param("binding", bindingId)] : []),
      ],
      tx,
    ),
  );
  const route=chooseBinding(bindings,obligation,undefined,!!configuration.whatsappTemplate?.enabled);
  const binding = route?.binding;
  if (!binding) {
    if (bindingId)
      throw new CoordinationError("consented_binding_required", 403);
    return null;
  }
  const original = rows<{ original_text: string }>(
    await query(
      "SELECT original_text FROM evidence_items WHERE id=CAST(:id AS uuid)",
      [param("id", state.sourceEvidenceId)],
      tx,
    ),
  )[0];
  if (!original) throw new CoordinationError("source_evidence_required");
  const sourceContext = contact.kind === "decision_update" ? {} : communicationContext(
    JSON.parse(original.original_text),
    obligation.group,
  );
  const profile=configuration.messageProfiles?.find(p=>p.group===obligation.group && p.channel===binding.channel);
  if(profile && contact.kind !== "decision_update") {
    const event=JSON.parse(original.original_text) as {payload:Record<string,unknown>};
    for(const field of profile.sourceFields.includes("*") ? Object.keys(event.payload) : profile.sourceFields) if(Object.hasOwn(event.payload,field) && field!=="communicationContext") sourceContext[field]=event.payload[field];
  }
  const needed=new Set<string>();
  const collect=(id:string)=>{if(needed.has(id))return;needed.add(id);for(const dep of state.obligations.find(o=>o.id===id)?.dependencies ?? []) collect(dep);};
  for(const dep of obligation.dependencies) collect(dep);
  const facts=contact.kind === "decision_update" ? [] : state.obligations.filter(o=>needed.has(o.id) && ["accepted","verified"].includes(o.status)).flatMap(o=>(o.reply?.facts ?? []).map(f=>({...f,evidenceId:f.evidenceId ?? o.reply!.evidenceId,actorId:f.actorId ?? o.reply!.actorId})));
  // Clarifications must carry the participant's earlier usable facts and restrictions too.
  if(contact.kind!=="decision_update")for(const f of obligation.reply?.facts ?? obligation.retainedFacts ?? []) {
    if(Date.parse(f.validUntil)>Date.now() && f.subjectRevision===state.subject.revision)facts.push(f);
  }
  const instructions=contact.kind === "decision_update" ? [] : state.obligations.filter(o=>o.id===obligation.id || needed.has(o.id)).flatMap(o=>o.reply?.restrictions ?? o.retainedRestrictions ?? []);
  const id = randomUUID();
  const result = rows<{ id: string }>(
    await query(
      `INSERT INTO channel_deliveries(tenant_id,id,connection_id,case_id,contact_id,binding_id,actor_id,channel,address,token,obligation_id,obligation_revision,request)
     VALUES(CAST(:tenant AS uuid),CAST(:id AS uuid),CAST(:source AS uuid),CAST(:case AS uuid),CAST(:contact AS uuid),CAST(:binding AS uuid),:actor,:channel,:address,:token,:obligation,CAST(:revision AS integer),CAST(:request AS jsonb))
     ON CONFLICT(tenant_id,contact_id,channel) DO NOTHING RETURNING id`,
      [
        param("tenant", tenant),
        param("id", id),
        param("source", state.sourceId),
        param("case", state.id),
        param("contact", contactId),
        param("binding", binding.id),
        param("actor", contact.actorId),
        param("channel", binding.channel),
        param("address", binding.address),
        param("token", randomBytes(16).toString("hex")),
        param("obligation", obligation.id),
        param("revision", String(obligation.revision)),
        param(
          "request",
          JSON.stringify({
            contact,
            department:obligation.group,
            subject: state.subject,
            obligationRevision: obligation.revision,
            deadline: state.deadline,
            sourceContext,
            ...(profile ? {profile} : {}),
            facts,
            instructions,
            routingReason:route?.reason,
            demo,
            ...(demo ? {demoActorId:bindingActor} : {}),
            autonomous:state.autonomous ?? false,
            ...(obligation.proposal ? { proposal: obligation.proposal } : {}),
            ...(contact.kind === "verify_request"
              ? { claim: obligation.reply }
              : {}),
          }),
        ),
      ],
      tx,
    ),
  );
  if (result.length)
    await query(
      "UPDATE coordination_contacts SET delivery_status='channel_intent' WHERE id=CAST(:id AS uuid)",
      [param("id", contactId)],
      tx,
    );
  return result[0]?.id ?? null;
}

export function contactCurrent(state: CaseState, d: Delivery) {
  if(d.request.contact.kind==="source_question")return !["completed","cancelled","handed_off"].includes(state.status)&&!!state.sourceQuestions?.some(q=>q.id===d.request.contact.sourceQuestionId&&!q.answer);
  if(d.request.contact.kind==="operator_attention")return ["blocked","paused"].includes(state.status)&&!!state.attentionReason;
  const o = state.obligations.find((o) => o.id === d.obligation_id);
  if(d.request.contact.kind === "decision_update") return ["active","blocked"].includes(state.status) && !state.takeoverBy && !!state.decisionNotices?.some(n=>n.withdrawn && n.obligationId===d.obligation_id && n.actorId===d.actor_id && n.decisionId===d.request.contact.decisionId && n.decisionHash===d.request.contact.decisionHash);
  const decision=d.request.contact.decisionId ? state.obligations.find(n=>n.id===d.request.contact.decisionId) : undefined;
  if(d.request.contact.kind==="decision_notice" && (!decision?.proposal || decision.decision?.choice!=="approve" || !["accepted","verified"].includes(decision.status) || decision.proposal.sha256!==d.request.contact.decisionHash || !decision.reply || Date.parse(decision.reply.validUntil)<=Date.now())) return false;
  return (
    !!o && !o.skipped &&
    state.status === "active" &&
    !state.takeoverBy &&
    Date.parse(state.deadline) > Date.now() &&
    o.revision === d.obligation_revision &&
    (d.request.contact.kind === "verify_request"
      ? o.status === "answered" &&
        o.reply?.revision === d.request.contact.replyRevision
      : o.assignee === d.actor_id && (o.status === "waiting" || d.request.contact.kind==="decision_notice"))
  );
}

/** Demo identity is explicitly snapshotted by configuration, never inferred from message text. */
export function bindingMatches(d:Delivery,b:Binding) {
  const request=decode(d.request);
  return b.enabled && (d.actor_id===b.actor_id || (request.demo===true && request.demoActorId===b.actor_id));
}

/** A definitive failure may use one other consented channel. Unknown sends never fall back. */
export async function fallbackDelivery(tenant: string, id: string) {
  return transaction(tenant, async (tx) => {
    const d = rows<Delivery & { reason: string }>(
      await query(
        "SELECT * FROM channel_deliveries WHERE id=CAST(:id AS uuid)",
        [param("id", id)],
        tx,
      ),
    )[0];
    if (
      !d ||
      d.status !== "blocked" ||
      ![
        "provider_rejected",
        "provider_delivery_failed",
        "whatsapp_session_or_approved_template_required",
        "template_verification_unavailable",
        "message_size_limit",
      ].includes(d.reason)
    )
      return null;
    const settings = rows<{
      configuration: { automaticFallback: boolean } | string;
    }>(
      await query(
        "SELECT configuration FROM product_settings WHERE connection_id=CAST(:source AS uuid)",
        [param("source", d.connection_id)],
        tx,
      ),
    )[0];
    if (!settings || !decode(settings.configuration).automaticFallback)
      return null;
    const c = rows<{ snapshot: CaseState | string }>(
      await query(
        "SELECT snapshot FROM coordination_cases WHERE id=CAST(:case AS uuid) FOR UPDATE",
        [param("case", d.case_id)],
        tx,
      ),
    )[0];
    const p = rows<{ policy: Policy | string }>(
      await query(
        "SELECT policy FROM coordination_policies WHERE connection_id=CAST(:source AS uuid)",
        [param("source", d.connection_id)],
        tx,
      ),
    )[0];
    d.request = decode(d.request);
    if (
      !c ||
      !p ||
      decode(c.snapshot).configurationVersion !== decode(p.policy).version ||
      !contactCurrent(decode(c.snapshot), d) ||
      !decode(p.policy).actors.some((a) => a.id === d.actor_id && a.enabled)
    )
      return null;
    const prior = rows(
      await query(
        "SELECT id FROM channel_deliveries WHERE contact_id=CAST(:contact AS uuid) AND id<>CAST(:id AS uuid)",
        [param("contact", d.contact_id), param("id", id)],
        tx,
      ),
    );
    if (prior.length) return null;
    const next = rows<Binding>(
      await query(
        "SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND actor_id=:actor AND enabled AND channel<>:channel ORDER BY priority,id LIMIT 1",
        [
          param("source", d.connection_id),
          param("actor", d.request.demoActorId ?? d.actor_id),
          param("channel", d.channel),
        ],
        tx,
      ),
    )[0];
    if (!next) return null;
    return createDelivery(
      tenant,
      decode(c.snapshot),
      d.contact_id,
      d.request.contact,
      tx,
      next.id,
    );
  });
}
