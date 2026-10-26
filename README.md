# ILIEN

Evidence-backed communication and coordination for people and AI-enabled applications.

ILIEN is being built to receive a request, contact authorized participants, collect information and decisions across channels, manage dependent replies and return a traceable result. The initial demonstration domain is textile and apparel manufacturing.

**Status:** channel integration and deterministic coordination implementation: authenticated event intake, tenant-scoped persistence, immutable evidence, versioned cases/dependencies, independent reply verification, bounded reminders/escalation, durable timer work and source result acknowledgement. WhatsApp and SES adapters, participant bindings, cross-channel correlation and delivery records are implemented. Recipient consent/readiness remains mandatory. Targeted real SES/Gmail and Bedrock acceptance has completed; WhatsApp outbound is blocked by a Meta account restriction. A bounded Bedrock agent with scoped knowledge retrieval, budgets, evidence citations and autonomous policy-gated execution is implemented alongside explicit review mode; general unattended accuracy is not established. See [autonomous runtime scope](docs/AUTONOMOUS_COORDINATION.md). See [targeted acceptance evidence and limits](docs/ACCEPTANCE.md); check the latest Actions run for deployment status.

The demonstration uses synthetic manufacturing events. Channel adapters call AWS End User Messaging Social and SES. Source applications retain responsibility for business analysis and operational changes. With consented channel bindings enabled, configured workflow events can trigger real messages. No fixture controls factory systems.

## Build

Use Node.js 24 and Terraform 1.15.8. Run `npm ci --ignore-scripts` and `npm run build`. See the runbook for deployment and authenticated simulation. The browser operator workspace includes Cognito sign-in, case/evidence views, simulator, autonomous observer maps, legacy agent review and configuration controls. See [operator workspace](docs/OPERATOR_WORKSPACE.md) for scope and verification limits.

## Documentation

- [Operations, recovery and retention](docs/OPERATIONS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [AI agent, review and knowledge contracts](docs/AI.md)
- [Channels, identity and setup](docs/CHANNELS.md)
- [Coordination API and limits](docs/COORDINATION.md)
- [Integration contracts](packages/contracts/README.md)
- [Configuration and credentials](docs/CONFIGURATION.md)
- [Setup and runtime status](docs/RUNBOOK.md)
- [Submission deliverables](docs/SUBMISSION.md)
- [Security](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

Original ILIEN material is available under the [MIT License](LICENSE). Third-party material retains its own license.

Deployment evidence and verification limits: [deployment record](docs/DEPLOYMENT.md).
