import { z } from "zod";
import { factSchema, type Fact } from "../../contracts/src/communication.js";
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().min(1).max(1000);
export const operationSchema = z.discriminatedUnion("type", [
  z.strictObject({type:z.literal("continue_plan"),reason:text}),
  z.strictObject({type:z.literal("clarify_attention"),question:text,reason:text}),
  z.strictObject({type:z.literal("source_query"), questionId:id, question:text}),
  z.strictObject({type:z.literal("source_response"), questionId:id, answer:text}),
  z.strictObject({type:z.literal("route_initial"), obligationId:id, group:id, question:text,channel:z.enum(["email","whatsapp"]).optional(),channelReason:text.optional()}),
  z.strictObject({type:z.literal("clarify"), obligationId:id, question:text, reason:text,discardFacts:z.boolean().optional(),channel:z.enum(["email","whatsapp"]).optional(),channelReason:text.optional()}),
  z.strictObject({type:z.literal("extend_deadline"),deadline:z.iso.datetime({offset:true}),reason:text}),
  z.strictObject({type:z.literal("satisfy_from"),obligationId:id,evidenceTaskId:id,reason:text}),
  z.strictObject({type:z.literal("skip_optional"),obligationId:id,reason:text}),
  z.strictObject({type:z.literal("select_channel"),obligationId:id,channel:z.enum(["email","whatsapp"]),reason:text}),
  z.strictObject({type:z.literal("reroute"), obligationId:id, group:id, reason:text}),
  z.strictObject({type:z.literal("relay_decision"), obligationId:id, decisionId:id}),
  z.strictObject({
    type: z.literal("attach_proposal"),
    obligationId: id,
    proposalId: id,
    proposalRevision: z.number().int().positive(),
    statement: text,
    reason: text,
  }),
  z.strictObject({
    type: z.literal("decide"),
    obligationId: id,
    expectedObligationRevision: z.number().int().positive(),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    choice: z.enum(["approve", "reject"]),
    reason: text,
    subjectRevision: z.string().min(1).max(160),
    observedAt: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }),
    timeBasis: z.enum(["observed", "received"]).optional(),
  }),
  z.strictObject({
    type: z.literal("adopt_configuration"),
    version: text,
    reason: text,
  }),
  z.strictObject({
    type: z.literal("amend_subject"),
    subjectRevision: z.string().min(1).max(160),
    goal: text,
    reason: text,
  }),
  z.strictObject({
    type: z.literal("reply"),
    obligationId: id,
    expectedObligationRevision: z.number().int().positive(),
    statement: text,
    observedAt: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }),
    timeBasis: z.enum(["observed", "received"]).optional(),
    facts: z.array(factSchema).max(12).optional(),
    restrictions: z.array(z.string().min(1).max(1000)).max(12).optional(),
    withdrawRestrictions:z.array(z.string().min(1).max(1000)).max(12).optional(),
    corrects: z.array(id).max(12).optional(),
    progress: z.enum(["in_progress", "ready"]).optional(),
    statusQuote: z.string().min(1).max(500).optional(),
    subjectRevision: z.string().min(1).max(160),
  }),
  z.strictObject({
    type: z.literal("verify"),
    obligationId: id,
    replyRevision: z.number().int().positive(),
    accept: z.boolean(),
    reason: text,
  }),
  z.strictObject({
    type: z.literal("add_child"),
    parentId: id,
    obligationId: id,
    group: id,
    question: text,
    kind: z.enum([
      "fact",
      "decision",
      "acknowledgement",
      "evidence",
      "commitment",
      "completion",
    ]),
    proposalStatement: text.optional(),
  }),
  z.strictObject({
    type: z.literal("link_dependency"),
    obligationId: id,
    dependencyId: id,
  }),
  z.strictObject({
    type: z.literal("reassign"),
    obligationId: id,
    actorId: id,
    reason: text,
  }),
  z.strictObject({ type: z.literal("reopen"), obligationId: id, reason: text }),
  z.strictObject({ type: z.literal("pause"), reason: text }),
  z.strictObject({ type: z.literal("resume"), reason: text }),
  z.strictObject({ type: z.literal("takeover"), reason: text }),
  z.strictObject({ type: z.literal("release"), reason: text }),
  z.strictObject({ type: z.literal("cancel"), reason: text }),
  z.strictObject({ type: z.literal("handoff"), reason: text }),
  z.strictObject({ type: z.literal("report"), reason: text }),
]);
export const commandSchema = z.strictObject({
  commandId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  actorId: id,
  operation: operationSchema,
});
export const acknowledgementSchema = z.strictObject({
  acknowledgementId: z.uuid(),
  resultId: z.uuid(),
  disposition: z.enum(["accepted", "rejected"]),
  reason: text,
});
export type Operation = z.infer<typeof operationSchema>;
export interface Actor {
  id: string;
  group: string;
  role: "respondent" | "verifier" | "coordinator";
  enabled: boolean;
  name?: string;
  capabilities?: string[];
  scope?: string[];
  approvalScopes?: string[];
  preferredChannel?: "email" | "whatsapp";
  workingHours?: string;
  backupActorId?: string;
}
export interface Policy {
  version: string;
  actors: Actor[];
  groups: string[];
  deadlineSeconds: number;
  reminderSeconds: number;
  maxReminders: number;
  maxContacts: number;
  maxNodes: number;
  maxDepth: number;
  evidenceAgeSeconds: number;
  autoExtendSeconds?: number;
  maxExtensions?: number;
  supervisorActorId?: string;
}
export interface Reply {
  revision: number;
  evidenceId: string;
  actorId: string;
  statement: string;
  observedAt: string;
  validUntil: string;
  subjectRevision: string;
  timeBasis?: "observed" | "received";
  facts?: ReportedFact[];
  restrictions?: {text:string;actorId:string;evidenceId:string}[];
  progress?: "in_progress" | "ready";
  statusQuote?: string;
}
export interface Obligation {
  preferredChannel?: "email" | "whatsapp";
  channelReason?: string;
  optional?: boolean;
  skipped?: {reason:string;evidenceId:string};
  satisfiedFrom?: string;
  conflicts?: {key:string;previous:ReportedFact;incoming:ReportedFact}[];
  retainedRestrictions?: {text:string;actorId:string;evidenceId:string}[];
  retainedFacts?: ReportedFact[];
  id: string;
  group: string;
  kind: string;
  question: string;
  required: boolean;
  dependencies: string[];
  assignee: string;
  revision: number;
  status: "waiting" | "answered" | "accepted" | "verified" | "disputed" | "blocked";
  acceptance?: "responsible_reply" | "independent";
  requiredFacts?: string[];
  clarificationCount?: number;
  relayKeys?: string[];
  proposal?: {
    id: string;
    revision: number;
    statement: string;
    subjectRevision: string;
    sha256: string;
    evidenceId: string;
  };
  decision?: {
    proposalHash: string;
    choice: "approve" | "reject";
    reason: string;
    actorId: string;
    evidenceId: string;
  };
  reply?: Reply;
  verification?: {
    actorId: string;
    evidenceId: string;
    replyRevision: number;
    at: string;
  };
  reminders: number;
  escalated: boolean;
  verificationRequested?: boolean;
  nextContactAt: string;
}
export type ReportedFact = Fact & {evidenceId:string;actorId:string;subjectRevision:string;reportedAt:string;validUntil:string};
export interface CaseState {
  extensions?: number;
  attentionReason?: string;
  businessDeadline?: string;
  attentionNotified?: string;
  autonomous?: boolean;
  awaitingPlan?: boolean;
  planningPending?:boolean;
  supervisorClarifications?:number;
  sourceQuestions?: {id:string;question:string;answer?:string;evidenceId?:string}[];
  decisionNotices?: {decisionId:string;decisionHash:string;obligationId:string;actorId:string;withdrawn?:boolean}[];
  id: string;
  revision: number;
  inboxId: string;
  sourceEvidenceId: string;
  missionRevision?: number;
  amendmentEvidenceIds?: string[];
  sourceId: string;
  subject: { type: string; id: string; revision: string };
  workflow: string;
  configurationVersion: string;
  origin: "simulated";
  status:
    | "active"
    | "paused"
    | "blocked"
    | "completed"
    | "cancelled"
    | "handed_off";
  goal: string;
  createdAt: string;
  deadline: string;
  contacts: number;
  takeoverBy?: string;
  obligations: Obligation[];
}
export interface Contact {
  obligationId: string;
  actorId: string;
  kind: "ask" | "reminder" | "escalation" | "verify_request" | "decision_notice" | "decision_update" | "source_question" | "operator_attention";
  sourceQuestionId?: string;
  decisionId?: string;
  decisionHash?: string;
  replyEvidenceId?: string;
  replyRevision?: number;
  question: string;
  subject: CaseState["subject"];
  sourceEvidenceId: string;
  origin: "simulated";
}
export interface Outcome {
  outcome: "completed" | "in_progress" | "partial" | "blocked" | "cancelled" | "handed_off";
  terminal: boolean;
  requirements: { id: string; status: string; evidenceIds: string[] }[];
  unresolvedObligationIds: string[];
  scope: "communication_only";
  origin: "simulated";
}
export class CoordinationError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
