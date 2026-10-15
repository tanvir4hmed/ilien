/** ILIEN v1 wire contracts. Runtime validation is required at every trust boundary. */
export type ContractVersion = "1.0";
export type Id = string;
/** RFC 3339 instant with explicit UTC offset; retain business timezone separately. */
export type Instant = string;
export type Channel = "whatsapp" | "email" | "sms" | "rcs" | "web";
export type Intent = "collect_facts" | "clarify" | "obtain_decision" |
  "acknowledge_revision" | "verify_evidence" | "collect_commitment" | "handoff";

/** Supplied by the caller. Contains no trusted tenant or simulation assertion. */
export interface SourceEvent {
  readonly contractVersion: ContractVersion;
  readonly eventId: Id;
  readonly eventType: string;
  readonly payloadVersion: string;
  readonly occurredAt: Instant;
  readonly correlationId: Id;
  readonly causationEventId?: Id;
  readonly subject: { readonly type: string; readonly id: Id; readonly revision?: string };
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Created by authenticated intake, never deserialized from the caller's body. */
export interface AcceptedEvent {
  readonly inboxId: Id;
  readonly tenantId: Id;
  readonly sourceConnectionId: Id;
  readonly receivedAt: Instant;
  readonly origin: "simulated" | "external";
  readonly originalEvidenceId: Id;
  readonly originalSha256: string;
  readonly event: SourceEvent;
}

export type IntakeDisposition = "create_mission" | "amend_case" | "attach_evidence" |
  "record_only" | "ignore_by_policy" | "triage";

export interface EvidenceRef {
  readonly evidenceId: Id;
  readonly revision: number;
  /** Optional exact excerpt location; never invented model-only evidence. */
  readonly locator?: string;
}

export interface Scope {
  readonly siteIds: readonly Id[];
  readonly organizationalUnitIds: readonly Id[];
  readonly subjectRefs: readonly { readonly type: string; readonly id: Id }[];
}

export interface CompletionRequirement {
  readonly requirementId: Id;
  readonly kind: "fact" | "decision" | "acknowledgement" | "evidence" | "commitment";
  readonly description: string;
  readonly required: boolean;
  /** Published server policy identifiers, resolved in the authenticated scope. */
  readonly authorityRuleId: Id;
  readonly verificationRuleId: Id;
  readonly maxEvidenceAgeSeconds?: number;
  readonly proposalRef?: { readonly proposalId: Id; readonly revision: number };
}

/** Immutable version; modifications create an explicitly authorized new version. */
export interface Mission {
  readonly contractVersion: ContractVersion;
  readonly missionId: Id;
  readonly tenantId: Id;
  readonly sourceConnectionId: Id;
  readonly triggeringInboxId: Id;
  readonly serviceScopeId: Id;
  readonly definitionVersion: string;
  readonly configurationVersion: string;
  readonly revision: number;
  readonly goal: string;
  readonly intent: Intent;
  readonly accountableActorId: Id;
  readonly scope: Scope;
  readonly deadline: Instant;
  readonly businessTimezone: string;
  readonly requirements: readonly CompletionRequirement[];
  readonly initialEvidence: readonly EvidenceRef[];
  readonly limits: {
    readonly maxContacts: number;
    readonly maxRemindersPerObligation: number;
    readonly maxAgentStepsPerInvocation: number;
    readonly maxTotalModelTokens: number;
    readonly maxDependencyDepth: number;
  };
  readonly deadlinePolicy: "report_blocked" | "report_partial" | "escalate_handoff";
  /** Registered destination identifier; never an arbitrary callback URL. */
  readonly resultDestinationId: Id;
}

export interface MissionCommand {
  readonly contractVersion: ContractVersion;
  readonly commandId: Id;
  readonly missionId: Id;
  readonly expectedRevision: number;
  readonly issuedAt: Instant;
  readonly reason: string;
  readonly operation:
    | { readonly type: "amend"; readonly replacementMission: Mission }
    | { readonly type: "cancel" }
    | { readonly type: "pause" }
    | { readonly type: "resume" };
}

export type RequirementStatus = "satisfied" | "missing" | "conflicting" |
  "expired" | "rejected" | "not_required";

/** A communication outcome, never an implicit instruction to mutate source state. */
export interface CoordinationResult {
  readonly contractVersion: ContractVersion;
  readonly resultId: Id;
  readonly resultRevision: number;
  readonly supersedesResultId?: Id;
  readonly missionId: Id;
  readonly missionRevision: number;
  readonly caseId: Id;
  readonly caseRevision: number;
  readonly generatedAt: Instant;
  readonly outcome: "completed" | "partial" | "blocked" | "rejected" |
    "cancelled" | "handed_off";
  readonly missionTerminal: boolean;
  readonly summary: string;
  readonly requirements: readonly {
    readonly requirementId: Id;
    readonly status: RequirementStatus;
    readonly evidence: readonly EvidenceRef[];
    readonly reasonCode: string;
  }[];
  readonly unresolvedObligationIds: readonly Id[];
  readonly decisionRefs: readonly {
    readonly decisionId: Id;
    readonly proposalId: Id;
    readonly proposalRevision: number;
    readonly authorizedActorId: Id;
    readonly validUntil: Instant;
  }[];
  readonly handoffRef?: Id;
}

/** Separate from coordination status and from transport acceptance. */
export interface ResultAcknowledgement {
  readonly contractVersion: ContractVersion;
  readonly acknowledgementId: Id;
  readonly resultId: Id;
  readonly resultRevision: number;
  readonly receivedAt: Instant;
  readonly disposition: "accepted" | "rejected";
  readonly reasonCode: string;
}
