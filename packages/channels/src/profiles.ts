import type { MessageProfile } from "../../contracts/src/communication.js";
import { CoordinationError } from "../../coordination/src/types.js";
import type { Delivery } from "./intents.js";
import { meaningEnvelope, meaningText } from "./meaning.js";

/** All machine mapping is deterministic. No LLM output becomes a template or executable path. */
export function renderProfile(d: Delivery, profile: MessageProfile): string {
  const meaning = meaningEnvelope(d, profile);
  const facts: Record<string,string> = Object.create(null);
  for(const fact of d.request.facts ?? []) {
    if(!profile.factKeys.includes(fact.key) && !profile.factKeys.includes("*")) continue;
    const value = `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`;
    if(profile.format==="json" && facts[fact.key] && facts[fact.key]!==value) throw new CoordinationError("scoped_fact_requires_distinct_machine_key");
    facts[fact.key]=value;
  }
  const source=Object.fromEntries(Object.entries(d.request.sourceContext ?? {}).filter(([k])=>profile.sourceFields.includes(k)||profile.sourceFields.includes("*")));
  if(profile.format === "json") {
    const context:Record<string,unknown>={caseId:d.case_id,token:d.token,question:d.request.contact.question,deadline:d.request.deadline,subject:d.request.subject,source,facts};
    const output:Record<string,unknown> = Object.create(null);
    for(const field of profile.fields) {
      const [key,sub]=field.path.split(".");
      const root=context[key!];
      const value=sub ? (root as Record<string,unknown>)?.[sub] : root;
      if(value===undefined || value===null) {if(field.required) throw new CoordinationError("machine_payload_required_field_missing");continue;}
      if(typeof value!==field.type || (field.type === "number" && !Number.isFinite(value))) throw new CoordinationError("machine_payload_type_mismatch");
      output[field.name]=value;
    }
    if(Object.hasOwn(output,"_ilien")) throw new CoordinationError("reserved_machine_field");
    return JSON.stringify({...output,_ilien:{caseId:d.case_id,token:d.token,meaning}});
  }
  const bn=profile.language === "bn";
  const salutation=profile.style === "formal" ? (bn?"সম্মানিত দায়িত্বপ্রাপ্ত,":"Dear responsible colleague,") : "";
  return [`ILIEN ${d.token}`,salutation,`Department: ${d.request.department ?? d.request.profile?.group ?? d.actor_id} / Responsible role: ${d.actor_id}`,d.request.contact.question,
    `${bn?"রেফারেন্স":"Reference"}: ${d.request.subject.id} / ${d.request.subject.revision}`,
    meaningText(d,profile),
    ...(d.request.demo ? ["The registered recipient represents the named department for this simulated source."] : []),
    `${bn?"উত্তরের সময়সীমা":"Response deadline"}: ${d.request.deadline}`,
    bn?"এই message-এর reply দিন। পরিমাণ, unit, সময় এবং অনিশ্চয়তা অক্ষুণ্ণ রাখুন।":"Reply directly in your own words. Preserve quantities, units, timing and uncertainty.",
    d.request.contact.kind==="decision_notice" ? "This relays the referenced authorized decision; it grants no additional authority." : "This requests information or a decision and grants no operational permission.",
    "Source context is simulated. Send STOP to stop messages on this channel.",
  ].filter(Boolean).join("\n\n");
}
