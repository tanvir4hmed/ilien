# Operations, recovery and retention

The safety sweep, infrastructure alarms and operator controls are implemented separately from the AI planner. They identify processing failures and structural inconsistencies. They do not establish factual truth, semantic model accuracy, successful human response or business execution.

## Processing and budgets

Normal events, replies and timers wake their workers directly. `ilien-reconcile` runs through EventBridge once every 60 minutes by default. Terraform `reconciliation_minutes`, also configurable with the GitHub environment variable `RECONCILIATION_MINUTES`, accepts 15–1440 minutes. A shorter interval increases database wakeups. An admin can request a bounded sweep from Operations without waiting for the schedule.

A sweep repairs up to 100 expired/stuck rows in each work family and checks five case snapshots, rotating by oldest check time. It never calls a model or messaging provider itself. It then wakes the ordinary relay, which can dispatch previously authorized pending work. Default intake/timer batches remain 25, outbound 100, agent 10, result 25. Backlogs larger than a batch require further wakes/sweeps; these are bounded sweeps, not an immediate full-database repair promise.

Intake and timer dispatch leases expire after two/three minutes. Dispatched intake/timer work becomes eligible for repair after 20 minutes; timers must also be due. Obsolete timer revisions are marked processed. Three automatic dispatch attempts is the database budget; the SQS transport separately allows five receives before DLQ. Those budgets are distinct and can multiply handler deliveries, so idempotency and version gates remain necessary. Exhausted work requires reviewed recovery. Manual requeues/retries are limited to three per target over its retained audit history.

Pending channel/agent/result queue admission also stops after three dispatches. Result publication stops for review after three provider attempts. SNS source handback remains at least once: consumers deduplicate result IDs and reject superseded revisions. Requeuing source results may publish a duplicate and never implies source acknowledgement.

An interrupted channel send or running model call older than ten minutes becomes `uncertain`. It is not automatically repeated. Unfinished result publication moves to review. SQS duplicate handling and these independent state checks complement each other; no blanket exactly-once claim is made.

## Stage controls

Only enabled Cognito **admin** members of the source can access `/console/v1/operations` and `/console/v1/operations/queues`. The source integration IAM route does not expose these administrative operations. Tenant and source come from authenticated membership. Queue counts are available only for the configured installation/source and are approximate; the API cannot receive/delete/redrive queue messages.

The controls separately pause new intake, agent processing, outbound sends and result publication. HTTP intake rejects while paused; already admitted intake is retained for later processing. Receiving replies and coordinator deadline checks continue so evidence is not discarded. A paused pending worker can acknowledge its SQS delivery while leaving its durable database intent pending; resume wakes the relay. Pause gates cannot retract an in-flight request already accepted by AWS or a provider. Agent pause applies at admission and between model steps, not retroactively to charged inference.

Controls, recovery and retention actions require a request UUID and reason of at least ten characters. Repeating the same request UUID/body returns the retained outcome; changing that body conflicts. `operations_audit` commits successful effects in the same transaction and retains actor, target, reason, request hash and before/after metadata. The existing operator audit records admitted attempts separately. Failed audit admission fails the action.

Read operations returns controls, up to 100 pending work records, 100 delivery attention records, 50 recent audits, 50 supervision records and 50 retention candidates. These are bounded views, not complete exports. Refresh is manual.

Example control change:

```json
{
  "requestId": "<new UUID>",
  "action": "controls",
  "expectedRevision": 1,
  "intakePaused": false,
  "agentPaused": true,
  "outboundPaused": true,
  "resultsPaused": false,
  "retentionDays": 30,
  "legalHold": true,
  "reason": "Investigating provider timeout outcomes"
}
```

## Recovery actions

