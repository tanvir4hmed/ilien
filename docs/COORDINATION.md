# Deterministic coordination API

This release implements coordination without a model or live communication provider. Every participant is a **simulated role**, selected by the authenticated demo source. This is a simulator capability, not production human authentication, delegation or proof of a real person's identity. Only a server-configured, enabled simulated connection with a coordination policy can use it. Never enable this capability for an untrusted client.

## Activation and scope

Submit `packages/contracts/examples/material-readiness.event.json` through the existing signed event endpoint. A validated `1.0` payload activates four required branches: stores, quality, planning and procurement. Each begins with a simulated ask. `revision-acknowledgement.event.json` activates production and quality acknowledgement branches for an exact revision. The `planning.upstream_supply_shifted` alias requires the same material payload contract. Minimal catalogue payloads, missing revisions and unknown events remain triage; they do not create guessed workflows. Newly created events activate workflows; historical processed intake is not replayed automatically.

The configured source/site is a synthetic demo. Domain templates live in `packages/domain-packs`; generic state transitions live in `packages/coordination`. `coordination_policies` stores server-owned settings, actor eligibility and bounds. No caller can publish a policy through the API. Configuration version mismatch requires review; it is not silently adopted by an active case.

## Access and CLI

Use the configured AWS IAM demo source and set `ILIEN_API_URL` and `AWS_REGION`. `scripts/coordinate.mjs` signs requests; it does not embed credentials.

```sh
node scripts/coordinate.mjs GET /v1/cases
node scripts/coordinate.mjs GET /v1/cases/CASE_UUID
node scripts/coordinate.mjs GET /v1/cases/CASE_UUID/policy
node scripts/coordinate.mjs POST /v1/cases/CASE_UUID/commands command.json
node scripts/coordinate.mjs GET /v1/cases/CASE_UUID/results
node scripts/coordinate.mjs POST /v1/cases/CASE_UUID/acknowledgements acknowledgement.json
```

Other read sections: `contacts`, `claims`, `journal`, `rejections`. `GET /v1/cases/CASE_UUID/evidence/EVIDENCE_UUID` returns original content and hash only when evidence is linked to that source's case. Case and source ownership are checked in addition to transaction-local tenant RLS. Lists return the latest 50 records; full retained history currently requires authorized database access. No browser UI is included.

## Commands

Every command has a unique UUID, the current `expectedRevision`, an eligible simulated `actorId`, and an operation. Same command ID and exact bytes return the prior accepted revision; changed content under that ID conflicts. A stale case revision returns 409; refresh the case before making a new command. Duplicate results distinguish the originally accepted revision from the current revision. Important rejected commands are retained separately with original evidence and a reason code.

Example shape (replace UUID and revisions using the current case; choose current evidence timestamps):

```json
{
  "commandId": "3ac7823e-a7ab-4b8b-8230-1999088e9801",
  "expectedRevision": 1,
  "actorId": "stores_owner",
  "operation": {
    "type": "reply",
    "obligationId": "root_1",
    "expectedObligationRevision": 1,
    "statement": "Reported usable stock is 1200 metres; confirmation is required.",
    "observedAt": "2026-10-16T04:00:00Z",
    "validUntil": "2026-10-16T05:00:00Z",
    "subjectRevision": "1"
  }
}
```

| Operation | Fields beyond `type` | Authority and behavior |
| --- | --- | --- |
| `reply` | `obligationId`, `expectedObligationRevision`, `statement`, `observedAt`, `validUntil`, `subjectRevision` | Exact current assignee; records a claim, not verified truth. A correction invalidates dependent claims/verification. |
| `verify` | `obligationId`, `replyRevision`, `accept`, `reason` | Enabled group verifier independent of reporter; exact fresh reply, exact subject revision, all prerequisites verified. Rejecting marks a dispute. |
| `add_child` | `parentId`, `obligationId`, `group`, `question`, `kind` | Parent respondent or coordinator; group must be in service scope. Child is required and must finish before parent verification. |
| `link_dependency` | `obligationId`, `dependencyId` | Coordinator; existing nodes only, rejects cycles and depth overflow. |
| `reassign` | `obligationId`, `actorId`, `reason` | Coordinator; same responsibility group and eligible respondent; invalidates prior dependent evidence. |
| `pause` / `resume` | `reason` | Coordinator; stops/resumes asks. Absolute deadlines and evidence expiry still apply. |
| `takeover` / `release` | `reason` | Coordinator; holds autonomous contacts while allowing authorized manual replies/verification. Deadlines remain active. |
| `reopen` | `obligationId`, `reason` | Coordinator; invalidates the selected branch and ancestors, creates a new case revision and resets the configured deadline. Cancelled/handed-off cases cannot reopen. |
| `report` | `reason` | Coordinator; explicit nonterminal partial/blocked report. Never waives required evidence. |
| `cancel` / `handoff` | `reason` | Coordinator; terminal result and stops future contact/timer work. Handoff reports transfer needed; it does not claim another system accepted ownership. |

