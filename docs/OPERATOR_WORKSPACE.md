# Operator workspace

## Access

Terraform provisions a private S3 origin, CloudFront HTTPS endpoint, Cognito user pool and API Gateway JWT authorizer. Console requests use `/console/v1/*`; existing machine API routes retain AWS IAM authentication. The normal hosted sign-in uses authorization code with PKCE, a secretless app client, 15-minute access tokens and password sign-in. Authenticator MFA is temporarily disabled by an explicit operator-onboarding configuration; restore `mfa_configuration = "ON"` and software-token `enabled = true` in Terraform before the release security review. Registration is admin-only; recovery is admin-only. The browser keeps its access token only in memory and a short-lived one-use PKCE verifier/state in session storage. Reloading starts a new sign-in, which can reuse the hosted session.

An identity alone grants no workspace access. `operator_memberships` binds a verified Cognito subject to one source and tenant. Enabled membership is resolved server-side on every request. Roles: viewer (read), operator (case work, simulation and AI review), admin (also configuration, channel consent, knowledge and membership administration). Simulator actor selection represents authenticated synthetic role-play, not identity proof for a real employee. Member administrators bind existing Cognito subjects; account creation and password reset use privileged Cognito administration. The first membership is installed through the privileged migration function; no public bootstrap endpoint exists.

Static assets and public client configuration contain no staff credentials, API keys or service secrets. The optional shared guest credentials are intentionally public when enabled; see shared guest sign-in below. CSP disallows inline scripts, embedding, and third-party scripts. CORS allows the console origin. Browser mutations append a hash-only **admitted request** audit entry before execution; this is not a success ledger. Case, binding, configuration and AI journals record their actual outcomes. Access logs and finer-grained component/database privileges remain separate hardening work.

## Operator screens

The everyday workspace uses plain-language forms and summaries rather than JSON editors.

- **Home:** recent requests, bounded counts, and shortcuts to outstanding work.
- **Requests:** search and status filtering; subject, goal, responsibility and due date.
- **Tasks:** shared workspace tasks waiting for a response or verification, with the responsible person shown. This is not a claim of personal assignment to the signed-in operator. Limited to the latest 100 pending tasks.
- **Start a scenario:** guided source-event forms and searchable synthetic event catalogue. Nothing fires on load. Unmapped events enter routing review; a sample is not proof of integration. Connected recipients may cause real messaging when a request runs.
- **Activity:** select a request to inspect its workflow, communication flow and chronological history.
- **Settings (admin):** people/channels, approved references, configuration and membership. Recovery and infrastructure controls are under **Advanced operations**, outside everyday navigation.

### Request journey

`GET /console/v1/cases/{id}/journey` reads the authorized case plus source-event metadata, contacts, channel deliveries, inbound replies, provider receipts, journal operations, AI review states and result dispatch/acknowledgement. Tenant RLS and source ownership apply before any history is read. The endpoint is read-only; it does not invoke a model or create communication. It returns no recipient addresses, correlation tokens, model prompts or credentials.

The graph is derived from the current case, not a hardcoded scenario:

- Source, subject, department, person and communication medium are distinct concepts.
- **Workflow map** lays out obligations by prerequisite depth. Child requests and dependencies change the graph. Arrows mean prerequisite to dependent work, not an invented chronological send order. Source and outcome nodes are based on recorded case/results.
- **Communication flow** joins actual contacts to outbound sends, provider events and replies using their recorded IDs. Different channels remain within the same case. Missing links are labelled, never guessed.
- **Activity** combines the recorded case actions, AI reviews, sends, replies, provider events and results by time. Simulated response evidence is labelled separately from external evidence.
- Selecting a step opens readable details and original evidence where available. Fit-to-screen, actual-size and pending-work focus controls support walkthroughs without inventing progress animations.
- Message bodies are explicitly previews, capped at 2,000 characters; original inbound evidence remains accessible. Each history category is capped at the latest 100 records and reports truncation. This is a bounded recent history, not an unlimited audit export. Current task status can reflect older evidence outside that window.
- Live updates are **opt in**, every ten seconds, only while the tab is visible. Navigating away cancels updates. No AI runs while watching. The selected view persists; new case revisions prompt the operator to refresh before changing work.

Sending, provider acceptance, confirmed delivery, received reply, verified answer, published result and source acknowledgement are different states. No receipt is fabricated and provider acceptance is not labelled as delivery. Source simulation, participant role-play and real channel activity remain explicitly distinguishable.

### Working with a request

Task cards show the question, responsible person, dependency, reported answer and verification. Guided **Practice a response** forms translate human input into existing version-bound commands; eligible actor selection helps prevent role confusion, while the server remains authoritative. Simulation does not prove a real employee's identity. **Send through a connected channel** selects an actual contact and an enabled, consented recipient for that actor; it requires an explicit real-send confirmation. Source acknowledgement role-play is separately labelled.

AI assistance is on demand and review-gated. The reviewer sees the suggested action, target task, reason, uncertainty and quoted supporting evidence; exact proposal hashes remain bound on submission. Administrator diagnostics are collapsed. UI simplification does not change actor authority, consent, evidence validity, optimistic concurrency, independent verification, PKCE or server membership controls.

