# Autonomous coordination runtime

The current implementation adds server-configured autonomous execution to the existing communication coordinator. It is the first migration toward unattended case management, not a claim that arbitrary business events already have complete autonomous workflows.

`ai_settings.execution_mode` is `autonomous` or `review`. New installations and the additive schema-9 migration select autonomous; migration increments settings revisions so pre-migration proposals cannot be silently executed. Historical proposed runs are not bulk replayed. Publishing AI settings may select review mode explicitly. Enabled/automatic-receipt settings and existing pause controls still apply.

## Implemented behavior

Eligible case activation and meaningful accepted transitions enqueue a bounded case investigation using a unique case/revision request key. Correlated natural-language replies retain their existing bounded receipt run. Model work remains event-driven; waiting does not run a polling model. Follow-up investigation does not recursively call a model inside a transaction. Report operations do not requeue themselves.

In autonomous mode, a supported effect with no declared uncertainty can execute without an internal operator. The application rechecks source/participant identity, exact evidence quotations, current case/settings/policy revisions, approved knowledge versions, proposal hash and deterministic transition rules. A transactional `ai_executions` record identifies the machine action, actor, proposal/policy hashes and resulting revision. This is separate from `ai_reviews`, which records human review in review mode. Evidence and authority checks do not prove semantic correctness.

An execution retry reuses the run/command ID. A crash after proposal persistence can resume the saved proposal without invoking the model again. Once executed, redelivery cannot apply it twice. The worker wakes the existing outbox relay after processing; it does not send arbitrary provider messages. CDS credentials remain on the channel workers.

## Present limits

The available operations remain those in the existing coordination contract. This release does not add free-form factory instructions, arbitrary group changes, unbound business decisions, or arbitrary webhook destinations. Business approvals must come from the authorized participant and remain bound to the current proposal.

Uncertain or unsupported autonomous proposals become `needs_clarification`; the complete automatic clarification/rerouting conversation is still being implemented. The existing business completion policy still requests independent verifier evidence for each reported requirement. Configurable mission-specific acceptance, production-progress tracking, machine-format endpoint profiles and generalized source clarification are subsequent implementation work. Do not depict those target capabilities as already functional.

The simulation catalogue contains 231 synthetic event fixtures in 35 groups. All catalogue payloads remain unverified and triage; the separate material-readiness and revision-acknowledgement examples activate actual built-in workflows. `npm run test:simulation` checks every catalogue envelope/fixture and prevents vocabulary coverage being mislabeled as workflow coverage.

Settings request example: `{"enabled":true,"autoReceipts":true,"executionMode":"autonomous","expectedRevision":2}`. Use the current settings revision rather than copying this example's number. The console exposes this under advanced AI controls. Existing review-mode approval endpoints remain available for historical and explicitly reviewed workflows.

## Acceptance boundaries

Deterministic regressions check mode enforcement, retained grounding/authority checks and uncertainty rejection. They do not establish general unattended reasoning accuracy or a completed live multi-channel autonomous scenario. Provider availability is independent of execution mode; consult [acceptance evidence](ACCEPTANCE.md) for the last recorded transport results.