| Action | Eligibility and effect |
| --- | --- |
| `reconcile` | Request a bounded, source-scoped sweep through the maintenance worker. Audit records the request; worker completion/heartbeat is separate. |
| `requeue_work` | `lane`: intake, coordination, outbound, agent or result. Requires a target UUID. Only exhausted/stale durable work in allowed states can be requeued. A running/uncertain model call cannot be restarted through this action. |
| `resolve_delivery` | Only an uncertain delivery. `outcome`: accepted or not_sent; evidenceRef and reason required. Accepted requires a provider ID consistent with any known ID. This records an explicit operator attestation; it is not automatic provider verification. |
| `retry_delivery` | Only a definitively blocked/attested unsent delivery in an allowed reason state. Requires evidenceRef. Other pending/sending/accepted/uncertain attempts for that contact block retry. Current source, consent, contact, deadline, policy, integrity and budget gates still apply at send time. |
| `redact_ai_traces` | Explicit case UUID, no legal hold, aged terminal case and eligible finished runs. See retention below. |

Unknown provider outcome procedure: pause the affected stage; inspect the canonical delivery, provider message ID and authenticated delivery events; obtain actual provider evidence; record the resolution with its reference; only retry after a justified not-sent determination. Recording an operator assertion does not make its factual conclusion guaranteed. A recipient answer or provider acceptance is not independent verification of the requested information.

For interrupted inference, preserve the run and observations. Investigate its usage and context, then request a **new** bounded investigation if needed. Do not reset running/uncertain records to pending or bypass daily/case budgets. The uncertain run still counts toward budgets.

DLQs retain failures for 14 days. Inspect the failure and durable entity state before any redrive. Prefer requeueing a proven eligible database intent through Operations. Do not run a blanket `StartMessageMoveTask` across a provider/model queue. Existing DLQs accept redrive only from their own configured source queue. Asynchronous Lambda failures and failed EventBridge deliveries go to a separate encrypted runtime-failures queue, also retained 14 days. That queue can contain private event payloads; view it only through privileged AWS access and never copy it to public logs or issues.

## Independent structural supervision

The supervisor compares case ID/source/revision/status with its relational projection, checks original evidence presence, node identity, dependency references/cycles, verification/reply bindings and required-branch completion. Review flags hold subsequent agent starts, outbound sends and result publication. Administrative case investigation/fixes remain available. After correcting the underlying problem through an authorized path, run reconciliation to recheck it; never clear a flag merely to resume sending.

Five snapshots are checked per sweep, ordered by oldest check. Snapshots above 100 KB are marked **skipped**, not healthy, to preserve the Data API response boundary. Current check records and skipped coverage are visible. This sampling may take several sweeps to cover a backlog; synchronous transition/authorization checks remain the primary pre-effect gates. A passing structural check does not prove message fidelity, participant truthfulness or model correctness. Those still require the deferred evaluations.

## Monitoring and alerts

Terraform provisions a CloudWatch dashboard and alarms for function errors/throttles, source queue age, dead letters, API 5xx responses, sustained database CPU, asynchronous delivery failures/dropped events, missing reconciliation heartbeat, unresolved uncertain effects, exhausted dispatches and invariant review flags. The heartbeat alarm runs outside the function it supervises. Custom metrics use source-free service dimensions; logs contain fixed codes/counts/IDs, not message bodies or credentials.

API access logs retain request ID, route template, method, status, response size and request time for 14 days. They exclude authorization headers, query strings, request bodies and client IPs. Function logs also retain 14 days. Neither is an immutable external security archive.

Alarms publish to an encrypted SNS topic. **No human subscription is created automatically**, so this release does not promise an email/SMS/page notification. An authorized operator must connect an approved incident destination before relying on alert delivery. Budget notifications have the same subscription limitation. Alarm existence is not evidence that delivery/escalation has been exercised.

`Infrastructure drift review` runs weekly and on manual dispatch. It uses an OIDC session, refresh-only Terraform plan and a redacted resource-address summary. It reports drift/failure without applying changes, publishing raw state or uploading plans. Main delivery performs dependency vulnerability audit, type/build/publication checks, exact-plan guard and migration. Lambda ZIPs now use fixed metadata and deterministic compression; unrelated timestamps do not force new artifact hashes.

