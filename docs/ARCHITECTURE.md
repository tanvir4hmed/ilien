# Architecture overview

Status: intended architecture; executable components are not yet delivered.

ILIEN separates source request intake, case coordination, actor authorization, evidence storage, AI planning and channel delivery. A persistent case spans participants and communication channels. Replies may create child information requests; incomplete dependencies remain explicit.

The AI coordinator proposes bounded next steps. Application policies control authority, disclosure, state transitions and completion. Original messages and evidence remain distinct from interpretations and summaries. A delivered message does not establish a verified business outcome.

The initial runtime targets AWS messaging, on-demand model inference, durable queues and relational persistence. Terraform modules will manage supported infrastructure, and GitHub Actions will build and deploy versioned artifacts. A synthetic textile scenario will demonstrate material-readiness coordination; no live manufacturing system is required.

Implementation diagrams, deployed resources and measured limits will be documented with the corresponding release.
