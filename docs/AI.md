# Bounded coordination agent

This release adds autonomous execution and retains an explicit review mode for the bounded Bedrock agent. See [autonomous runtime behavior and current gaps](AUTONOMOUS_COORDINATION.md). Earlier live email/model exercises used review mode; they do not establish general unattended accuracy. See [acceptance evidence](ACCEPTANCE.md). A deployment health response is not evidence that a model selected a correct action.

## Responsibilities

The agent observes a canonical case and original evidence, chooses whether to retrieve approved knowledge, observes the search result and proposes one next step. Its choices can introduce a prerequisite question, link existing dependencies, request a fresh answer, suggest an eligible reassignment or request a source report. It can instead wait or request review. This is a bounded tool-selection loop, not a model that owns the workflow database or a fixed classifier that always sends the same next message.

Autonomous mode applies grounded proposals through deterministic authorization without an internal operator click; uncertainty blocks business effects but permits scoped questions. Explicit review mode still requires exact-proposal operator review. Neither schema validation nor a model can guarantee meaning. Graph, role, version, consent and outcome checks apply in both modes. The review diagram and review endpoint below describe review mode; autonomous execution uses a separate machine audit rather than inventing a human review record.

The worker has Bedrock invocation permission and may wake only the outbox relay Lambda; it has no SES or Social Messaging send permission. Autonomous missions use scoped knowledge retrieval and granular action tools; application code binds identity, versions, timing and decision hashes. Legacy review workflows retain proposal submission. The model cannot browse URLs, run code/SQL, fetch attachments, edit policies, choose credentials, approve itself or execute a factory action. The application runtime database role is shared by application modules; separate per-component database roles remain additional hardening work. Model text is never executed as SQL or code.

## Flow

```mermaid
sequenceDiagram
  participant R as Channel receiver / operator
  participant D as Database
  participant A as Agent worker
  participant B as Bedrock
  participant O as Operator
  participant C as Coordination gate
  R->>D: Durable run intent + revision + budget reservation
  D->>A: Relay dispatches SQS run ID
  A->>D: Claim run; capture current case, policy, evidence
  A->>B: Scoped context and eligible tool schemas
  B-->>A: Search approved knowledge, or select an action
  A->>D: Scoped search and immutable step observations
  A->>B: Search result when requested (bounded loop)
  B-->>A: Typed proposal, exact citations, uncertainty
  A->>D: Gate preview; persist exact proposal and hash
  alt Autonomous mode
    A->>C: Recheck versions, knowledge, authority and consent
    C->>D: Atomic command + machine audit + contact outbox
  else Explicit review mode
    O->>D: Approve exact proposal hash or reject with reason
    D->>C: Recheck versions, knowledge, authority and consent
    C->>D: Atomic command + human review + contact outbox
  end
```

Correlated, enabled-actor receipts marked `needs_review / unstructured_reply` can automatically queue receipt interpretation. Autonomous mode also queues bounded investigations after activation and meaningful accepted transitions. Unmatched, quarantined, blocked or unauthorized receipts are not interpreted into actions. Structured replies retain the deterministic path. Case investigation can also be explicitly requested through the source API. There is no periodic model polling; waiting consumes persisted state, not inference calls. Follow-up runs use durable events and admission limits, not recursive model calls inside the same worker. Report actions do not enqueue themselves.

## Model and execution limits

- Pinned model: `amazon.nova-pro-v1:0`, regional Bedrock Converse in us-east-1. Prompt/tool contract version: `coordination-autonomy-10`. Nova Lite failed targeted natural-language evaluations; Pro completed the production scenario with the same gates. Tools expose only actions eligible for the current run. Schema/grounding failures receive bounded feedback within the three-call budget. Runtime validation is mandatory; internal operator approval is specific to review mode.
- At most three serial model calls per run, one requested tool per call, 1,024 output tokens per call, 22-second provider timeout and no SDK retry. An invalid receipt interpretation asks a bounded clarification where possible; unavailable models and unsupported case planning remain unresolved. No hidden model fallback.
- Serialized model request maximum 30,000 UTF-8 bytes; original base context maximum 19,000 bytes. Overlarge originals are not silently summarized or truncated. They require operator review. Context contains bounded case-linked evidence, not all historic conversations.
- Tenant admission limits: 128 runs per rolling 24 hours; 48 per case per rolling 24 hours; 160 lifetime per case; at most two attempts for an identical case revision/receipt. Receipt interpretation and event-driven case follow-up share these limits. Failed, rejected and interrupted runs still consume admission capacity. Repeated identical searches stop the loop.
- Each run reserves a conservative 100,000-token accounting allowance; actual provider usage is recorded per completed call and cumulatively. An over-budget usage response prevents subsequent calls. The byte/call/output limits and admission counts bound requested work; the reservation is not an AWS billing cap. Unknown provider outcomes retain the allowance rather than being assumed free. No release refunds reservations within the admission window.
- Two concurrent SQS consumers; one message per invocation; worker timeout 120 seconds; queue visibility 720 seconds. Duplicate workers cannot re-run claimed inference. Interrupted runs become uncertain on redelivery after 150 seconds and require explicit operator investigation/new bounded request.

