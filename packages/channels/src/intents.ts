import { randomBytes, randomUUID } from "node:crypto";
import { param, query, rows } from "../../persistence/src/database.js";
import {
  CoordinationError,
  type CaseState,
  type Contact,
} from "../../coordination/src/types.js";

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
  const bindings = rows<Binding>(
    await query(
      `SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND actor_id=:actor AND enabled ${bindingId ? "AND id=CAST(:binding AS uuid)" : ""} ORDER BY priority,id LIMIT 1`,
      [
        param("source", state.sourceId),
        param("actor", contact.actorId),
        ...(bindingId ? [param("binding", bindingId)] : []),
      ],
      tx,
    ),
  );
  const binding = bindings[0];
  if (!binding) {
    if (bindingId)
      throw new CoordinationError("consented_binding_required", 403);
    return null;
  }
  const obligation = state.obligations.find(
    (o) => o.id === contact.obligationId,
  );
  if (!obligation) throw new CoordinationError("obligation_not_found", 404);
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
            subject: state.subject,
            obligationRevision: obligation.revision,
            deadline: state.deadline,
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
  const o = state.obligations.find((o) => o.id === d.obligation_id);
  return (
    !!o &&
    state.status === "active" &&
    !state.takeoverBy &&
    Date.parse(state.deadline) > Date.now() &&
    o.revision === d.obligation_revision &&
    (d.request.contact.kind === "verify_request"
      ? o.status === "answered" &&
        o.reply?.revision === d.request.contact.replyRevision
      : o.assignee === d.actor_id && o.status === "waiting")
  );
}
