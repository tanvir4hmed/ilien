import {
  contactCurrent, bindingMatches,
  decode,
  type Binding,
  type Delivery,
} from "./intents.js";
import type { CaseState } from "../../coordination/src/types.js";

export const isGreeting = (text: string) =>
  /^(hi|hello|hey|hello ilien|hi ilien|salam|assalamu alaikum|আসসালামু আলাইকুম|হাই|হ্যালো)[\s!.?]*$/i.test(
    text.trim(),
  );

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export type OpenDelivery = Delivery & {
  snapshot: CaseState | string;
  attempt_at: string;
};

/** Identity is configured by an operator. Content similarity never grants authority. */
export function openDeliveries(
  binding: Binding,
  candidates: OpenDelivery[],
  receivedAt: string,
) {
  const time = Date.parse(receivedAt);
  const current = candidates.filter((d) => {
    d.request = decode(d.request);
    return (
      binding.enabled &&
      bindingMatches(d,binding) &&
      ["accepted", "uncertain", "sending"].includes(d.status) &&
      Number.isFinite(time) &&
      Date.parse(d.attempt_at) <= time + 1000 &&
      contactCurrent(decode(d.snapshot), d)
    );
  });
  // Reminders/fallback channels may represent the same question. They must not
  // manufacture ambiguity, or count as separate authority to answer it.
  const unique = new Map<string, OpenDelivery>();
  for (const d of current) {
    const key = `${d.case_id}/${d.obligation_id}/${d.obligation_revision}/${d.request.contact.kind}/${d.request.contact.replyRevision ?? ""}`;
    if (!unique.has(key)) unique.set(key, d);
  }
  return [...unique.values()];
}
