import {
  GetWhatsAppMessageTemplateCommand,
  SocialMessagingClient,
} from "@aws-sdk/client-socialmessaging";
import { createHash } from "node:crypto";
import type { Delivery } from "./intents.js";
import type { ProductConfiguration } from "../../product/src/configuration.js";
import { meaningText } from "./meaning.js";
const client = new SocialMessagingClient({ maxAttempts: 1 });
export const TEMPLATE_BODY =
  "ILIEN {{1}}. Request: {{2}}. Subject: {{3}} / {{4}} / revision {{5}}. Deadline: {{6}}. Reported information (unverified): {{7}}. Source context is synthetic. Reply to this message with your response. This request authorizes no operational action.";
export const ORDER_CONFIRMATION_BODY="Order {{1}} coordination is complete. Please check your source system for the confirmed order details. This message does not confirm shipment or stock release.\n\nProcessed by iLIEN.";
const UPDATE_BODY="ILIEN request update: your previously submitted coordination request has an update. Please reply to this message to continue the conversation with the responsible department. This message does not authorize stock release or shipment.";
const FOOTER="Reply STOP to stop WhatsApp updates.";
export async function approvedTemplate(
  d: Delivery,
  configuration: ProductConfiguration,
) {
  const selected = d.request.contact.kind==='completion_notice'?configuration.completionNotice?.template:configuration.whatsappTemplate;
  if (!selected?.enabled) return null;
  const response = await client.send(
    new GetWhatsAppMessageTemplateCommand({
      id: process.env.WHATSAPP_WABA_ARN!,
      templateName: selected.name,
      templateLanguageCode: selected.language,
    }),
    { abortSignal: AbortSignal.timeout(5000) },
  );
  return verifiedTemplate(d,selected,response.template??'{}');
}
/** Only exact provider-approved definitions can cross the notification boundary. */
export function verifiedTemplate(d:Delivery,selected:NonNullable<ProductConfiguration['whatsappTemplate']>,raw:string){
  if(!selected.enabled)return null;
  const template = JSON.parse(raw);
  const confirmation=d.request.contact.kind==='completion_notice';
  const body=template.components?.find((c:{type:string})=>c.type==='BODY');
  const footer=template.components?.find((c:{type:string})=>c.type==='FOOTER');
  const simple=confirmation?ORDER_CONFIRMATION_BODY:UPDATE_BODY;
  if(template.status==='APPROVED'&&template.name===selected.name&&template.language===selected.language&&template.category==='UTILITY'&&template.components?.length===2&&body?.text===simple&&footer?.text===FOOTER){
    const text=String(d.request.subject.id);
    if(!text||text.length>1024)return null;
    return {name:selected.name,language:{code:selected.language},components:confirmation?[{type:'body',parameters:[{type:'text',text}]}]:[],body:simple.replace('{{1}}',()=>text)+'\n'+FOOTER,definitionHash:createHash('sha256').update(raw).digest('hex'),approvalRef:selected.approvalRef};
  }
  if(confirmation)return null;
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
    meaningText(d,d.request.profile) || "No additional source facts supplied; do not infer operational permission.",
  ];
  const parameters = values.map((text) => ({
    type: "text",
    text: text.replace(/\s+/g, " ").trim(),
  }));
  if (parameters.some((p) => !p.text || p.text.length > 1024)) return null;
  const renderedBody = TEMPLATE_BODY.replace(
    /\{\{([1-7])\}\}/g,
    (_, n: string) => parameters[Number(n) - 1]!.text,
  );
  return {
    name: selected.name,
    language: { code: selected.language },
    components: [{ type: "body", parameters }],
    body:renderedBody,
    definitionHash: createHash("sha256")
      .update(raw)
      .digest("hex"),
    approvalRef: selected.approvalRef,
  };
}
