import { createHash } from "node:crypto";
import type { Delivery } from "./intents.js";
import type { MessageProfile } from "../../contracts/src/communication.js";
import { CoordinationError } from "../../coordination/src/types.js";

/** Business content is rendered by code. Style never edits evidence or authority. */
export function meaningEnvelope(d: Delivery, profile?: MessageProfile) {
  const facts = d.request.facts ?? [];
  const source = Object.fromEntries(Object.entries(d.request.sourceContext ?? {}).filter(([key]) =>
    !profile || profile.sourceFields.includes(key) || profile.sourceFields.includes("*")));
  if (profile) {
    // Required evidence may never disappear. Source context is an explicit allowlist:
    // unapproved fields are intentionally excluded to avoid over-disclosure.
    if (facts.some(f => !profile.factKeys.includes(f.key) && !profile.factKeys.includes("*")))
      throw new CoordinationError("required_fact_disclosure_missing");
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

export function meaningText(d: Delivery, profile?: MessageProfile) {
  const m = meaningEnvelope(d, profile);
  return [
    ...Object.entries(m.source).map(([k,v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`),
    ...m.facts.map(f => `${f.key}: ${f.value}${f.unit ? ` ${f.unit}` : ""}${f.scope ? ` [${f.scope}]` : ""}\nEvidence: ${f.quote}${f.validUntil ? `\nValid until: ${f.validUntil}` : ""}`),
    ...m.instructions.map(i => `Reported instruction/restriction (${i.actorId}): ${i.text}`),
    ...(m.proposal ? [`Exact proposal / decision terms: ${JSON.stringify(m.proposal)}`] : []),
    ...(m.claim ? [`Reported claim requiring verification: ${JSON.stringify(m.claim)}`] : []),
  ].join("\n\n");
}
