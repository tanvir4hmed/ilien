# Autonomous communication coordination

ILIEN receives a source request, obtains information and authorized decisions through connected participants, adapts the conversation as replies arrive, and returns structured progress and outcomes to that source. Normal autonomous missions require no internal operator approval. Business approvals come from the assigned participant. Operational execution belongs to the source.

## Execution and responsibility

Server-owned AI settings select `autonomous` or `review`; new installations default to autonomous. Each workflow separately declares whether it is an autonomous mission. Historical workflows retain their independent-verification rules. Changing execution mode does not rewrite business acceptance policy.

The regional Bedrock Nova Pro planner selects one scoped action at a time. Granular tools expose routing, recording the current participant's answer or decision, clarification, eligible rerouting, prerequisite creation/linking, proposal assembly, approved-decision relay, source questions and waiting. Application code supplies case/actor IDs, revisions, receipt timestamps and proposal hashes. The model cannot edit policy, grant authority, answer its own source questions, execute code, or issue factory commands.

The gate rechecks evidence quotations, receipt identity, current case/settings/policy and knowledge versions, decision scope and a pure transition preview. Unresolved uncertainty cannot become a business effect; scoped questions may request missing evidence. Ambiguous replies receive bounded same-person clarification. Repeated unresolved clarification can request source attention. Model/provider failure and exhausted budgets remain unresolved work, never manufactured answers.

Original evidence, outgoing payloads, replies and effects have separate durable records. Machine execution uses `ai_executions`; review mode uses `ai_reviews`. A matching quotation is not proof of semantic correctness.

## Reusable missions

| Mission | Behavior |
| --- | --- |
| Production coordination | Usable stock → impact/time → exact planning approval → progress → explicit ready evidence and completion reference |
| Generic communication | Source summary, eligible responsibility and response type; can grow prerequisites and clarification |
| Published workflow | Configured branches, dependencies, response types, required fact keys and acceptance rules |
| Legacy material/revision workflow | Existing independent verification remains required |

Examples are in `packages/contracts/examples/`. `communication.request_raised` accepts a summary, group and response kind; decisions require an explicit proposal. Kinds include fact, decision, acknowledgement, evidence, commitment and completion. Published dependencies must be acyclic and remain inside service scope. Unknown events remain triage.

The 231-event, 35-group catalogue is vocabulary/envelope coverage. Its minimal payloads remain synthetic and unverified, not 231 executable integrations. New semantics need a validated adapter or published mapping, participant bindings, disclosure profiles and completion criteria.

## Conversation lifecycle

1. Intake stores the original source event. Autonomous missions await initial routing before contacting participants.
2. A configured, consented channel delivers the current question. Humans reply naturally; machine endpoints receive mapped payloads.
3. A bound reply queues interpretation: record supported facts, clarify, correct responsibility or introduce a prerequisite. Dependencies wait without continuous inference.
4. Current dependency facts support an exact business proposal. Only the assigned approver's explicit reply can approve it. Conditional agreement and silence are not approval.
5. Approved terms can be relayed unchanged. A schedule agreement or start report cannot finish production: explicit readiness and required completion facts are needed.
6. Corrections invalidate downstream answers, proposals and approvals. Stale queued notices are blocked; tracked earlier recipients receive withdrawal notices within the contact budget. Physical actions outside ILIEN cannot be retracted by software.
7. Meaningful changes publish structured source progress. Completion returns accepted information and current decision references without copying the entire conversation.

`accepted` means an authorized responsible reply met the mission rule. `verified` means a configured independent verifier checked it. The observer map distinguishes them. Receipt time is labelled `received`, never invented as physical inspection time.

## Recipient profiles

Versioned profiles select group, transport, language/style and permitted source fields/fact keys. Deliveries snapshot that profile and scoped dependency facts. Human messages preserve the question, context and approval boundaries. Language/style controls boilerplate and informs generated questions; translation quality is not certified.

Machine JSON is available for email endpoints. Each mapped field has a restricted source path, exact type and required/optional flag. Missing required data, conflicting facts or type mismatch blocks rendering. No model text becomes executable templating, SQL or a URL. Include a `token` mapping if a machine recipient needs it for reply correlation; human email replies preserve the reply address/thread.

Source questions appear in result `sourceQuestions[]`. The authenticated source answers through the existing case command API using `{type:"source_response",questionId,answer}` inside the current command/revision envelope. This is not a model tool. Answers resume coordination through the journal and event queue.

## Runtime and cost

Existing Lambda/SQS lanes separately handle intake, reasoning, sending, receiving, timers and source results. Aurora remains the canonical state/evidence/outbox store. No extra database or continuously running agent is added. Event types reuse patterns; a busy lane can scale independently.

Activation, meaningful state changes and correlated replies trigger bounded model runs. Waiting consumes no model calls. Call/output/time limits, case/tenant admission budgets, contact limits and dependency limits bound work. Idempotent commands and revision checks prevent queue redelivery from applying an effect twice. Failed/interrupted inference still consumes admission capacity. There is no silent cheaper-model fallback.

## Acceptance boundaries

Regression checks cover dependency completion, missing facts, corrections/stale approvals, clarification, policy-scoped rerouting, source questions, typed email, fabricated quantity and conditional approval. A real Nova Pro evaluation completed the production scenario with simulated transport. This demonstrates that scenario, not general reasoning reliability. Live transport outcomes are separate; see [acceptance evidence](ACCEPTANCE.md).

Source input and factory actions are simulated; connected SES and AWS Social Messaging exchanges use real transport. Account restrictions, recipient verification and consent remain external prerequisites. Health responses and SDK calls alone are not proof of delivery or completed business outcomes. Per-component database credentials, broader multilingual/adversarial evaluation and customer-specific retention controls remain production hardening work.
