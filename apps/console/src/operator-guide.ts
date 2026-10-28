import { node } from "./journey.js";
type Row = Record<string, unknown>;
export function scenarioFields(
  event: Row,
  host: HTMLElement,
): (() => Row) | null {
  if(event.eventType === "communication.request_raised") {
    host.replaceChildren();
    const draft=structuredClone(event), payload=draft.payload as Row, subject=draft.subject as Row;
    const wrap=node("section","","scenario-fields");host.append(wrap);
    const ref=node("input");ref.placeholder="For example: PO-ILN-2048";
    const request=node("textarea");request.placeholder="Describe the issue and the outcome ILIEN should obtain.";request.rows=4;
    const group=node("select"),kind=node("select"),proposal=node("textarea");
    for(const [value,label] of [["stores","Stores"],["quality","Quality"],["planning","Planning"],["production","Production"],["procurement","Procurement"],["supplier","Supplier"]]) {const o=node("option",label);o.value=value!;group.append(o);}
    for(const [value,label] of [["fact","Information"],["evidence","Evidence or validation"],["decision","Business approval"],["acknowledgement","Acknowledgement"],["commitment","Commitment or timeline"],["completion","Completion tracking"]]) {const o=node("option",label);o.value=value!;kind.append(o);}
    for(const select of [group,kind]) {const prompt=node("option","Choose an option");prompt.value="";select.prepend(prompt);select.value="";}
    proposal.placeholder="Enter the exact terms that require approval.";
    const field=(title:string,input:HTMLElement)=>{const l=node("label",title);l.append(input);wrap.append(l);};
    wrap.append(node("h3","Describe a communication request"),node("p","The team is an initial routing hint. ILIEN analyses the request and may clarify or correct the route within configured permissions.","muted"));
    field("Request reference",ref);field("What should ILIEN coordinate?",request);field("Initial responsible team",group);field("Response needed",kind);field("Exact proposal, when requesting approval",proposal);
    return ()=>{if(!ref.value.trim() || !request.value.trim())throw new Error("Enter a reference and a request.");if(!group.value||!kind.value)throw new Error("Choose a responsible team and the response needed.");if(kind.value==="decision" && !proposal.value.trim())throw new Error("Enter the exact proposal to approve.");subject.id=ref.value.trim();draft.correlationId=ref.value.trim();payload.summary=request.value.trim();payload.group=group.value;payload.kind=kind.value;if(kind.value==="decision")payload.proposal=proposal.value.trim();else delete payload.proposal;return draft;};
  }
  const subject = event.subject as Row,
    payload = event.payload as Row;
  const dispatch=event.eventType === "manufacturing.dispatch_exception_requested";
  const production=event.eventType === "manufacturing.production_coordination_requested";
  const material = dispatch || production ||
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
  const heading = dispatch ? "Coordinate a partial-dispatch exception" : production ? "Coordinate quantity, timeline and production readiness" : material
    ? "Check material availability"
    : revision
      ? "Confirm a specification change"
      : "Collect maintenance information";
  group.append(
    node("h3", heading),
    node(
      "p",
      dispatch ? "Quality email → deadline clarification → stores WhatsApp → quality email approval → source result. Participant replies determine clarification and extra prerequisites. A blocked channel stays visible." : production ? "ILIEN will contact stores, clarify the production timeline, obtain planning approval and track production-ready status. Observe the map; no operator approval is needed." : material
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
    input.value = "";
    if(type!=="datetime-local")input.placeholder = `For example: ${String(value ?? "")}`;
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
    node("h2", "Observe a communication case"),
    node(
      "p",
      "ILIEN brings conversations together around a request. It collects information and decisions; it does not operate factory systems.",
    ),
  );
  const steps = node("ol", "", "guide-steps");
  for (const [title, body] of [
    [
      "Start a scenario",
      "Open Cases → Start case. Choose the partial-dispatch rehearsal or another source scenario. Source input is simulated; connected channel messages are real when enabled.",
    ],
    [
      "Open the request map",
      "The Case list is the single list of coordination cases. Start case contains the source form, not a second request list. Unmapped events appear separately under Preparing or unmapped source requests.",
    ],
    [
      "Read the workflow",
      "The left side is the original request. ILIEN coordinates the work in the middle. Department tasks and their dependencies are drawn from this request, not a fixed diagram. Select any box for details and evidence.",
    ],
    [
      "Follow each conversation",
      "Use the case tabs: Flow shows the dynamic map; Messages shows channel sends and replies; Outcome shows collected information and source receipt; History keeps evidence and AI decisions. Live controls stay together in the case header.",
    ],
    [
      "Choose practice or real communication",
      "An admin connects consented recipients under Settings → People & channels. Autonomous cases send questions and interpret replies without internal operator approval. Legacy practice and recovery controls remain under History → Advanced.",
    ],
    [
      "Check the outcome",
      "Accepted means the mission’s responsible-person rule was met. Verified means an independent check was required and completed. Missing evidence or unavailable channels remains unresolved. Outcome and source acknowledgement are separate records.",
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
    ["Accepted", "An authorized responsible reply met this mission’s configured rule. This is distinct from independent verification."],
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
      "The mission’s required acceptance criteria were met at completion. Source receipt is shown separately; historical evidence retains its validity timestamps.",
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
      "Read each case’s Messages tab for its WhatsApp/email conversation. Settings → Unassigned messages is only for receipts that lack a case. Several concurrent cases require a thread or reference; no arbitrary match is guessed. A phone mentioned in an email does not automatically become an authorised recipient.",
    ),
    node(
      "p",
      "ILIEN can clarify missing information, correct an eligible department, introduce a prerequisite and relay a current business approval. Ambiguity does not become approval. Opening the observer map does not run AI. Browser sign-in lasts up to24 hours with short-lived access tokens refreshed automatically; signing out ends the local session.",
    ),
  );
  parent.append(limits);
}
