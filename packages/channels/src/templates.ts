import {
  GetWhatsAppMessageTemplateCommand,
  SocialMessagingClient,
} from "@aws-sdk/client-socialmessaging";
import { createHash } from "node:crypto";
import type { Delivery } from "./intents.js";
import type { ProductConfiguration } from "../../product/src/configuration.js";
const client = new SocialMessagingClient({ maxAttempts: 1 });
export const TEMPLATE_BODY =
  "ILIEN {{1}}. Request: {{2}}. Subject: {{3}} / {{4}} / revision {{5}}. Deadline: {{6}}. Reported information (unverified): {{7}}. Source context is synthetic. Reply to this message with your response. This request authorizes no operational action.";
export async function approvedTemplate(
  d: Delivery,
  configuration: ProductConfiguration,
) {
  const selected = configuration.whatsappTemplate;
  if (!selected?.enabled) return null;
  const response = await client.send(
    new GetWhatsAppMessageTemplateCommand({
      id: process.env.WHATSAPP_WABA_ARN!,
      templateName: selected.name,
      templateLanguageCode: selected.language,
    }),
    { abortSignal: AbortSignal.timeout(5000) },
  );
  const template = JSON.parse(response.template ?? "{}");
  if (
    template.status !== "APPROVED" ||
    template.name !== selected.name ||
    template.language !== selected.language ||
    template.category !== "UTILITY" ||
    !Array.isArray(template.components) ||
    template.components.length !== 1 ||
    template.components[0].type !== "BODY" ||
    template.components[0].text !== TEMPLATE_BODY
  )
    return null;
  const values = [
    d.token,
    d.request.contact.question,
    d.request.subject.type,
    d.request.subject.id,
    d.request.subject.revision,
    d.request.deadline,
    d.request.claim || d.request.proposal
      ? JSON.stringify({ claim: d.request.claim, proposal: d.request.proposal })
      : "None",
  ];
  const parameters = values.map((text) => ({
    type: "text",
    text: text.replace(/\s+/g, " ").trim(),
  }));
  if (parameters.some((p) => !p.text || p.text.length > 1024)) return null;
  const body = TEMPLATE_BODY.replace(
    /\{\{([1-7])\}\}/g,
    (_, n: string) => parameters[Number(n) - 1]!.text,
  );
  return {
    name: selected.name,
    language: { code: selected.language },
    components: [{ type: "body", parameters }],
    body,
    definitionHash: createHash("sha256")
      .update(response.template!)
      .digest("hex"),
    approvalRef: selected.approvalRef,
  };
}
