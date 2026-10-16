import { createHash } from "node:crypto";
import {
  SocialMessagingClient,
  SendWhatsAppMessageCommand,
} from "@aws-sdk/client-socialmessaging";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import type { CaseState, Policy } from "../../coordination/src/types.js";
import {
  contactCurrent,
  decode,
  type Binding,
  type Delivery,
} from "./intents.js";
const social = new SocialMessagingClient({ maxAttempts: 1 });
const email = new SESv2Client({ maxAttempts: 1 });

function render(d: Delivery) {
  const r = d.request;
  return `ILIEN ${d.token}\nRequest: ${r.contact.question}\nSubject: ${r.subject.type} / ${r.subject.id} / revision ${r.subject.revision}\nObligation: ${d.obligation_id} / revision ${d.obligation_revision}\nDeadline: ${r.deadline}\n${r.claim ? `Reported claim (unverified): ${JSON.stringify(r.claim)}\n` : ""}Source context is synthetic. Reply with ILIEN ${d.token} followed by a JSON reply, verify, or add_child operation. Free text is retained for review. STOP withdraws this channel's consent. This request authorizes no operational action.`;
}
export async function sendDelivery(tenant: string, id: string) {
  const prepared = await transaction(tenant, async (tx) => {
    const candidate = rows<Delivery>(
      await query(
        "SELECT * FROM channel_deliveries WHERE id=CAST(:id AS uuid) AND attempt_at<now()-interval '2 minutes'",
        [param("id", id)],
        tx,
      ),
    )[0];
    if (!candidate) return null;
    const c = rows<{ snapshot: CaseState | string }>(
      await query(
        "SELECT snapshot FROM coordination_cases WHERE id=CAST(:case AS uuid) FOR UPDATE",
        [param("case", candidate.case_id)],
        tx,
      ),
    )[0];
    const d = rows<Delivery>(
      await query(
        "SELECT * FROM channel_deliveries WHERE id=CAST(:id AS uuid) FOR UPDATE",
        [param("id", id)],
        tx,
      ),
    )[0]!;
    d.request = decode(d.request);
    if (d.status === "sending") {
      await query(
        "UPDATE channel_deliveries SET status='uncertain',reason='interrupted_send_requires_reconciliation' WHERE id=CAST(:id AS uuid) AND attempt_at<now()-interval '2 minutes'",
        [param("id", id)],
        tx,
      );
      return null;
    }
    if (d.status !== "pending") return null;
    const binding = rows<Binding>(
      await query(
        "SELECT * FROM channel_bindings WHERE id=CAST(:id AS uuid) FOR UPDATE",
        [param("id", d.binding_id)],
        tx,
      ),
    )[0];
    const p = rows<{ policy: Policy | string }>(
      await query(
        "SELECT p.policy FROM coordination_policies p JOIN source_connections s ON s.tenant_id=p.tenant_id AND s.id=p.connection_id WHERE p.connection_id=CAST(:source AS uuid) AND s.enabled",
        [param("source", d.connection_id)],
        tx,
      ),
    )[0];
    let reason: string | undefined;
    if (
      !binding?.enabled ||
      binding.address !== d.address ||
      !p ||
      !decode(p.policy).actors.some((a) => a.enabled && a.id === d.actor_id)
    )
      reason = "identity_or_consent_unavailable";
    else if (!c || !contactCurrent(decode(c.snapshot), d))
      reason = "stale_contact";
    else if (
      d.channel === "whatsapp" &&
      (!binding.last_inbound_at ||
        Date.parse(binding.last_inbound_at) < Date.now() - 23.9 * 3600000)
    )
      reason = "whatsapp_session_required";
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended(:key,0))::text",
      [param("key", `${tenant}/channel-send-budget`)],
      tx,
    );
    const usage = rows<{ count: number; last_attempt: string | null }>(
      await query(
        "SELECT count(*)::integer AS count,max(attempt_at)::text AS last_attempt FROM channel_deliveries WHERE attempt_at>now()-interval '24 hours'",
        [],
        tx,
      ),
    )[0]!;
    if (
      !reason &&
      usage.last_attempt &&
      Date.parse(usage.last_attempt) > Date.now() - 1500
    )
      return { retryAfter: 2 as const };
    if (usage.count >= 100) reason = "daily_contact_budget";
    const body = render(d);
    if (Buffer.byteLength(body) > 4000) reason = "message_size_limit";
    if (reason) {
      await query(
        "UPDATE channel_deliveries SET status='blocked',reason=:reason WHERE id=CAST(:id AS uuid)",
        [param("id", id), param("reason", reason)],
        tx,
      );
      return null;
    }
    await query(
      "UPDATE channel_deliveries SET status='sending',attempt_at=now(),rendered_text=:body,rendered_sha256=:hash WHERE id=CAST(:id AS uuid)",
      [
        param("id", id),
        param("body", body),
        param("hash", createHash("sha256").update(body).digest("hex")),
      ],
      tx,
    );
    return { d, body };
  });
  if (!prepared) return;
  if ("retryAfter" in prepared) return prepared.retryAfter;
  const { d, body } = prepared;
  let providerId: string | undefined;
  try {
    if (d.channel === "whatsapp") {
      const result = await social.send(
        new SendWhatsAppMessageCommand({
          originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
          metaApiVersion: process.env.WHATSAPP_META_API_VERSION!,
          message: Buffer.from(
            JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: d.address,
              type: "text",
              text: { preview_url: false, body },
            }),
          ),
        }),
      );
      providerId = result.messageId;
    } else {
      const result = await email.send(
        new SendEmailCommand({
          FromEmailAddress: `ILIEN <requests@${process.env.MAIL_DOMAIN!}>`,
          Destination: { ToAddresses: [d.address] },
          ReplyToAddresses: [`r+${d.token}@${process.env.MAIL_DOMAIN!}`],
          ConfigurationSetName: "ilien",
          EmailTags: [{ Name: "ilien_delivery", Value: d.id }],
          Content: {
            Simple: {
              Subject: {
                Data: "ILIEN: coordination request",
                Charset: "UTF-8",
              },
              Body: { Text: { Data: body, Charset: "UTF-8" } },
            },
          },
        }),
      );
      providerId = result.MessageId;
    }
    if (!providerId) throw new Error("MissingProviderMessageId");
  } catch (error) {
    // A transport timeout/5xx can follow an accepted send. Never blindly replay it.
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const certain = !!status && status >= 400 && status < 500 && status !== 408;
    await transaction(tenant, (tx) =>
      query(
        "UPDATE channel_deliveries SET status=:status,reason=:reason WHERE id=CAST(:id AS uuid)",
        [
          param("id", id),
          param("status", certain ? "blocked" : "uncertain"),
          param(
            "reason",
            certain ? "provider_rejected" : "provider_result_unknown",
          ),
        ],
        tx,
      ),
    );
    return;
  }
  await transaction(tenant, (tx) =>
    query(
      "UPDATE channel_deliveries SET status='accepted',provider_message_id=:provider WHERE id=CAST(:id AS uuid)",
      [param("id", id), param("provider", providerId!)],
      tx,
    ),
  );
}
