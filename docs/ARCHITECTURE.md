# Architecture overview

ILIEN implements intake, deterministic coordination and real AWS WhatsApp/SES adapters. AI planning and a production human identity/UI remain subsequent components. Latest CI determines deployed status; application verification is deferred.

```mermaid
flowchart LR
  CLI[Authenticated source / role-play CLI] --> GW[HTTP API: AWS IAM]
  GW --> API[Source and command API]
  API --> DB[(Aurora: case / evidence / journal / outbox)]
  API --> RELAY[Outbox relay]
  RELAY --> IQ[Intake SQS + DLQ]
  IQ --> IN[Intake + domain template mapper]
  IN --> DB
  IN --> RELAY
  RELAY --> TQ[Coordination timer SQS + DLQ]
  TQ --> CW[Coordination worker]
  CW --> CORE[Pure transition and policy gates]
  API --> CORE
  CORE --> DB
  CW --> RELAY
  API --> RESULT[Source result polling + acknowledgement]
  CI[GitHub OIDC delivery] --> TF[Terraform modules]
  CI --> MIG[Isolated migration Lambda]
  MIG --> DB
```

Source identity is resolved from trusted IAM context. PostgreSQL RLS uses transaction-local tenant context and a non-owner runtime login. The migration worker alone uses the managed database administrator secret. Simulated role-play is authorized only by a server-configured simulated connection; choosing an actor ID is not production user authentication.

`packages/coordination` separates deterministic graph transitions from transactional persistence. `packages/domain-packs` defines textile templates; it does not own provider credentials. One case row serializes concurrent transitions. Expected revisions reject stale changes; immutable command/evidence records preserve provenance. Relational obligation/dependency projections, result records and delayed-work intents commit together. Separate queue/compute modules allow intake and coordination capacity to change independently, although they share database capacity.

Only validated versioned payloads activate configured workflows. Unknown or minimal catalogue payloads stay triage. Verified simulated claims satisfy required dependencies; changed evidence invalidates dependent claims. Results describe communication outcomes, never implicit factory actions. Contact snapshots remain separate from provider delivery intents, incoming evidence and transport events. Enabled consented bindings allow real sends. [Coordination API](COORDINATION.md) documents exact behavior and bounds.

Future AI will propose bounded next steps through the same authority/version/evidence gates. The channel module supplies operator-attested identity bindings, fixed disclosure/rendering, provider receipts and conservative uncertain-send handling; runtime acceptance and scheduled reconciliation remain pending. See [channels](CHANNELS.md). Existing simulation role-play must not be reused as production authorization.

Infrastructure is modular Terraform delivered by GitHub Actions with short-lived OIDC credentials and content-addressed private Lambda artifacts. Aurora is private and encrypted; Data API avoids permanent app connection pools. There is one configured tenant, one database writer and no automatic regional failover. No production scalability, security certification or tested tenant-isolation claim is made.