No new database, vector cluster, NAT gateway, provisioned model throughput or always-running agent is introduced. Existing Aurora/storage costs continue. Agent Lambda, SQS, logs and on-demand model use incur usage costs. Model changes require code/IAM changes and fresh evaluation; the operator cannot select an arbitrary paid model through request fields.

## Retrieval and knowledge lifecycle

Approved knowledge is a separate versioned PostgreSQL table. The authenticated operator publishes document key/version, group, title/body and effective/expiry timestamps. No corporate SOP is fabricated or silently seeded. The initial corpus is empty until approved documents are published. PostgreSQL full-text search uses the `simple` configuration and retrieves at most two documents per request within the source and permitted policy groups. It provides lexical matching, not semantic embeddings or a proven multilingual search quality guarantee.

Higher effective versions supersede older versions, including when the higher version is subsequently revoked or expires: the system does not silently fall back to an older policy. Retrieval filters revoked/not-effective/expired material. Approval rechecks every retrieved document hash, effective status, group scope and absence of a newer effective version, with publishing/revocation serialization. Knowledge cannot grant an actor a role or extend a case mission.

Stored run context and retrieval observations preserve document versions/hashes; no cross-case cache or automatic learning modifies permissions, prompts or published knowledge. Review records supply candidates for later human-curated improvement and evaluated releases. Embeddings, reranking and automatic feedback deployment are not implemented.

## Proposal integrity and authorization

The model emits a strict schema: `disposition`, `reason`, nullable `operation`, exact-quote `citations` and `uncertainties`. Proposed effects require a citation to supplied original evidence. Receipt interpretation additionally requires a citation to that receipt's normalized text. Citation matching proves that quoted text was supplied, not that its interpretation is correct. Review mode holds effect proposals for semantic review; autonomous mode rejects declared uncertainty and applies only currently authorized grounded operations. Broad autonomous semantic quality remains unmeasured.

Receipt runs act only as the original bound participant and can propose `reply`, `verify` or `add_child` within the correlated obligation. Case investigation runs use the configured coordinator and can propose `add_child`, `link_dependency`, `reopen`, `reassign` or `report`. The model cannot choose the acting identity. Existing transition rules select eligible responsibility and enforce dependencies, node/depth/contact limits, verifier independence, evidence freshness and outcome coverage. `report` does not certify completion merely because the model requests it.

Approval binds the exact proposal hash, original expected case revision, policy hash, settings revision, knowledge versions and current participant binding/contact. Changed cases, takeover, deadlines, disabled AI, revoked consent or changed knowledge block approval. A rejected proposal leaves the case unchanged. Operator-reviewed interpretations retain the participant's external evidence reference; generated text is not mislabeled as new source evidence. Approval and command application commit together. The run ID equals the journal command ID, preserving the link from review to effect.

## Operator API

All routes require the source principal's existing AWS SigV4 authorization; this is the configured operator of a synthetic installation, not production human SSO. Use `scripts/coordinate.mjs` with the base API URL and credentials. Private request files may contain sensitive information and must not be committed.

| Method/path | Body or result |
| --- | --- |
| `POST /v1/cases/{caseId}/agent` | `{ "requestId": "<UUID>", "receiptId": "<optional receipt UUID>" }`; durable run or explicit disabled/budget/no-progress outcome |
| `GET /v1/cases/{caseId}/agent` | Last 50 runs, proposal hashes, reasons and usage |
| `GET /v1/ai/runs/{runId}` | Captured context, proposed output, tool/retrieval observations and review |
| `POST /v1/ai/runs/{runId}/review` | `{ "proposalHash": "<exact SHA-256>", "disposition": "approve", "reason": "<semantic/authority review rationale>" }`; use `reject` to reject |
| `GET /v1/ai/settings` | Enabled flag, automatic receipt flag, revision |
| `POST /v1/ai/settings` | `{ "enabled": false, "autoReceipts": false, "expectedRevision": 1 }`; disables future work and invalidates outstanding approvals |
| `GET /v1/ai/knowledge` | Last 100 document versions, hashes, validity and revocation status |
| `POST /v1/ai/knowledge` | Publish or revoke using the contract below |

