# Operations and deployment

## Local verification

```sh
npm ci --ignore-scripts
npm run build
npm run test:channels
npm run test:ai
npm run test:autonomy
npm run test:console
npm run publication:check
```

These checks validate TypeScript, packaging, repository publication rules, and deterministic coordination behaviour. They use synthetic data and do not prove provider delivery, human response, or factory action.

## AWS deployment shape

Terraform is split into a bootstrap stack and the application stack. The bootstrap stack creates the encrypted, versioned state bucket and the GitHub OIDC deployment boundary. The application stack creates the private Aurora cluster, Lambda functions, SQS queues and DLQs, API Gateway, SNS topics, S3 evidence bucket, SES configuration, and WhatsApp event destination.

Required deployment configuration includes the AWS region, OIDC role, source principal mapping, mail domain, WhatsApp Business Account ID, and WhatsApp phone-number ID. Runtime credentials are obtained through IAM and Secrets Manager; no credential belongs in the repository.

## Operational controls

The console exposes case visibility, people/channel configuration, and bounded recovery controls. Operators can pause intake, agent processing, outbound sends, or result publication. A pause prevents new work in that stage but cannot retract a provider call already accepted. Recovery records an auditable request and only requeues durable work that is eligible.

Unknown external delivery is an explicit state. The correct recovery path is to inspect provider evidence, record whether the send was accepted or not sent, and only retry a confirmed unsent delivery. The system does not claim exactly-once external delivery.

## Data retention and security

Raw inbound evidence is encrypted and held until an explicit case-aware retention action. AI run traces can be redacted only for eligible closed cases when no hold applies; the original evidence and audit hash remain. Aurora has encryption, a private writer, seven-day backup retention, and deletion protection. CloudWatch logs and DLQs are operational records, not proof of business correctness.

## Production readiness notes

Before a customer rollout, configure individual operator accounts, sender identity and domain verification, recipient consent, WhatsApp template/session readiness, alert destinations, customer retention policy, and a recovery exercise. The demonstration must not be used with confidential customer information until those organization-specific controls are completed.
