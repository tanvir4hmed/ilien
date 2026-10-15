# Setup and operation

The foundation contains an API, outbox relay, intake worker and privileged migration worker. It has no agent, channel sender or browser console yet.

## Local build

Requirements: Node.js 24, npm, Terraform 1.15.8, AWS CLI v2 and GitHub CLI for repository administration.

```sh
npm ci --ignore-scripts
npm run build
npm run publication:check
```

Build produces only bundled handler files under `dist/`. GitHub packages these exact files, not the workspace. Automated application tests are not supplied in this foundation; build success is not proof of runtime isolation or semantic correctness.

## Bootstrap and deployment

The initial administrator creates the backend with `infra/bootstrap`, before initializing its S3 backend. For a new account, temporarily omit `backend.tf` for the first local initialization/apply, then restore it and run `terraform init -migrate-state -backend-config="bucket=<state-bucket>"`. Supply `oidc_subject` matching the repository's exact OIDC configuration. Existing OIDC provider is referenced, not recreated. Keep local state recovery copies private. Never run bootstrap apply against another project's resources.

Configure a GitHub `demo` environment restricted to `main`. Variables: `AWS_REGION`, `AWS_ROLE_ARN`, `TF_STATE_BUCKET`, `DEMO_PRINCIPAL_ARN`. The demo principal is the IAM identity permitted to submit synthetic events; it is mapped to a server-owned tenant/source. For an assumed role, establish an explicit stable identity mapping rather than accepting arbitrary session names. No access keys are stored in GitHub.

The `Foundation delivery` workflow builds, checks tracked files, creates an exact Terraform plan, refuses destructive changes, applies it and invokes the migration function. It publishes an HTTPS API endpoint after the health route succeeds. State and saved plans are not uploaded as artifacts. Main branch blocks force pushes/deletion; direct approved pushes are supported and deployment waits for the build job.

## Submit an event

Set `ILIEN_API_URL` to the deployed API endpoint and `AWS_REGION=us-east-1` in your shell; authenticate the configured demo principal using AWS CLI login. Then:

```sh
npm run simulate
# Or choose an editable catalogue fixture:
npm run simulate -- packages/simulation/fixtures/planning.upstream_supply_shifted.json
```

Choose an actual filename from `packages/simulation/catalog.json` if using another fixture. API requests are SigV4 signed. `POST /v1/events` accepts strict versioned envelopes; `GET /v1/events` lists the caller's latest 50 events. `GET /health` is public and reports process health only. Return 202 means durable intake; the worker moves events to `awaiting_coordination`, not resolved. No source authority comes from client JSON.

Exact byte retries return the same intake identity; different content under the same source/event ID yields 409. Database/application errors return 503 so a client can retry with the original bytes. Database resume can delay the first request.

## Recovery and operations

Outbox intents commit with original evidence and intake. A failed wake leaves a recoverable pending job. Until scheduled reconciliation is added, an authorized operator invokes `ilien-demo-relay` with a registered tenant UUID; a later accepted event also wakes that tenant's relay. Each invocation handles at most 25 jobs; repeat for backlog. Leases expire after two minutes. Never grant arbitrary callers direct Lambda invoke permissions; the API's trust boundary assumes invocation by its configured gateway or a trusted administrator.

SQS retains failed work in a dead-letter queue after five receives; inspect failure cause before redrive. No message sends exist yet, so this phase only reconciles ingestion work. Runtime role cannot update/delete original evidence or bypass RLS. Migration credentials are isolated from runtime; app credential values are generated directly in Secrets Manager, outside Terraform state. Migration failures require a failed deployment status, never silent success.

Aurora is private, encrypted, has seven-day backups and deletion protection, and scales from 0 to 2 ACU. No NAT gateway is provisioned. A $100/month project-tagged advisory budget publishes threshold alerts to an SNS topic; no human subscription is configured yet, so no email alerts are promised. Cost allocation tags may take time to appear. Budget limits do not cap charges. Review AWS billing directly until alert delivery is connected.

Database rollback is not automatic. Use compatible forward migrations; destructive infrastructure plans require a separately reviewed change. Teardown is deliberate: archive required evidence, preserve state, review final snapshot and deletion protection before destroying demo resources. Do not interrupt judging availability.

Each runnable release must supply pinned tool versions, dependency installation, safe example configuration, database migrations, Terraform bootstrap/environment instructions, required external account setup, build/deploy commands, evaluator access and recovery/teardown procedures. Credentials and Terraform state are never repository content.

AWS messaging requires configured identities and authorized recipients. Receiving email requires a separately configured inbound path. Account onboarding and domain/phone verification cannot be assumed to occur automatically through deployment.

The release must distinguish synthetic events/operational actions from actual communication delivery and disclose measured limits. Runtime claims and commands will be added only when the relevant components are available.

