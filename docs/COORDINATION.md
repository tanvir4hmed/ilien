# Deterministic coordination API

The deterministic core applies authorized state transitions independently of model/provider availability. The authenticated source API also supports labelled simulated role-play; this is privileged simulator access, not proof of a real employee's identity. Actual channel replies use configured consented participant bindings. The bounded agent uses the same core through its execution gate. See [autonomous mission behavior](AUTONOMOUS_COORDINATION.md).

## Activation and scope

Submit `packages/contracts/examples/material-readiness.event.json` through the existing signed event endpoint. A validated `1.0` payload activates four required branches: stores, quality, planning and procurement. Each begins with a simulated ask. `revision-acknowledgement.event.json` activates production and quality acknowledgement branches for an exact revision. The `planning.upstream_supply_shifted` alias requires the same material payload contract. Minimal catalogue payloads, missing revisions and unknown events remain triage; they do not create guessed workflows. Newly created events activate workflows; historical processed intake is not replayed automatically.

The configured source/site is a synthetic sample. Domain templates live in `packages/domain-packs`; transitions live in `packages/coordination`. Server-owned configuration stores actor eligibility and bounds; authorized admins can preview and publish it through the configuration API. Active cases do not silently adopt a different configuration version.

## Access and CLI

Use the configured AWS IAM configured source and set `ILIEN_API_URL` and `AWS_REGION`. `scripts/coordinate.mjs` signs requests; it does not embed credentials.

```sh
node scripts/coordinate.mjs GET /v1/cases
node scripts/coordinate.mjs GET /v1/cases/CASE_UUID
node scripts/coordinate.mjs GET /v1/cases/CASE_UUID/policy
node scripts/coordinate.mjs POST /v1/cases/CASE_UUID/commands command.json
node scripts/coordinate.mjs GET /v1/cases/CASE_UUID/results
node scripts/coordinate.mjs POST /v1/cases/CASE_UUID/acknowledgements acknowledgement.json
```

Other read sections: `contacts`, `claims`, `journal`, `rejections`. `GET /v1/cases/CASE_UUID/evidence/EVIDENCE_UUID` returns original content and hash only when evidence is linked to that source's case. Case and source ownership are checked in addition to transaction-local tenant RLS. Lists return the latest 50 records; full retained history currently requires authorized database access. The [operator workspace](OPERATOR_WORKSPACE.md) exposes these records and synthetic role-play commands.

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

Kinds: `fact`, `decision`, `acknowledgement`, `evidence`, `commitment`, `completion`. Explicit decisions bind a current proposal hash through `decide`; current authorized decisions appear in `decisionRefs`. Free-form prose and silence do not grant executable authority.

## State and proof

A reply moves an obligation to `answered`. It triggers a simulated verification request once prerequisites are verified. Verification records the exact reply revision and verifier evidence. Changes to a prerequisite invalidate all ancestors that may depend on it; originals remain in the immutable evidence and claim/journal tables. A child answer does not automatically finish its parent: the parent must supply a fresh answer and verification after prerequisites finish.

Cases complete when every required obligation satisfies its configured acceptance rule and all source questions are answered. Legacy independent rules require current verifier evidence; autonomous responsible-reply rules mark supported reports accepted. Completion tracking additionally requires explicit readiness and configured fact keys. Neither rule proves physical truth. Amendments and corrections preserve history and invalidate dependent evidence. Completed cases require explicit reopening before corrections.

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

Defaults: one-hour deadline, five-minute contact interval, one reminder followed by one eligible fallback escalation, 64 total contacts, 32 obligations, depth five and one-hour evidence validity. Statements/questions are limited to 1000 characters. Case snapshots are limited to 30,000 serialized bytes; larger changes require handoff rather than silent truncation. A 500-revision budget stops further ordinary mutations; the timer hands off and records an outcome. These are bounded initial defaults, not measured production capacity.

Timers use a separate SQS queue/worker and durable `coordination_jobs`. A worker wake checks the current case revision; obsolete wakes do nothing. Delays above SQS's 15-minute per-message limit are continued as fresh durable jobs. No model runs while waiting. No active cases means no timer loop. Long-lived active cases still incur queue/Lambda/database costs and can reduce Aurora auto-pause savings.

API commands and intake commit work before relay wake. Retry a failed response using the same command bytes: committed effects are not replayed. Worker wake failures return a failed SQS batch item. Relay leases and scheduled reconciliation recover eligible interrupted work; uncertain provider outcomes remain explicit review rather than blind resend. The relay processes bounded batches. No globally exactly-once external delivery is claimed. Initial routing and missing-proposal assembly wait for event-driven model work rather than scheduling one-second ticks that invalidate that work.

Database updates serialize on the case row, use optimistic expected revisions and commit snapshot, relational obligation/dependency projections, immutable journal/claims, contacts, results and timer intents together. No model/network call happens inside that transaction. Source originals are never overwritten. The snapshot is the authoritative aggregate; relational summaries are projections updated in the same transaction. Cross-case dependencies and arbitrary workflow migration are not supported in this release.

## Verification status

Meaningful checks are authorized. Targeted deterministic suites and real-model synthetic scenarios are recorded in [acceptance evidence](ACCEPTANCE.md). Compilation/deployment alone proves neither model quality nor delivery. Broader load/isolation, adversarial interpretation, replay/crash and customer-specific integration assurance remain separate work.

## Autonomous command additions

`route_initial` starts an awaiting mission; `clarify` asks the same participant a missing question; `reroute` selects an eligible responsible group; `attach_proposal` creates exact proposed business terms; `decide` records a hash-bound authorized approval/rejection; `relay_decision` communicates current approved terms. `source_query` requests missing source data and `source_response` records the authenticated source answer. The model cannot emit `source_response` or administrative controls. All use the same command/revision envelope and immutable journal.
