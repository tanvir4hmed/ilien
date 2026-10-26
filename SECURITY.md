# Security

No production release is currently supported. Do not enter real customer data or credentials into demonstration fixtures.

Do not post secrets or sensitive vulnerability details in public issues. Private vulnerability reporting must be enabled and its contact documented before a public executable release. Operational security controls and limitations will be documented alongside implementation; no certification is claimed.

Operational admin commands require current Cognito membership/role, idempotency IDs, bounded retries and committed audit. Source APIs cannot mutate operations controls. Independent structural flags hold queued effects. Legal hold is default; only a scoped retention function may redact eligible closed-case AI traces. See [operations](docs/OPERATIONS.md) for incident response, retained-data limits and pending security/recovery validation. These are implemented controls, not a certification or completed independent assessment.

The optional shared guest sign-in, when explicitly enabled by the deployment owner, intentionally publishes a full-access account to visitors. Password masking and copy controls are presentation features, not confidentiality controls. Review [shared access setup and revocation](docs/OPERATOR_WORKSPACE.md#optional-shared-guest-sign-in) before enabling it. Individual memberships continue to be enforced, but a shared admin account can perform all normal admin actions. This configuration is not suitable for confidential customer data.

Browser sign-in can persist for 24 hours using a rotating refresh token in local storage, with memory-only 15-minute access tokens. JavaScript-accessible refresh tokens remain exposed to successful XSS/device compromise; CSP is a mitigation, not an HttpOnly cookie substitute. Explicit logout clears local state and attempts provider revocation. See [session limitations](docs/OPERATOR_WORKSPACE.md#browser-session-security-limits).
