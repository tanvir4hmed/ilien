# ILIEN contracts v1

`src/index.ts` defines source-event, trusted-intake, mission, amendment, result and acknowledgement interfaces. `src/validation.ts` implements strict source-event runtime validation used by the foundation API. Mission/decision/result runtime schemas will be implemented with coordination; TypeScript interfaces alone are not runtime validation.

## Trust and admission

Authenticate before resolving tenant/source identity. Clients cannot choose a trusted tenant, source connection, actor authority or simulation origin by adding fields to a payload. External payload schemas are registered/versioned. Start with a 256 KiB intake body limit; attachments use separately authorized object upload, not embedded arbitrary files. Reject unknown envelope fields in the runtime validator; allow extensions only inside a registered payload schema.

Deduplicate by `(tenantId, sourceConnectionId, eventId)`. Identical retries return the original intake acknowledgement. The same key with different original content is a conflict, not an overwrite. Preserve original bytes and hash before interpretation. A successful intake response means durable acceptance, not mission completion. Reject unsupported major contract versions; explicit version migration is required. Semantic compatibility changes also require review even if TypeScript still compiles.

## Mission invariants

- Mission identity, authenticated tenant/source and result destination must be consistent with the service scope. Actor/rule IDs resolve only within that scope; a caller cannot grant permissions.
- IDs must be nonempty and bounded; revisions positive integers; numeric limits finite nonnegative integers, with step/depth/contact/token bounds enforced by deployment policy. Dates must be parsed and validated, not merely matched as strings.
- Completion requirement IDs are unique. Decision requirements bind an exact proposal/version. At least one required requirement is necessary for an evidence-collecting mission; published workflow rules define any deliberate exception.
- Callback destinations are registered and allowlisted; no payload-provided arbitrary URL. Cap evidence refs and array lengths under the registered schema and tenant policy.
- Amendment/cancellation requires current authority and expected revision. Replacement preserves mission identity and source binding and advances revision by exactly one. Conflicting commands are rejected for reassessment. Cancelled work cannot generate new effects; in-flight effects require reconciliation.
- Completion is determined by current requirements, accepted evidence, freshness and authority. A model-generated summary cannot satisfy a requirement.
- `completed` requires every required requirement satisfied and no blocking dependency. `blocked` is nonterminal; a deadline may instead produce a terminal `partial` under explicit policy. `cancelled`, `rejected` and `handed_off` are terminal; handoff requires an accepted handoff record. Terminal partial outcomes retain unresolved items.
- Expired approvals cannot be reported as currently valid decisions. Missing replies never become approvals. New evidence can supersede results but never rewrite earlier evidence.
- A result acknowledgement binds the exact result ID/revision and authenticated requesting connection. Rejection opens correction/review; it does not erase completed coordination. Network retries reuse result identity.

## Example event

The fixture in `examples/material-readiness.event.json` is independently authored synthetic data. It is not a verified payload from an external application. Additional context, actor directories, authority rules and mission mappings are server configuration, not permissions embedded in this event.

## Autonomous mission additions

`manufacturing.production_coordination_requested` activates quantity → schedule → approval → production-ready tracking. `communication.request_raised` activates a generic scoped mission with `summary`, eligible `group`, and `kind`. Optional `requiredFacts` declares exact fact keys that must be reported before acceptance; kind `decision` requires `proposal`. Neither message content nor a client group value grants authority: the published directory and bindings remain authoritative.

Source results add `status`, structured `data[]`, current `decisionRefs[]` and unresolved `sourceQuestions[]`. Facts preserve string values, units and evidence references. `timeBasis=received` marks message receipt time rather than a claimed inspection timestamp. `accepted` responsible replies and independently `verified` evidence are distinct. A source question is answered through an authenticated case command (`source_response`) with the normal request ID, expected revision and actor envelope; it is not available to the model.

Versioned recipient profiles and their restricted field mappings are defined in `src/communication.ts`. Machine JSON mapping validates required fields and exact types before sending. See [autonomous coordination](../../docs/AUTONOMOUS_COORDINATION.md).
