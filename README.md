# ILIEN

Evidence-backed communication and coordination for people and AI-enabled applications.

ILIEN is being built to receive a request, contact authorized participants, collect information and decisions across channels, manage dependent replies and return a traceable result. The initial demonstration domain is textile and apparel manufacturing.

**Status:** deterministic coordination implementation: authenticated event intake, tenant-scoped persistence, immutable evidence, versioned cases/dependencies, independent reply verification, bounded reminders/escalation, durable timer work and source result acknowledgement. Participant interaction is explicitly simulated through an authenticated CLI. AI and live messaging are not implemented. Application verification is deferred; check the latest Actions run for deployment status.

The demonstration uses synthetic manufacturing events. Future channel integrations will use real AWS communication services. Source applications retain responsibility for business analysis and operational changes. No current fixture sends messages or controls factory systems.

## Build

Use Node.js 24 and Terraform 1.15.8. Run `npm ci --ignore-scripts` and `npm run build`. See the runbook for deployment and authenticated simulation. There is no browser console in this release.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
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