The authenticated source is simulated in this installation; no unrestricted self-service tenancy is provided. New incoming channels require trusted intake adapters; the map does not imply that arbitrary personal messages can create cases. Backend adapters currently support email and WhatsApp, with machine-source intake and source result handback. Additional adapters can feed the same model; their existence is not claimed by the diagram.

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

`npm run build` performs type checking and bundles the console and workers. GitHub Actions provisions the console assets with Terraform alongside runtime resources and applies schema 6. Assets are served with no-store and CloudFront caching disabled to avoid stale login/configuration files during this build stage. Custom app hosting uses staged ACM validation and CloudFront activation; see [web hostname configuration](CONFIGURATION.md#web-hostname-and-tls). Use Terraform's `console_url` for the active URL. Email DNS is independent.

This UI release is compiled and deployed through the existing pipeline. Prior login troubleshooting verified credential acceptance and fixed browser preflight; that does not establish complete business-flow, graph, role-isolation or live-channel acceptance. Model and real channel evaluations remain separately tracked. Do not infer an accuracy/SLA/compliance claim from the controls described here.

References: [API Gateway JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [Cognito PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html).

## First operator provisioning

After delivery, an authorized administrator runs `node scripts/bootstrap-operator.mjs APPROVED_EMAIL` with local AWS administrative access and initialized Terraform outputs. The script suppresses invitations, creates a temporary password locally, and binds the initial Cognito subject through the privileged migration function. It refuses a second initial membership. It does not sign in or send a message. First sign-in requires a new password. Authenticator enrollment is required only after MFA is restored. `.private/operator-first-login.txt` and `.private/operator-bootstrap.json` contain credentials; never publish or package either file. Remove them after successful sign-in. For an uncertain create/bind result, inspect the account and private result first rather than resetting credentials blindly.

Encryption reference: [SNS key management and publisher permissions](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html).

[Operational controls and limitations](OPERATIONS.md) supersede earlier statements about reconciliation/recovery being entirely future work. Human alert subscriptions, live evaluations and restore exercises remain pending.

## Optional shared guest sign-in

The owner may explicitly enable a separate shared full-access account. The regular administrator identity is retained. `scripts/provision-shared-account.mjs APPROVED_EMAIL --publish-config` provisions a separate Cognito identity with invitation suppressed, sets its initial password, and binds an admin membership through the IAM-only migration function. It stores resumable setup in `.private/shared-account.private.json`, which must never enter a portable context bundle or repository. It does not reset the original account or send email. Existing account-name conflicts require investigation rather than blind adoption.

Deployment reads `GUEST_USERNAME` (environment variable) and `GUEST_PASSWORD` (environment secret) and intentionally publishes the shared credentials in the public console configuration. An eye icon masks the password visually; it does not make the shared credentials secret. This account has the same application capabilities as other admins, including settings, real communication dispatch, AI requests and membership changes. It is not an isolated or read-only visitor mode. Disable shared access by clearing both deployment inputs and deploying, and separately disable its Cognito identity/membership to revoke use; tokens already issued must be considered until their expiry and server membership checks apply.

**Use guest account** fills a local form; nothing authenticates until **Log in** is pressed. Email/password copy buttons and a password eye toggle are provided. Credentials are sent only in a TLS JSON body to the regional Cognito service, not URL parameters. This uses `USER_PASSWORD_AUTH`; normal hosted PKCE login remains available. Cognito SDK access tokens carry `aws.cognito.signin.user.admin` instead of `openid`; the API authorizer accepts either scope and the backend still requires an access token, exact issuer/client, valid subject and enabled server membership. The reserved Cognito scope concerns self-service identity operations; it does not itself grant the application admin role. Tokens remain in memory. The form can answer a software-token MFA challenge when applicable; MFA setup or password-change challenges use hosted sign-in.

Before restoring mandatory MFA, review the shared account's availability and enrollment separately. A publicly shared account is intentionally public access, not a substitute for individually authenticated staff.

References: [Cognito InitiateAuth](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_InitiateAuth.html), [SDK authorization scopes](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flows-public-server-side.html), [API Gateway scope validation](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

## Guided start and finding the map

The primary material/specification/maintenance examples use business-labelled fields instead of editable contract structure. Factory/type/metadata defaults stay under optional source details; other catalogue/custom events retain a labelled advanced form. **Start request & open map** submits one durable event, waits a bounded period for its associated case, and opens that case. If background work is delayed, **Check and open map** checks the same saved event without resubmitting. Unmapped inputs show **Needs routing review** and do not invent a case/map.

The received-event API includes its actual `case_id` and `case_status`, preserving source ownership. The list offers **Open live map** and reflects current case state rather than treating an old `coordinating` input status as progress. Requests and Home use **Open map & request**. A blocked/deadline-passed case explains that no answer or unrecorded send can be assumed. Maps initially fit the available width; actual-size controls remain available.

**User guide** in navigation explains start → map → conversation → response/verification → source outcome, status meanings and real-channel prerequisites. A printable source version is [USER_GUIDE.md](USER_GUIDE.md).

The shared local form uses a dedicated secretless native-auth app client. Hosted PKCE continues on the original client. API authorizer and handler admit only the explicitly configured hosted/native client IDs from the same issuer, and still resolve server membership per request.
