import { createHash } from "node:crypto";
import type { Delivery } from "./intents.js";
import type { MessageProfile } from "../../contracts/src/communication.js";
import { CoordinationError } from "../../coordination/src/types.js";

/** Business content is rendered by code. Style never edits evidence or authority. */
export function meaningEnvelope(d: Delivery, profile?: MessageProfile) {
  const facts = d.request.facts ?? [];
  const source = d.request.sourceContext ?? {};
  if (profile) {
    // The coordinator has already selected recipient-scoped context. A profile
    // cannot silently remove part of that selected handoff.
    if (facts.some(f => !profile.factKeys.includes(f.key) && !profile.factKeys.includes("*")))
      throw new CoordinationError("required_fact_disclosure_missing");
    if (Object.keys(source).some(key => !profile.sourceFields.includes(key) && !profile.sourceFields.includes("*")))
      throw new CoordinationError("required_context_disclosure_missing");
  }
  const values = new Map<string, string>();
  for (const f of facts) {
    const key = `${f.scope ?? d.request.subject.id}/${f.key}`;
    const value = JSON.stringify([f.value, f.unit]);
    if (values.has(key) && values.get(key) !== value) throw new CoordinationError("conflicting_disclosed_fact");
    values.set(key, value);
  }
  const content = {
    subject: d.request.subject, source, facts,
    instructions: d.request.instructions ?? [],
    proposal: d.request.proposal ?? null,
    claim: d.request.claim ?? null,
    authority: "Communication only. Reported information is not operational permission.",
  };
  return { ...content, sha256: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
}

const label=(key:string)=>({siteId:"Factory",materialLotId:"Material lot",requiredQuantity:"Quantity needed",neededBy:"Needed by",passing_quantity:"Passing quantity",quarantined_quantity:"Quarantined quantity",usable_quantity:"Usable quantity",supplier_quantity:"Supplier quantity",supplier_arrival:"Supplier arrival",completion_time:"Completion time"} as Record<string,string>)[key] ?? key.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/[_-]/g," ");
export function readableValue(value:unknown):string {
 if(value===null||value===undefined)return "Not provided";
 if(Array.isArray(value))return value.map(readableValue).join("; ");
 if(typeof value==="object") {
  const row=value as Record<string,unknown>;
  if(Object.hasOwn(row,"value")&&Object.keys(row).every(k=>["value","unit"].includes(k)))return `${readableValue(row.value)}${row.unit?` ${row.unit}`:""}`;
  return Object.entries(row).map(([key,item])=>`${label(key)}: ${readableValue(item)}`).join("\n");
 }
 return String(value);
}
export function meaningText(d: Delivery, profile?: MessageProfile) {
 const m=meaningEnvelope(d,profile);
 return [
  ...Object.entries(m.source).map(([key,value])=>`${label(key)}: ${readableValue(value)}`),
  ...m.facts.map(f=>`${label(f.key)}: ${f.value}${f.unit?` ${f.unit}`:""}${f.scope?` (for ${f.scope})`:""}\nReported evidence: ${f.quote}${f.validUntil?`\nValid until: ${f.validUntil}`:""}`),
  ...m.instructions.map(i=>`Restriction reported by ${label(i.actorId)}: ${i.text}`),
  ...(m.proposal?[`Exact proposal / decision terms:\n${readableValue(m.proposal)}`]:[]),
  ...(m.claim?[`Reported information to verify:\n${readableValue(m.claim)}`]:[]),
 ].join("\n\n");
}