## Retention and privacy boundary

Legal hold defaults to **true**. No scheduled task deletes original evidence or AI traces. The former blanket 90-day raw-object expiration is removed so an active case/hold is not silently broken; incomplete multipart uploads still expire after one day. Storage cost therefore grows until an authorized case-aware retention policy is applied.

An admin can release the source hold and explicitly redact AI traces for a case closed at least `retentionDays` ago (default 30, configurable 7–3650). Only approved/rejected/failed/stale runs are eligible; running, uncertain or unresolved proposals are retained. A narrow security-definer function verifies tenant/source, age, terminal state and hold, locks records, removes the run's stored context/proposal, and replaces step bodies with redaction/hash metadata. Hash tombstones, provider usage, review hashes, case evidence and audit remain. Runtime roles do not receive general update/delete permission on original evidence or model step content.

This is duplicate AI trace minimization, **not complete personal-data erasure**. Original messages, case snapshots/claims, knowledge, private raw objects, queue copies, logs and backup copies have separate retention requirements. Full customer-specific erasure/export policy, independent role/database privilege review and cross-tenant/security verification remain prerequisites for a real customer rollout. Historical evidence already expired by an older lifecycle policy is not restored by removing that policy.

## Incidents, backup and release recovery

1. Record incident time, affected tenant/source/case IDs, release/configuration versions and a concise symptom. Keep message content and credentials in approved private channels.
2. Pause the affected processing stage. If application login/API is unavailable, an authorized AWS administrator can disable the corresponding Lambda event source mapping as a temporary break-glass action. Record that infrastructure drift and freeze deployments until it is reconciled; an ordinary Terraform apply can otherwise restore the configured state. In-flight calls remain uncertain until investigated.
3. Inspect infrastructure health separately from case correctness. Check queue age/DLQ, callback/provider evidence, Aurora state and maintenance heartbeat. Preserve unknown effects and original evidence.
4. Correct a specific failure, reconcile durable state and resume in a controlled order. Use the same authority/version/consent gates. Do not infer completion from a cleared alarm.
5. Record cause, affected records, any duplicates/loss, recovery action and measured recovery duration. Propose rule/model improvements for review; do not automatically train or publish permissions from the incident.

Aurora retains seven-day automated backups/PITR, storage encryption, a private writer and deletion protection. Terraform state has versioning, encryption and locking. These controls were provisioned; no restore exercise or measured RTO/RPO is claimed. Inspect `LatestRestorableTime` before choosing a restore point. A restore must create a separately named temporary cluster in the existing private network, use approved managed credentials and a compatible Data API/engine configuration, and leave outbound/model/source publication disabled until reviewed. Validate restored evidence, case revisions and unknown effects before deliberately switching runtime references. Restoring a database must not blindly replay historical send intents. Avoid a second permanently running database solely for reassurance.

Deployment uses additive migrations and a destructive-plan guard. Prefer a reviewed forward fix. An older code commit may not understand schema 6 states and must not be deployed as an assumed rollback. Never roll Terraform state back to erase real infrastructure changes; recover the right state version under a lock and reconcile it to actual resources. Do not automatically delete resources, disable deletion protection or remove packages required by a retained release.

The configured hourly safety sweep means lost event wakes can wait roughly one interval plus processing/backlog time. This is a design bound for a healthy scheduler, not a verified SLA. Provider outages, exhausted budgets, DLQ/manual review and larger backlogs can take longer. Establish empirical RTO/RPO and incident notification ownership during authorized recovery exercises.

References: [EventBridge retries and DLQ](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html), [Lambda SQS configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html), [Lambda monitoring metrics](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html), [HTTP API metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html).

Build/type, artifact integrity, dependency audit and Terraform validation are delivery checks. Targeted browser, SES messaging and review-gated model checks are recorded in [acceptance evidence](ACCEPTANCE.md). Broader fault-injection/load, notification and restore acceptance remain pending; no general success or compliance percentage is claimed.
