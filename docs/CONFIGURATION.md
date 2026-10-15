# Configuration and credentials

Deployment automation is not yet implemented. This reference defines the configuration boundary for the runtime and deployment setup.

## GitHub Actions

Use environment-scoped Variables for non-secret values: `AWS_REGION`, `AWS_ROLE_ARN`, Terraform backend bucket/key, public domain, model identifiers and resource identifiers. Restrict the deployment environment to approved branches.

Use GitHub Secrets for externally supplied credentials needed during deployment. Never put these values in repository files, command-line arguments that are logged, public artifacts or Terraform variable/state values. Workflows must explicitly control masking, shell tracing and artifact inclusion.

AWS access uses GitHub OIDC and short-lived role sessions. Do not create `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` repository secrets for this deployment. Inspect the repository's actual OIDC subject configuration: newer repositories may use immutable owner/repository IDs. Trust must match the exact subject and `sts.amazonaws.com` audience, not a wildcard organization.

## Application runtime

AWS-native calls use workload IAM roles. GitHub Secrets are not a runtime secret store: the deployed application cannot fetch them on demand. Where an external runtime secret is necessary, deployment can securely provision its value into AWS Secrets Manager in a separate redacted step, outside Terraform state. Terraform manages the secret container and access policy; runtime reads the secret through its role. Provider-generated secrets should remain in AWS where possible, with only the secret ARN stored in GitHub Variables.

Do not duplicate or rotate a secret in competing systems without a defined owner. Avoid creating application secrets until the implementing component actually needs them.

## Communication identities

A recipient's Gmail address or personal WhatsApp number is not a business sending identity. SES sandbox recipients/senders require appropriate verification; email replies require a controlled receiving domain and receipt routing. WhatsApp requires a linked business account and registered sending number. Prefer a separate business sender rather than migrating a personal number. Never commit participant contact details into fixtures or examples.

References: [GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [AWS WhatsApp onboarding](https://docs.aws.amazon.com/social-messaging/latest/userguide/getting-started-whatsapp.html), [SES receiving](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html).
