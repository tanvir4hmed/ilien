# Foundation deployment record

Deployed commit: `d198bed` (16 October 2026).

[Successful delivery run](https://github.com/tanvir4hmed/ilien/actions/runs/38840035146)

- GitHub build, publication guard and Terraform formatting completed.
- OIDC-authenticated Terraform apply completed: zero resources destroyed.
- Database migration returned schema version 1.
- The public process-health endpoint returned HTTP success and the foundation version.

API base: `https://8t0hohk9fe.execute-api.us-east-1.amazonaws.com`

This is an API foundation, not a browser application. Event routes require the configured IAM source identity. The public `/health` endpoint does not exercise database access, tenant isolation, ingestion, queue processing or recovery. Those application behaviors have implementation code but have not received an end-to-end runtime verification in this release. No live messaging or model inference was performed.

Implemented infrastructure: private Aurora PostgreSQL with Data API, SQS and dead-letter queue, four Lambda functions, HTTP API, private S3 delivery packages, Secrets Manager references, runtime IAM boundaries and CloudWatch logs. See the runbook for access and recovery limitations.

Coordination workflows, operator interface, live CDS adapters and bounded AI planning remain subsequent work. This deployment alone is not a complete hackathon demonstration.

## Phase 2 deployment — 16 October 2026

[Successful coordination deployment](https://github.com/tanvir4hmed/ilien/actions/runs/38845959603), commit `83a1331`:

- Build and publication guard completed.
- Terraform applied 13 additions and 8 changes, with zero resources destroyed.
- Aurora returned `DatabaseResumingException` on the first migration attempt; the bounded deployment retry completed schema version 2.
- Process health returned `phase: coordination`, version `0.2.0`.

This confirms infrastructure delivery and migration, not application correctness. No event-flow test, simulated participant command, live channel message or AI inference was run. See [coordination API](COORDINATION.md) for implementation scope and known limits. Phase 1 remains historical evidence below; its schema version is superseded.
