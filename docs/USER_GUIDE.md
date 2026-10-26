# ILIEN user guide

## 1. Sign in

Use your personal workspace account or the owner-enabled shared guest account. **Use guest account** fills the shared email/password; **Log in** authenticates it. Eye reveals the password and Copy buttons copy the respective fields. Sign-in can be restored after reload for up to 24 hours from the original login; access tokens last 15 minutes and refresh silently. Sign out revokes the refresh token. Network failures preserve the session for Retry; they do not fabricate a successful connection. Shared full-access accounts are public access when enabled.

## 2. Start a case

Open **Cases → Start case**. **Partial dispatch coordination** exercises email clarification, a WhatsApp allocation question and return-to-email approval; see the [scenario](COMMUNICATION_SCENARIO.md). **Production coordination** asks for order reference, material batch, amount, unit and needed-by time; it tracks quantity, schedule, approval and actual readiness. **Communication request** asks for a question, responsible team and response type. Other scenarios include legacy material readiness and revision acknowledgement. Source events are synthetic. You do not need to write code or JSON.

Press **Start request & open map** once. ILIEN accepts the event and prepares the case asynchronously. It opens the map when ready. If delayed, use **Check and open map**; do not start a second request to retry the same one. The case due time is the coordination response window; **Needed by** and a participant-reported dispatch deadline are separate business dates. Inputs without a configured workflow say **Needs routing review** rather than displaying an invented map.

## 3. Find an existing map

Use **Cases → Case list → Open map & request**. Create and list occupy adjacent tabs; the create form has no duplicate recent list. Maps belong to a case.

## 4. Read the map

- **Flow:** source, ILIEN, required tasks and dependencies. Arrows mean prerequisite → dependent work. Nodes change when actual tasks/dependencies change.
- **Messages:** recorded requests, real channel sends, provider receipts and replies, linked by actual message/case references.
- **History:** time-ordered case actions, AI review states, messages, evidence and outcomes.

Click a box or communication to inspect details and original evidence. Use Fit map to screen. Live updates defaults on for autonomous missions and checks every ten seconds while the tab is visible. The map follows actual tasks, dependencies, sends and replies; it is not a prerecorded route.

## 5. Practice a response

Legacy simulated requests expose **Practice a response** for labelled participant role-play. Autonomous missions hide this panel and manual AI/send controls: participants answer through their connected channels. Acceptance follows the mission policy; an independent check is required only when that rule is configured. Corrected information can invalidate earlier answers and approvals.

## 6. Use real communication

An admin connects an authorised recipient with recorded consent under **Settings → People & channels**. Sending requires ready channel/provider settings. Autonomous missions send current questions automatically to those bindings and process correlated replies. Legacy cases retain **Send through a connected channel** controls. Unrelated personal conversations are not automatically imported.

A task box alone is not a sent message. **No channel send recorded** means no real send exists in that case history. Provider acceptance is not confirmed delivery; delivery is not a reply; a reply is not a verified answer. A channel switch preserves the case, not an invented participant identity.

## 7. Understand waiting and blocked work

- Preparing request: the event is accepted and coordination is being prepared.
- Needs routing review: workflow configuration or required information is missing.
- Waiting: the person or prerequisite has not responded.
- Answered: the report still needs verification.
- Accepted: an authorized responsible reply met this mission's acceptance rule; this is not an independent physical check.
- Verified: a qualified independent check accepted the current answer.
- Blocked / Needs attention: inspect unmet tasks and deadlines. It is not a completed request. If the response deadline passed, a coordinator can use Ask again where allowed to reopen the specific work with an audited action.

## 8. Review the outcome

The **Outcome** tab shows current results, required responsibilities, source delivery and source acknowledgement. **History** retains earlier results, evidence and AI decisions. A published report does not prove the source accepted it. ILIEN communicates the collected outcome; factory actions remain with the source system.

## 9. AI and settings

AI coordination is bounded and can run in autonomous or review mode. Autonomous missions apply supported grounded steps without an internal operator click, ask missing questions and wait for business participants. Source questions appear in the request; the source answers through its authenticated integration. Review mode requires checking original evidence before approving an exact suggestion. Looking at a map does not invoke a model. A production-start message leaves work in progress until explicit readiness and completion evidence arrive. See [autonomous capabilities and limits](AUTONOMOUS_COORDINATION.md).