Kinds: `fact`, `decision`, `acknowledgement`, `evidence`, `commitment`. These describe communication requirements. Textual decisions do not become executable approvals; formal `decisionRefs` remain empty in this release.

## State and proof

A reply moves an obligation to `answered`. It triggers a simulated verification request once prerequisites are verified. Verification records the exact reply revision and verifier evidence. Changes to a prerequisite invalidate all ancestors that may depend on it; originals remain in the immutable evidence and claim/journal tables. A child answer does not automatically finish its parent: the parent must supply a fresh answer and verification after prerequisites finish.

Cases complete only when every required obligation is verified and current at that transition. Verification here means an authorized simulated independent attestation, not measured physical truth or semantic proof. The source objective and subject revision are fixed within a case; a different source revision requires a new source event/case. Completed cases require explicit reopening before corrections; previously issued results remain historical.

Results follow the versioned coordination-result shape: mission/case IDs and revisions, outcome, terminal flag, requirement evidence, unresolved obligations and a communication-only limitation. The case is the single mission in this release. Results are stored atomically with the transition and are available by authenticated polling. No arbitrary HTTP callback or operational command is issued. A later case revision supersedes earlier results.

```json
{
  "acknowledgementId": "822b96b6-e168-4f04-ab14-99418b8dc41a",
  "resultId": "RESULT_UUID",
  "disposition": "accepted",
  "reason": "Source received this result; business actions remain source-owned."
}
```

One accepted/rejected acknowledgement is stored per result, independently from coordination completion. Exact retries are idempotent. A first acknowledgement of a superseded result is rejected; repeating a previously committed acknowledgement only returns its receipt.

## Time, cost and failure behavior

Defaults: one-hour deadline, five-minute contact interval, one reminder followed by one eligible fallback escalation, 64 total contacts, 32 obligations, depth five and one-hour evidence validity. Statements/questions are limited to 1000 characters. Case snapshots are limited to 30,000 serialized bytes; larger changes require handoff rather than silent truncation. A 500-revision budget stops further ordinary mutations; the timer hands off and records an outcome. These are bounded demo defaults, not measured production capacity.

Timers use a separate SQS queue/worker and durable `coordination_jobs`. A worker wake checks the current case revision; obsolete wakes do nothing. Delays above SQS's 15-minute per-message limit are continued as fresh durable jobs. No model runs while waiting. No active cases means no timer loop. Long-lived active cases still incur queue/Lambda/database costs and can reduce Aurora auto-pause savings.

API commands and initial intake commit work before requesting relay wake. Retry a failed response using the same command bytes: the committed command is not replayed, and the wake is retried. Worker wake failures return a failed SQS batch item. Relay leases recover interrupted dispatch when re-invoked. A wholly exhausted async relay retry still needs authorized manual reconciliation; scheduled global reconciliation is not implemented. The relay processes at most 25 jobs of each lane per invocation. Dead-letter and backlog handling follow the runbook. No globally exactly-once external delivery is claimed.

Database updates serialize on the case row, use optimistic expected revisions and commit snapshot, relational obligation/dependency projections, immutable journal/claims, contacts, results and timer intents together. No model/network call happens inside that transaction. Source originals are never overwritten. The snapshot is the authoritative aggregate; relational summaries are projections updated in the same transaction. Cross-case dependencies and arbitrary workflow migration are not supported in this release.

## Verification status

Application tests and live event-flow checks are deferred by the owner. No runtime correctness, load, isolation, semantic accuracy, real channel delivery or model quality claim follows from compilation/deployment. Required later checks include nested joins, stale correction, expired evidence, denied roles, missing children, queue/wake failures, cancellation, replay, source acknowledgement and tenant isolation.
