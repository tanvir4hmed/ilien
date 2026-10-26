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
import { projectProviderEvents } from "./events.js";
import { renderProfile } from "./profiles.js";
const social = new SocialMessagingClient({ maxAttempts: 1 });
const email = new SESv2Client({ maxAttempts: 1 });

export function render(d: Delivery) {
  if(d.request.profile) return renderProfile(d,d.request.profile);
  if(d.request.autonomous || d.request.facts?.length || d.request.contact.kind==="decision_notice") return renderProfile(d,{group:"configured",channel:d.channel,format:"human",version:"default-v1",language:"en",style:"concise",sourceFields:Object.keys(d.request.sourceContext ?? {}),factKeys:["available_quantity","usable_quantity","completion_time","completion_reference","delay_days","quantity","unit","status"],fields:[]});
  const r = d.request;
  const labels: Record<string, string> = {
    siteId: "Factory",
    materialLotId: "Material batch",
    requiredQuantity: "Amount needed",
    neededBy: "Needed by",
    machineId: "Machine",
    faultCode: "Reported fault",
    techpackId: "Specification",
    styleId: "Style",
    revision: "Version",
  };
  const context = Object.entries(r.sourceContext ?? {})
    .map(
      ([k, v]) =>
        `${labels[k] ?? k}: ${typeof v === "object" && v !== null && "value" in v && "unit" in v ? `${v.value} ${v.unit}` : typeof v === "object" ? JSON.stringify(v) : String(v)}`,
    )
    .join("\n");
  return `ILIEN ${d.token}\n\n${r.contact.question}\n\nRegarding: ${r.subject.type} / ${r.subject.id}, revision ${r.subject.revision}\n${context ? `${context}\n` : ""}Please respond by: ${r.deadline}\n${r.proposal ? `Proposal needing your explicit decision: ${JSON.stringify(r.proposal)}\n` : ""}${r.claim ? `Information to independently check: ${JSON.stringify(r.claim)}\n` : ""}\nReply directly to this message in your own words. Preserve quantities, units, dates and uncertainty; say when the information was checked and how long it remains valid. If you need someone else's information first, tell us what is missing. ILIEN retains your original reply for review.\n\nSource context is simulated. This message requests information or a decision; it does not authorize a factory action. Send STOP to stop messages on this channel.`;
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
    let body="";
    try { body = template?.body ?? render(d); }
    catch(error) {reason=error instanceof Error && "code" in error ? String(error.code) : "message_rendering_failed";}
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
              to: `+${d.address.replace(/^\+/, "")}`,
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
          FromEmailAddressIdentityArn: `arn:aws:ses:${process.env.AWS_REGION ?? "us-east-1"}:${process.env.AWS_ACCOUNT_ID!}:identity/${process.env.MAIL_DOMAIN!}`,
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
    const failure = error as Error & { $metadata?: { requestId?: string } };
    // Provider diagnostics must be useful without publishing participant data.
    console.error(
      JSON.stringify({
        code: "channel_send_provider_failure",
        deliveryId: id,
        channel: d.channel,
        providerCode: /^[A-Za-z0-9_.-]{1,100}$/.test(failure.name ?? "")
          ? failure.name
          : "ProviderError",
        httpStatus: status,
        requestId: failure.$metadata?.requestId,
        detail: String(failure.message ?? "")
          .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[address]")
          .replace(/\b\d{8,}\b/g, "[identifier]")
          .slice(0, 1000),
      }),
    );
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
  await transaction(tenant, async (tx) => {
    await query(
      "UPDATE channel_deliveries SET status='accepted',provider_message_id=:provider WHERE id=CAST(:id AS uuid)",
      [param("id", id), param("provider", providerId!)],
      tx,
    );
    await projectProviderEvents(providerId!, tx);
  });
}
