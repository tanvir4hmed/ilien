# ILIEN user guide

## 1. Sign in

Use your personal workspace account or the owner-enabled shared guest account. **Use guest account** fills the shared email/password; **Log in** authenticates it. Eye reveals the password and Copy buttons copy the respective fields. Shared full-access accounts are public access when enabled.

## 2. Start a request

Open **Start a scenario**. Material readiness asks for order reference, material batch, amount, unit and needed-by time. Specification acknowledgement asks for specification/version; maintenance asks for machine/problem and requires a published maintenance mapping. Source events are synthetic. Optional source details retain the producer metadata. You do not need to write code or JSON.

Press **Start request & open map** once. ILIEN accepts the event and prepares the case asynchronously. It opens the map when ready. If delayed, use **Check and open map**; do not start a second request to retry the same one. Inputs without a configured workflow say **Needs routing review** rather than displaying an invented map.

## 3. Find an existing map

Use **Requests → Open map & request**, or **Start a scenario → Your recently started requests → Open live map**. Home also lists recent requests. Maps are inside a case, not in the source input form.

## 4. Read the map

- **Workflow map:** source, ILIEN, required tasks and dependencies. Arrows mean prerequisite → dependent work. Nodes change when actual tasks/dependencies change.
- **Communication flow:** recorded requests, real channel sends, provider receipts and replies, linked by actual message/case references.
- **Activity:** time-ordered case actions, AI review states, messages, evidence and outcomes.

Click a box or communication to inspect its details and original evidence. Use Fit map to screen or Actual size. Live updates is opt-in and checks every ten seconds while the tab is visible. If work changes, refresh the request before taking an action.

## 5. Practice a response

On a simulated request, **Practice a response** lets you act as an eligible participant. Choose a task and action, enter information and record it. Simulation is labelled. Checking an answer requires a different authorised verifier. A clarification can create another task and block the dependent work. Corrected information can invalidate an earlier answer.

## 6. Use real communication

An admin connects an authorised recipient with recorded consent under **Settings → People & channels**. Sending also requires ready channel senders/provider settings. On a case use **Send through a connected channel**, select the request/recipient and explicitly confirm **Send real message**. Connected replies enter the same case and retain their evidence. Unrelated personal WhatsApp/email conversations are not automatically imported.

A task box alone is not a sent message. **No channel send recorded** means no real send exists in that case history. Provider acceptance is not confirmed delivery; delivery is not a reply; a reply is not a verified answer. A channel switch preserves the case, not an invented participant identity.

## 7. Understand waiting and blocked work

- Preparing request: the event is accepted and coordination is being prepared.
- Needs routing review: workflow configuration or required information is missing.
- Waiting: the person or prerequisite has not responded.
- Answered: the report still needs verification.
- Verified: a qualified independent check accepted the current answer.
- Blocked / Needs attention: inspect unmet tasks and deadlines. It is not a completed request. If the response deadline passed, a coordinator can use Ask again where allowed to reopen the specific work with an audited action.

## 8. Review the outcome

Outcome shows current versus earlier results, pending requirements, source delivery and source acknowledgement. A published report does not prove the source accepted it. ILIEN communicates the collected outcome; factory actions remain with the source system.

## 9. AI and settings

AI coordination is bounded and can run in autonomous or review mode. Autonomous mode applies supported grounded steps without an internal operator click; unresolved interpretation is shown as Needs clarification. Automatic clarification conversations are still being implemented. Review mode requires checking the original evidence before approving the exact suggestion. Looking at a map does not invoke a model. Admin Settings contains people/channels, references, workflow rules and advanced operations. Do not change these simply to clear a blocked status. See [current autonomous capabilities](AUTONOMOUS_COORDINATION.md).
