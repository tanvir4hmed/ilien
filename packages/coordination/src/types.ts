import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().min(1).max(1000);
export const operationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("reply"),
    obligationId: id,
    expectedObligationRevision: z.number().int().positive(),
    statement: text,
    observedAt: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }),
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
    ]),
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
}
export interface Reply {
  revision: number;
  evidenceId: string;
  actorId: string;
  statement: string;
  observedAt: string;
  validUntil: string;
  subjectRevision: string;
}
export interface Obligation {
  id: string;
  group: string;
  kind: string;
  question: string;
  required: boolean;
  dependencies: string[];
  assignee: string;
  revision: number;
  status: "waiting" | "answered" | "verified" | "disputed" | "blocked";
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
export interface CaseState {
  id: string;
  revision: number;
  inboxId: string;
  sourceEvidenceId: string;
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
  kind: "ask" | "reminder" | "escalation" | "verify_request";
  replyEvidenceId?: string;
  replyRevision?: number;
  question: string;
  subject: CaseState["subject"];
  sourceEvidenceId: string;
  origin: "simulated";
}
export interface Outcome {
  outcome: "completed" | "partial" | "blocked" | "cancelled" | "handed_off";
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
