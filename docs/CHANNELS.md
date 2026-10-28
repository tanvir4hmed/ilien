# Channels and message lifecycle

ILIEN supports two configured communication channels: email through Amazon SES and WhatsApp Business through AWS End User Messaging Social. A person can have more than one binding, but each binding is independently consented, enabled, and prioritized.

## Before a message can be sent

The coordinator requires all of the following:

1. an active case requirement and an eligible responsible person;
2. a current, consented, enabled channel binding;
3. a recipient profile that permits the required fields for that recipient;
4. a current case/contact revision and an unexpired deadline;
5. a ready provider path.

The selected channel is the highest-priority usable binding. It is not a rule that every channel must be used. If the case needs a different channel for a different person or purpose, the coordinator creates that contact explicitly. A fallback may be enabled only after a definitive failure or unavailable WhatsApp session/template; it rechecks all of the same gates and never retries an uncertain send.

## Email

Amazon SES sends outbound email and receives replies through the configured domain, receipt rule, encrypted S3 evidence bucket, SNS topics, and channel-receive worker. The service stores the original received MIME object separately from the normalized reply. Delivery, bounce, complaint, and rejection events update delivery state; none of them is interpreted as a business response.

## WhatsApp

The channel-send worker calls the AWS Social Messaging SDK `SendWhatsAppMessage` operation. WhatsApp provider events arrive through the configured SNS destination. A free-form WhatsApp send requires an active customer-service window. Outside that window, ILIEN can use only a configured, approved utility template with the exact required template definition. If neither path is available, the contact stays blocked with the reason recorded in the case.

## Correlation and reply handling

Outbound contacts include a case-specific routing token, obligation revision, subject reference, and deadline. Inbound messages are correlated by provider/thread identifiers or the generated reply route, then checked against the enabled binding for the expected actor. Unmatched, ambiguous, stale, unauthorized, or unsafe messages are retained for review; they do not mutate case state.

Structured replies are evaluated by the deterministic coordinator. Eligible unstructured replies can enter the bounded interpretation path, but only a grounded, validated transition may change the case. Files and media remain quarantined metadata/raw evidence; they are not treated as verified facts.

## Meaning preservation

Recipient rendering can change language, detail, and presentation, but it cannot remove a required quantity, unit, negative instruction, hold, restriction, condition, deadline, or uncertainty statement that the recipient must know to act safely. Profiles limit disclosure to the recipient’s scope. Each handoff keeps links to the original evidence and the facts used to render it.
