import { node } from "./journey.js";
type Row = Record<string, unknown>;
export function scenarioFields(
  event: Row,
  host: HTMLElement,
): (() => Row) | null {
  const subject = event.subject as Row,
    payload = event.payload as Row;
  const material =
    event.eventType === "manufacturing.material_readiness_requested" ||
    event.eventType === "planning.upstream_supply_shifted";
  const revision = event.eventType === "plm.techpack_approved";
  const maintenance = event.eventType === "maintenance.breakdown_logged";
  if (!material && !revision && !maintenance) return null;
  if (
    material &&
    (!payload.requiredQuantity ||
      typeof payload.requiredQuantity !== "object" ||
      !payload.neededBy ||
      !payload.materialLotId)
  )
    return null;
  host.replaceChildren();
  const draft = structuredClone(event),
    outSubject = draft.subject as Row,
    outPayload = draft.payload as Row,
    readers: (() => void)[] = [];
  const group = node("section", "", "scenario-fields");
  host.append(group);
  const heading = material
    ? "Check material availability"
    : revision
      ? "Confirm a specification change"
      : "Collect maintenance information";
  group.append(
    node("h3", heading),
    node(
      "p",
      material
        ? "Enter an order and the material you need. ILIEN will ask stores, quality, planning and procurement for information."
        : revision
          ? "Identify the specification and version that people need to acknowledge."
          : "Identify the machine and problem. This scenario needs a maintenance workflow enabled in Settings.",
      "muted",
    ),
  );
  function field(
    title: string,
    hint: string,
    value: unknown,
    write: (v: string) => void,
    type = "text",
  ) {
    const label = node("label", title),
      input = node("input"),
      help = node("small", hint, "muted");
    input.type = type;
    input.required = true;
    input.value = String(value ?? "");
    label.append(input, help);
    group.append(label);
    readers.push(() => {
      const value = input.value.trim();
      if (!value) throw new Error(`Please enter ${title.toLowerCase()}.`);
      write(value);
    });
    return input;
  }
  field(
    material
      ? "Order reference"
      : revision
        ? "Specification reference"
        : "Request reference",
    "A name or reference your team recognises.",
    subject.id,
    (v) => {
      outSubject.id = v;
      draft.correlationId = v;
    },
  );
  if (material) {
    field(
      "Material batch",
      "Which batch or lot needs checking?",
      payload.materialLotId,
      (v) => (outPayload.materialLotId = v),
    );
    const qty = payload.requiredQuantity as Row;
    const quantity = field(
      "Amount needed",
      "Use a positive number. Keep the unit in the next field.",
      qty.value,
      (v) => {
        if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0)
          throw new Error("Amount needed must be a positive number.");
        outPayload.requiredQuantity = {
          ...(outPayload.requiredQuantity as Row),
          value: v,
        };
      },
      "number",
    );
    quantity.min = "0.001";
    quantity.step = "any";
    field(
      "Unit",
      "For example: metre, kg or piece.",
      qty.unit,
      (v) =>
        (outPayload.requiredQuantity = {
          ...(outPayload.requiredQuantity as Row),
          unit: v,
        }),
    );
    const date = new Date(String(payload.neededBy)),
      local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    field(
      "Needed by",
      "The time the material is needed at the factory.",
      local,
      (v) => {
        const time = new Date(v);
        if (!Number.isFinite(time.getTime()) || time.getTime() <= Date.now())
          throw new Error("Choose a future needed-by time.");
        outPayload.neededBy = time.toISOString();
      },
      "datetime-local",
    );
  }
  if (revision)
    field(
      "New version",
      "People will confirm this exact version.",
      subject.revision,
      (v) => (outSubject.revision = v),
    );
  if (maintenance) {
    field(
      "Machine reference",
      "Which machine needs investigation?",
      payload.machineId,
      (v) => (outPayload.machineId = v),
    );
    field(
      "Problem reference",
      "Use the fault description or code supplied by the source.",
      payload.faultCode,
      (v) => (outPayload.faultCode = v),
    );
  }
  const details = node("details", "", "advanced");
  details.append(
    node("summary", "Source details (optional)"),
    node(
      "p",
      "The sample factory and event type come from the scenario. They are preserved with the original request.",
      "muted",
    ),
  );
  const subjectType = node(
    "p",
    `Item type: ${String(subject.type)} · Version: ${String(subject.revision)} · Factory: Sample factory`,
  );
  details.append(subjectType);
  group.append(details);
  return () => {
    for (const read of readers) read();
    return draft;
  };
}
export function userGuide(parent: HTMLElement, go: (page: string) => void) {
  const intro = node("section", "", "card");
  intro.append(
    node("h2", "Your first request, step by step"),
    node(
      "p",
      "ILIEN brings conversations together around a request. It collects information and decisions; it does not operate factory systems.",
    ),
  );
  const steps = node("ol", "", "guide-steps");
  for (const [title, body] of [
    [
      "Start a scenario",
      "Choose a material, specification or maintenance scenario. The source event is simulated. Fill the short form and press Start request & open map.",
    ],
    [
      "Open the request map",
      "ILIEN prepares the request in the background. Use Open live map when ready. Existing requests are under Requests → Open map & request. If routing is not configured, you will see Needs routing review instead.",
    ],
    [
      "Read the workflow",
      "The left side is the original request. ILIEN coordinates the work in the middle. Department tasks and their dependencies are drawn from this request, not a fixed diagram. Select any box for details and evidence.",
    ],
    [
      "Follow each conversation",
      "Switch to Communication flow to see recorded requests, outgoing messages, provider receipts and incoming replies. Activity shows the history in time order. Turn on Live updates to check for new activity while this page is visible.",
    ],
    [
      "Choose practice or real communication",
      "Practice a response records clearly labelled simulated information. For real messages, an admin first connects a consented person in Settings → People & channels. Then open a case, select a request and recipient, and confirm Send real message.",
    ],
    [
      "Check the outcome",
      "An answer must be verified before it satisfies a required task. Missing answers, expired deadlines or unavailable recipients can block a request. The outcome is sent back to its source; source acknowledgement is a separate step.",
    ],
  ]) {
    const item = node("li");
    item.append(node("h3", title), node("p", body));
    steps.append(item);
  }
  intro.append(steps);
  parent.append(intro);
  const actions = node("div", "", "row");
  for (const [title, page] of [
    ["Start a scenario", "Simulator"],
    ["Open requests", "Cases"],
    ["View tasks", "Tasks"],
  ]) {
    const b = node("button", title);
    b.onclick = () => go(page!);
    actions.append(b);
  }
  intro.append(actions);
  const glossary = node("section", "", "card");
  glossary.append(node("h2", "What the statuses mean"));
  const dl = node("dl", "", "facts");
  for (const [word, meaning] of [
    [
      "Preparing request",
      "The source event is accepted; a worker is creating the coordination tasks.",
    ],
    [
      "Needs routing review",
      "No suitable workflow is configured for this event or required information is missing.",
    ],
    ["Waiting", "A person or prerequisite has not answered yet."],
    [
      "Answered",
      "Information was reported, but it has not yet passed verification.",
    ],
    [
      "Verified",
      "An authorised independent check accepted the current answer.",
    ],
    [
      "Blocked / Needs attention",
      "The request cannot progress, for example because a deadline passed or information is missing. Read the task and channel details; blocked does not mean completed.",
    ],
    [
      "Provider accepted",
      "The channel provider accepted the send. This is not proof of delivery or a reply.",
    ],
    [
      "Completed",
      "The required current evidence is verified. Source receipt/acceptance is still shown separately.",
    ],
  ]) {
    dl.append(node("dt", word), node("dd", meaning));
  }
  glossary.append(dl);
  parent.append(glossary);
  const limits = node("section", "", "card");
  limits.append(
    node("h2", "Before using real WhatsApp or email"),
    node(
      "p",
      "A scenario does not add recipients automatically. Real messaging needs configured senders, eligible recipients, consent and provider readiness. If no channel send is recorded, a recorded task has not become a real WhatsApp or email message.",
    ),
    node(
      "p",
      "Open Incoming messages to see every supported WhatsApp and email receipt. An administrator can connect a new sender to an authorised person with recorded consent. Replies to a sent message keep their request reference. A recognised sender with exactly one current outstanding request can reply naturally; several outstanding requests require an explicit reference or operator selection. Greetings open a channel conversation without answering a task.",
    ),
    node(
      "p",
      "Autonomous AI can apply supported, grounded steps without an internal operator click. Unresolved interpretation needs clarification; automatic clarification conversations are still being developed. Review mode requires checking cited evidence before approval. Opening a map does not run AI.",
    ),
  );
  parent.append(limits);
}
