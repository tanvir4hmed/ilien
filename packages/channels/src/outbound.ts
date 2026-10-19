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
import { configurationFor } from "../../product/src/configuration.js";
import { approvedTemplate } from "./templates.js";
import { pausedFor } from "../../operations/src/controls.js";
import { caseHeld } from "../../operations/src/supervision.js";
const social = new SocialMessagingClient({ maxAttempts: 1 });
const email = new SESv2Client({ maxAttempts: 1 });

function render(d: Delivery) {
  const r = d.request;
  return `ILIEN ${d.token}\nRequest: ${r.contact.question}\nSubject: ${r.subject.type} / ${r.subject.id} / revision ${r.subject.revision}\nObligation: ${d.obligation_id} / revision ${d.obligation_revision}\nDeadline: ${r.deadline}\n${r.proposal ? `Decision proposal (requires explicit response; no action authorized): ${JSON.stringify(r.proposal)}\n` : ""}${r.claim ? `Reported claim (unverified): ${JSON.stringify(r.claim)}\n` : ""}Source context is synthetic. Reply with ILIEN ${d.token} followed by a JSON reply, verify, or add_child operation. Free text is retained for review. STOP withdraws this channel's consent. This request authorizes no operational action.`;
}
export async function sendDelivery(tenant: string, id: string) {
  const prepared = await transaction(tenant, async (tx) => {
    const candidate = rows<Delivery>(
      await query(
        "SELECT * FROM channel_deliveries WHERE id=CAST(:id AS uuid)",
        [param("id", id)],
        tx,
      ),
    )[0];
    if (!candidate) return null;
    if (
      await pausedFor(
        { tenant_id: tenant, id: candidate.connection_id, origin: "simulated" },
        "outbound",
        tx,
      )
    )
      return null;
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
    const integrityHold = await caseHeld(candidate.case_id, tx);
    let template: Awaited<ReturnType<typeof approvedTemplate>> = null;
    if (
      !binding?.enabled ||
      binding.address !== d.address ||
      !p ||
      !decode(p.policy).actors.some((a) => a.enabled && a.id === d.actor_id)
    )
      reason = "identity_or_consent_unavailable";
    else if (
      !c ||
      decode(c.snapshot).configurationVersion !== decode(p.policy).version ||
      !contactCurrent(decode(c.snapshot), d)
    )
      reason = "stale_contact";
    else if (
      d.channel === "whatsapp" &&
      (!binding.last_inbound_at ||
        Date.parse(binding.last_inbound_at) < Date.now() - 23.9 * 3600000)
    ) {
      try {
        template = await approvedTemplate(
          d,
          (await configurationFor(d.connection_id, tx)).configuration,
        );
      } catch {
        reason = "template_verification_unavailable";
      }
      if (!template && !reason)
        reason = "whatsapp_session_or_approved_template_required";
    }
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
    if (integrityHold) reason = "case_integrity_review_required";
    const body = template?.body ?? render(d);
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
      "UPDATE channel_deliveries SET status='sending',attempt_at=now(),rendered_text=:body,rendered_sha256=:hash,template_snapshot=CAST(:template AS jsonb) WHERE id=CAST(:id AS uuid)",
      [
        param("id", id),
        param("body", body),
        param("template", JSON.stringify(template)),
        param("hash", createHash("sha256").update(body).digest("hex")),
      ],
      tx,
    );
    return { d, body, template };
  });
  if (!prepared) return;
  if ("retryAfter" in prepared) return prepared.retryAfter;
  const { d, body, template } = prepared;
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
              ...(template
                ? {
                    type: "template",
                    template: {
                      name: template.name,
                      language: template.language,
                      components: template.components,
                    },
                  }
                : { type: "text", text: { preview_url: false, body } }),
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
