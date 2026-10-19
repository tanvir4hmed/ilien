# Operator workspace

## Access

Terraform provisions a private S3 origin, CloudFront HTTPS endpoint, Cognito user pool and API Gateway JWT authorizer. Console requests use `/console/v1/*`; existing machine API routes retain AWS IAM authentication. The hosted sign-in uses authorization code with PKCE, a secretless app client, 15-minute access tokens and required authenticator-app MFA. Registration is admin-only; recovery is admin-only. The browser keeps its access token only in memory and a short-lived one-use PKCE verifier/state in session storage. Reloading starts a new sign-in, which can reuse the hosted session.

An identity alone grants no workspace access. `operator_memberships` binds a verified Cognito subject to one source and tenant. Enabled membership is resolved server-side on every request. Roles: viewer (read), operator (case work, simulation and AI review), admin (also configuration, channel consent, knowledge and membership administration). Simulator actor selection represents authenticated synthetic role-play, not identity proof for a real employee. Member administrators bind existing Cognito subjects; account creation and password reset use privileged Cognito administration. The first membership is installed through the privileged migration function; no public bootstrap endpoint exists.

Static assets and public client configuration contain no credentials. CSP disallows inline scripts, embedding, and third-party scripts. CORS allows the console origin. Browser mutations append a hash-only **admitted request** audit entry before execution; this is not a success ledger. Case, binding, configuration and AI journals record their actual outcomes. Access logs and finer-grained component/database privileges remain separate hardening work.

## Screens

- Overview: actual recent case/event records, with explicitly bounded counts; manual refresh.
- Cases: subject/version, dependency cards, original evidence, claims, journal, contacts, results, source acknowledgement, participant role-play, bounded agent requests and exact proposal review.
- Simulator: editable examples and 231 synthetic catalogue fixtures. Unmapped events go to triage; catalogue presence does not claim workflow support. No simulation fires on load.
- Channels: bindings, receipts, delivery outcomes and explicit contact dispatch. Enabling a consented binding can enable real messages; recipient contacts are never auto-populated.
- Knowledge: versioned publication and revocation.
- Settings: AI controls, configuration preview/publish and existing identity membership.

No polling loop or model call runs simply because the UI is open. The authenticated source is simulated in this installation; it does not provide unrestricted multi-client self-service signup.

## Versioned configuration

`GET/POST /v1/configuration` reads or previews/publishes policy and product settings (console uses `/console` prefix). Submit `{action:"preview"|"publish", expectedRevision, policy, configuration}`. New policy versions are mandatory for publication; optimistic revision checks prevent concurrent overwrite. Both prior and new versions are retained. Preview lists up to 100 affected active cases. Publishing changes new-case routing and prevents stale-policy outbound sends. Existing cases need an explicit `adopt_configuration` command, then resume if paused; adoption invalidates prior claims and rechecks authority and graph bounds. A timer detecting a mismatch pauses its case and stops scheduling old-policy work.

Configured event mappings reuse one deterministic engine with bounded required top-level payload fields and branch definitions. They are not arbitrary executable code or a semantic payload validator. Built-in material readiness retains its typed payload checks. Unknown/custom payload semantics must be validated by the source or a future domain-specific validator.

Settings offers a **Prepare maintenance workflow** preset: it adds maintenance respondent/verifier roles and maps `maintenance.breakdown_logged` to inspection, parts and scheduling-impact branches. Preview and publish it, then use the maintenance simulator example. This does not silently change existing policies. Material readiness and revision acknowledgement remain built-in mappings. Branch dependencies are established explicitly or by reviewed agent proposals; the preset does not claim that independent initial questions are already resolved.

## Amendments and bound decisions

Coordinator `amend_subject` requires a new subject revision, revised goal and reason. It increments mission revision, retains amendment evidence IDs, invalidates replies/decisions and preserves the original source evidence/journal. This adjusts coordination scope, never source operational state.

A decision obligation requires coordinator `attach_proposal` with a stable proposal ID, increasing revision and exact statement. The server hashes ID, version, statement and subject revision. Assigned respondent `decide` must present that hash, current obligation and subject versions, approve/reject, reason and bounded observation/validity times. Independent verification is still required. Ordinary fact replies cannot satisfy decision obligations. Verified decisions appear in result decision references, including choice and hash; rejection is a collected decision, not permission to execute the rejected action. AI cannot propose amendment, configuration adoption, proposal attachment or decision acceptance. Structured channel `decide` is subject to the same exact-contact scope and deterministic checks.

## Source handback

Case outcomes write `result_dispatches` in the same database transaction. The relay sends IDs to a separate SQS queue; an independently scalable result worker publishes to the installation's source-specific SNS topic, encrypted with the existing channel notification KMS key. Publisher key permissions are restricted to SNS use. No human subscription or external endpoint is added automatically. The source can subscribe an authorized consumer or read the existing result API; the console can role-play source acknowledgement.

Publication is **at least once**, not exactly once. Consumers deduplicate `resultId`, compare case/result revisions, and separately acknowledge through the source API. A published result may be superseded while in transit; publication is not proof that the source read, accepted or acted on it. The worker checks enabled source, configured tenant/source, current revision, bounded message size and durable dispatch state. It never executes source actions. Missed wakes and broader recovery automation remain subsequent reliability work.

## Delivery and verification boundary

`npm run build` performs type checking and bundles the console and workers. GitHub Actions provisions the console assets with Terraform alongside runtime resources and applies schema 5. Assets are served with no-store and CloudFront caching disabled to avoid stale login/configuration files during this build stage. A dedicated custom app hostname is not configured yet; use Terraform's `console_url`. Email DNS is independent.

Application, browser interaction, model and live-channel verification have **not** been performed for this build. Build and Terraform validation do not establish login, business-flow or delivery correctness. Do not infer an accuracy/SLA/compliance claim from the controls described here.

References: [API Gateway JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [Cognito PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html).

## First operator provisioning

After delivery, an authorized administrator runs `node scripts/bootstrap-operator.mjs APPROVED_EMAIL` with local AWS administrative access and initialized Terraform outputs. The script suppresses invitations, creates a temporary password locally, and binds the initial Cognito subject through the privileged migration function. It refuses a second initial membership. It does not sign in or send a message. First sign-in requires a new password and authenticator enrollment. `.private/operator-first-login.txt` and `.private/operator-bootstrap.json` contain credentials; never publish or package either file. Remove them after successful sign-in. For an uncertain create/bind result, inspect the account and private result first rather than resetting credentials blindly.

Encryption reference: [SNS key management and publisher permissions](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html).