Publishing an approved synthetic procedure, with timestamps chosen for the intended validity period:

```json
{
  "action": "publish",
  "documentKey": "material_readiness",
  "version": 1,
  "group": "quality",
  "title": "Material quarantine and usable stock",
  "body": "Synthetic exercise guidance: physical stock and usable stock are distinct. For quarantined material, ask the quality owner for the current inspection evidence. Do not infer release from arrival or quantity alone. The source retains the operational decision.",
  "effectiveAt": "2026-10-19T00:00:00Z",
  "expiresAt": "2026-12-01T00:00:00Z"
}
```

Revoke with `{ "action": "revoke", "id": "<document UUID>", "reason": "<reason>" }`. Publishing/revocation and settings changes are audited with the authenticated principal. Schema 9 selects autonomous execution and increments existing settings revisions so earlier proposals become stale. Review mode can be explicitly configured. A permitted effect may create a channel delivery intent; consent and current send-time checks still apply. See [autonomous runtime](AUTONOMOUS_COORDINATION.md).

## Recovery, privacy and evaluation limits

The database remains canonical. Invalid model output, tool repetition, missing facts, budget exhaustion, provider failure or stale context yields review/blocked work, never fabricated evidence. A missed relay wake can be retried by later activity; scheduled reconciliation, stage controls and audited operator recovery are implemented; see [operations](OPERATIONS.md). Do not directly rewrite run state to retry an uncertain call. Preserve traces and use a fresh request ID within the unchanged admission limits after investigating.

Steps record requested tools, hashes, concise model-supplied reasons, provider usage and timing; private chain-of-thought blocks are not stored. Sensitive run context lives in tenant-scoped database records, not public logs. Context minimization/PII handling, per-component database privileges, configurable trace retention/deletion need further hardening before a customer rollout. Original channel objects are retained for explicit case-aware policy review rather than blanket expiry; historical expiry or object loss still cannot be repaired by retaining a hash.

Broader evaluation still required: ordinary and surprising prerequisites; Bangla/English negation, units and temporal qualifiers; prompt injection in messages/SOPs; unsupported claims; retrieval absence/conflict/revocation; wrong actor/group; stale proposal and takeover races; duplicate queue delivery; unknown inference outcome; no-progress/cost limits; human rejection; required child silence; false closure; cross-channel continuation. Compare with deterministic coordination using equal evidence. Measure useful outcomes, unsupported effects, unnecessary contacts, latency, tokens and review burden. No general accuracy percentages are claimed. Targeted observations are recorded separately in the acceptance report.

Implementation references checked 19 October 2026: [Bedrock client-side tool use](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use-client-side.html), [Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [Nova tool definitions](https://docs.aws.amazon.com/nova/latest/userguide/tool-use-definition.html). A direct serial SDK loop preserves the application's existing state and effect boundary; no second agent/session engine is required.

Operator identity now uses Cognito JWT plus server-side source membership; see [operator workspace](OPERATOR_WORKSPACE.md). New administrative and bound-decision operations are outside the agent action allowlist.

## Authored messages and immutable originals

Full incoming text, including quoted email history, remains immutable evidence. A separately marked authored-message view removes recognised quoted history before interpretation, so an old request is not treated as a new instruction. Original evidence hashes remain available. Citation grounding permits whitespace differences caused by MIME wrapping; it preserves words, punctuation, quantities and negation. Unknown formatting or an unsupported interpretation still requires review. A deterministic gate rejects duplicate questions for the same department.

## Partial replies and continuation

Prompt `coordination-autonomy-13` asks the model to record clearly reported partial facts even when another required field is absent. Application code merges only unexpired facts from the same actor and subject revision, retaining each original evidence ID, report time and expiry. A later date-only reply cannot refresh earlier quantity evidence. Correction/withdrawal, rerouting and source changes invalidate retained facts and dependent decisions. A conditional approval triggers clarification of the existing exact proposal and does not create an approval. Proposal quantities and dates require supporting citations, including quarantine/reservation conditions. These controls bound effects; they do not establish universal semantic accuracy.

Conditional decision language is rejected for both approval and rejection: a missing approval on a separate condition is not a rejection of the current proposal. Explicit externally owned prerequisites take priority over recording an empty answer. Non-decision child tasks cannot inherit model-supplied decision proposal metadata.
