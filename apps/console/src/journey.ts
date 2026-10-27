import type { CaseState } from "../../../packages/coordination/src/types.js";
import { channelIcon, renderCommunicationNetwork, statusTone } from "./network.js";
export type RecordRow = Record<string, unknown>;
export type Journey = {
  state: CaseState;
  sourceEvent?: RecordRow;
  aiRuns: RecordRow[];
  contacts: RecordRow[];
  deliveries: RecordRow[];
  receipts: RecordRow[];
  deliveryEvents: RecordRow[];
  journal: RecordRow[];
  results: RecordRow[];
  truncated: string[];
  observedAt: string;
  asOf?:string;
  nextPage?:number|null;
  participantChannels?:{actor_id:string;channel:string}[];
  channelBindings?:{actor_id:string;channel:string;enabled:boolean;last_inbound_at?:string}[];
  whatsappTemplateEnabled?:boolean;
  participants?:{id:string;group:string;role:string;name?:string;capabilities?:string[];approvalScopes?:string[];enabled:boolean}[];
};
export const words = (value: unknown): string =>
  String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/^./, (s) => s.toUpperCase());
/** A result is a historical snapshot; never project today's tasks onto an older result. */
export function recordedRequirements(result: RecordRow) {
  const requirements=Array.isArray(result.requirements) ? result.requirements : [];
  return requirements.map((value: unknown) => {
    const item=value && typeof value === "object" ? value as RecordRow : {};
    return {requirement:String(item.requirementId ?? item.id ?? "Unknown"),status:words(item.reasonCode ?? item.status ?? "not recorded")};
  });
}
export const instant = (value: unknown): number => {
  let text = String(value ?? "");
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text))
    text = text.replace(" ", "T") + "Z";
  return Date.parse(text);
};
export const date = (value: unknown): string =>
  value
    ? new Date(instant(value)).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not recorded";
export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  cls = "",
) {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = cls;
  if(cls.split(" ").includes("badge"))n.dataset.tone=statusTone(text.toLowerCase());
  return n;
}
export function object<T>(v: T | string): T {
  return typeof v === "string" ? JSON.parse(v) : v;
}
export function summary(value: unknown, parent: HTMLElement) {
  if (value === null || value === undefined) {
    parent.append(node("p", "Not recorded", "muted"));
    return;
  }
  if (typeof value !== "object") {
    parent.append(node("p", String(value)));
    return;
  }
  const dl = node("dl", "", "facts");
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    dl.append(node("dt", words(key)));
    const dd = node("dd");
    if (typeof item === "object") {
      const fold = node("details");
      fold.append(
        node(
          "summary",
          Array.isArray(item) ? `${item.length} items` : "View details",
        ),
      );
      summary(item, fold);
      dd.append(fold);
    } else
      dd.textContent =
        typeof item === "boolean" ? (item ? "Yes" : "No") : String(item);
    dl.append(dd);
  }
  parent.append(dl);
}
export function renderJourney(
  host: HTMLElement,
  data: Journey,
  evidence: (id: string) => Promise<void>,
  options: {mode?:"Workflow map"|"Communication flow"|"Communication network"|"Activity";compact?:boolean;message?:(id:string)=>Promise<unknown>} = {},
) {
  host.replaceChildren();
  const selected = host.dataset.view || "Workflow map";
  const controls = node("div", "", "row"),
    meta = node("div", "", "journey-meta"),
    view = node("div"),
    inspector = node("section", "", "journey-inspector");
  inspector.setAttribute("aria-live", "polite");
  controls.hidden=!!options.mode;
  host.append(
    controls,
    meta,
    node(
      "p",
      `Updated ${date(data.observedAt)} · Recorded work only. Select a step for details.`,
      "muted",
    ),
    view,
    inspector,
  );
  if (data.truncated.length)
    host.append(
      node(
        "p",
        `More ${data.truncated.map(words).join(", ")} are available using Load older history.`,
        "notice",
      ),
    );
  const show = (title: string, body: unknown, evidenceId?: string) => {
    inspector.replaceChildren(node("h3", title));
    summary(body, inspector);
    if (evidenceId) {
      const b = node("button", "Read original evidence");
      b.onclick = () => void evidence(evidenceId);
      inspector.append(b);
    }
  };
  const inspectTask=(id:string)=>{
    const o=data.state.obligations.find(o=>o.id===id)!;
    show(o.question,{owner:o.assignee,status:o.skipped?"not applicable":o.status,skipReason:o.skipped?.reason,satisfiedFrom:o.satisfiedFrom,waitingFor:o.dependencies.filter(id=>!data.state.obligations.some(d=>d.id===id&&(d.skipped||["accepted","verified"].includes(d.status)))),conflicts:o.conflicts,requiredFacts:o.requiredFacts,reply:o.reply,proposal:o.proposal,decision:o.decision,nextContactAt:o.nextContactAt,responseDeadline:data.state.deadline,businessDeadline:data.state.businessDeadline},o.reply?.evidenceId);
    for(const d of data.deliveries.filter(d=>d.obligation_id===id)){
      const b=node("button",`${words(d.channel)} · ${words(d.status)} · ${date(d.created_at)}${d.reason?` · ${words(d.reason)}`:""}`);
      b.onclick=async()=>{show("Outgoing message",d);if(options.message){try{show("Full outgoing message",await options.message(String(d.id)));}catch(e){show("Message unavailable",String(e));}}};inspector.append(b);
      for(const r of data.receipts.filter(r=>r.delivery_id===d.id)){const reply=node("button",`Reply · ${words(r.status)} · ${date(r.created_at)}`);reply.onclick=()=>show("Participant reply",r,String(r.evidence_id));inspector.append(reply);}
    }
    inspector.scrollIntoView({block:"nearest",behavior:"smooth"});
  };
  function tab(label: string, action: () => void) {
    const b = node("button", label);
    b.onclick = () => {
      for (const c of controls.children) c.classList.remove("selected");
      b.classList.add("selected");
      host.dataset.view = label;
      action();
    };
    controls.append(b);
    return b;
  }
  function workflow() {
    view.replaceChildren();
    const frame = node("div", "", "journey-scroll"),
      canvas = node("div", "", "journey-canvas");
    frame.tabIndex = 0;
    frame.setAttribute("aria-label", "Scrollable workflow map");
    frame.append(canvas);
    view.append(frame);
    const state = data.state,
      levels = new Map<string, number>(),
      visiting = new Set<string>();
    function depth(id: string): number {
      if (levels.has(id)) return levels.get(id)!;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const o = state.obligations.find((o) => o.id === id);
      const n = o?.dependencies.length
        ? 1 + Math.max(...o.dependencies.map(depth))
        : 0;
      visiting.delete(id);
      levels.set(id, n);
      return n;
    }
    for (const o of state.obligations) depth(o.id);
    const columns = new Map<number, number>(),
      positions = new Map<string, { x: number; y: number }>();
    for (const o of state.obligations) {
      const d = levels.get(o.id) ?? 0;
      const row = columns.get(d) ?? 0;
      columns.set(d, row + 1);
      positions.set(o.id, { x: 600 + d * 300, y: 35 + row * 190 });
    }
    const maxDepth = Math.max(0, ...levels.values()),
      width = 1200 + maxDepth * 300,
      height = Math.max(260, ...[...columns.values()].map((n) => n * 190 + 40));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("aria-hidden", "true");
    canvas.append(svg);
    const defs = document.createElementNS(svg.namespaceURI, "defs");
    const marker = document.createElementNS(svg.namespaceURI, "marker");
    marker.setAttribute("id", "journey-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const tip = document.createElementNS(svg.namespaceURI, "path");
    tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    tip.setAttribute("fill", "#79979b");
    marker.append(tip);
    defs.append(marker);
    svg.append(defs);
    function edge(a: { x: number; y: number }, b: { x: number; y: number }) {
      const line = document.createElementNS(svg.namespaceURI, "path");
      const x = a.x + 250,
        y = a.y + 70,
        x2 = b.x,
        y2 = b.y + 70;
      line.setAttribute(
        "d",
        `M${x},${y} C${x + 30},${y} ${x2 - 30},${y2} ${x2},${y2}`,
      );
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "#79979b");
      line.setAttribute("stroke-width", "2");
      line.setAttribute("marker-end", "url(#journey-arrow)");
      svg.append(line);
    }
    function box(
      id: string,
      title: string,
      label: string,
      body: string,
      pos: { x: number; y: number },
      status: string,
      action: () => void,
    ) {
      const b = node("button", "", "journey-node");
      b.dataset.status = status;
      b.style.left = `${pos.x}px`;
      b.style.top = `${pos.y}px`;
      b.append(
        node("span", label, "eyebrow"),
        node("strong", title),
        node("span", body, "node-copy"),
        node("span", words(status), "badge"),
      );
      b.onclick = action;
      b.dataset.node = id;
      canvas.append(b);
    }
    const source = { x: 0, y: 35 },
      hub = { x: 300, y: 35 };
    box(
      "source",
      `${words(state.subject.type)} · ${state.subject.id}`,
      "Original request",
      `${state.origin === "simulated" ? "Simulated" : "Recorded"} · ${words(data.sourceEvent?.event_type || "source event")}`,
      source,
      "received",
      () =>
        show(
          "Original request",
          {
            subject: state.subject,
            goal: state.goal,
            origin: state.origin,
            event: data.sourceEvent?.event_type,
            created: state.createdAt,
          },
          state.sourceEvidenceId,
        ),
    );
    box(
      "coordination",
      "ILIEN",
      "Coordination",
      state.goal,
      hub,
      state.status,
      () =>
        show("Coordination", {
          status: state.status,
          deadline: date(state.deadline),
          goal: state.goal,
          source: state.sourceId,
        }),
    );
    edge(source, hub);
    for (const o of state.obligations) {
      const pos = positions.get(o.id)!;
      for (const dep of o.dependencies) {
        const from = positions.get(dep);
        if (from) edge(from, pos);
      }
      if (!o.dependencies.length) edge(hub, pos);
      const channels = [
        ...new Set(
          data.deliveries
            .filter((d) => d.obligation_id === o.id)
            .map((d) => `${words(d.channel)}${["blocked","uncertain"].includes(String(d.status)) ? ` · ${words(d.status)}` : ""}`),
        ),
      ];
      box(
        o.id,
        words(o.group),
        channels.join(" / ") || "No channel send recorded",
        o.question,
        pos,
        o.skipped ? "not applicable" : o.satisfiedFrom ? "evidence reused" : o.status,
        () => inspectTask(o.id),
      );
    }
    const current = data.results.find((r) => r.current === true);
    if (current) {
      const end = { x: 900 + maxDepth * 300, y: 35 };
      box(
        "result",
        "Outcome to source",
        "Result",
        current.acknowledgement
          ? `Source ${words(current.acknowledgement)}`
          : `Delivery: ${words(current.dispatch_state || "not recorded")}`,
        end,
        "recorded",
        () =>
          show("Outcome", {
            outcome: object(current.result),
            delivery: current.dispatch_state,
            acknowledgement: current.acknowledgement,
          }),
      );
      for (const o of state.obligations) edge(positions.get(o.id)!, end);
    }
    const tools = node("div", "", "map-tools");
    const fit = node("button", "Fit map to screen"),
      full = node("button", "Actual size"),
      focus = node("button", "Focus on pending work");
    fit.dataset.fitMap="true";
    fit.onclick = () =>
      canvas.style.setProperty(
        "zoom",
        String(
          Math.max(
            0.4,
            Math.min(
              1,
              (frame.clientWidth - 44) / width,
              Math.max(300, Math.min(600, window.innerHeight - 300)) / height,
            ),
          ),
        ),
      );
    full.onclick = () => canvas.style.setProperty("zoom", "1");
    focus.onclick = () => {
      canvas.classList.toggle("focus-pending");
      focus.classList.toggle("selected");
    };
    tools.append(fit);
    if(!options.compact)tools.append(full,focus);
    requestAnimationFrame(() => {
      if (canvas.isConnected) fit.click();
    });
    meta.append(tools);
    view.append(
      node(
        "p",
        "Arrows show prerequisites → dependent work. Accepted means the configured responsible-person rule was met; verified means an independent check. Provider acceptance is not confirmed delivery.",
        "muted",
      ),
    );
  }
  function communication() {
    view.replaceChildren();
    if (!data.contacts.length) {
      view.append(
        node("p", "No communication requests have been recorded yet.", "empty"),
      );
      return;
    }
    for (const row of [...data.contacts].reverse()) {
      const contact = object(row.contact) as RecordRow,
        group = data.state.obligations.find(
          (o) => o.id === contact.obligationId,
        )?.group;
      const trace = node("details", "", "communication-trace"),summaryRow=node("summary","","communication-summary");
      const sends = data.deliveries.filter((d) => d.contact_id === row.id),replies=data.receipts.filter(r=>sends.some(d=>d.id===r.delivery_id));
      summaryRow.append(node("strong",`${words(group || contact.actorId)} · ${words(contact.kind)}`),node("span",date(row.created_at),"muted"),node("span",`${sends.length} send${sends.length===1?"":"s"} · ${replies.length} repl${replies.length===1?"y":"ies"}`,"badge"));trace.append(summaryRow);
      trace.ontoggle=()=>{if(!trace.open)return;for(const other of view.querySelectorAll<HTMLDetailsElement>(".communication-trace"))if(other!==trace)other.open=false;};
      trace.append(node("p", String(contact.question ?? "")));
      const flow = node("div", "", "communication-chain");
      flow.append(
        node("div", `ILIEN → ${words(contact.actorId)}`, "channel-step"),
      );
      if (!sends.length)
        flow.append(
          node(
            "div",
            "Request recorded · No real channel send recorded",
            "channel-step waiting",
          ),
        );
      for (const send of sends) {
        const s = node("button", "", "channel-step");
        s.dataset.tone=statusTone(String(send.status));
        s.append(
          channelIcon(String(send.channel)),
          node("strong", words(send.channel)),
          node(
            "span",
            `${words(send.status)}${send.reason ? ` · ${words(send.reason)}` : ""}`,
          ),
        );
        s.onclick = () =>
          show("Outgoing message", {
            channel: send.channel,
            status: send.status,
            message: send.message_preview,
            previewTruncated: send.preview_truncated,
            reason: send.reason,
            created: date(send.created_at),
          });
        flow.append(s);
        for (const receipt of data.deliveryEvents.filter(
          (r) =>
            r.channel === send.channel &&
            r.provider_message_id === send.provider_message_id,
        )) {
          const r = node(
            "button",
            `Provider: ${words(receipt.event_type)}`,
            "channel-step",
          );
          r.onclick = () =>
            show(
              "Provider receipt",
              {
                channel: receipt.channel,
                event: receipt.event_type,
                time: date(receipt.occurred_at || receipt.created_at),
              },
              String(receipt.evidence_id),
            );
          flow.append(r);
        }
        for (const reply of data.receipts.filter(
          (r) => r.delivery_id === send.id,
        )) {
          const b = node(
            "button",
            `${words(reply.channel)} reply → ILIEN · ${words(reply.status)}`,
            "channel-step reply",
          );
          b.onclick = () =>
            show(
              "Incoming reply",
              {
                channel: reply.channel,
                status: reply.status,
                message: reply.message_preview,
                previewTruncated: reply.preview_truncated,
                reason: reply.reason,
                time: date(reply.created_at),
              },
              String(reply.evidence_id),
            );
          flow.append(b);
        }
      }
      trace.append(flow);
      view.append(trace);
    }
    const unlinked = data.receipts.filter(
      (r) => !data.deliveries.some((d) => d.id === r.delivery_id),
    );
    if (unlinked.length)
      view.append(
        node(
          "p",
          `${unlinked.length} replies have no matching send in this history window. See Activity; no connection has been guessed.`,
          "notice",
        ),
      );
  }
  function timeline() {
    view.replaceChildren();
    const entries: {
      time: string;
      title: string;
      body: unknown;
      evidence?: string;
    }[] = [
      {
        time: data.state.createdAt,
        title: "Original request received",
        body: {
          goal: data.state.goal,
          subject: data.state.subject,
          origin: data.state.origin,
        },
        evidence: data.state.sourceEvidenceId,
      },
    ];
    for (const r of data.journal)
      entries.push({
        time: String(r.created_at),
        title: `${words(r.action || "case updated")} · ${words(r.actor_id)}${r.origin === "simulated" ? " · Simulated response" : r.origin === "external" ? " · External evidence" : ""}`,
        body: {
          message: r.message_preview,
          reason: r.reason,
          revision: r.case_revision,
          parent: r.parent_id,
        },
        evidence: r.evidence_id ? String(r.evidence_id) : undefined,
      });
    for (const r of data.aiRuns ?? [])
      entries.push({
        time: String(r.created_at),
        title: `AI coordination · ${words(r.state)}`,
        body: {
          status: r.state,
          reason: r.reason,
          updated: date(r.updated_at),
        },
      });
    for (const r of data.deliveries)
      entries.push({
        time: String(r.created_at),
        title: `${words(r.channel)} outgoing request`,
        body: {
          status: r.status,
          reason: r.reason,
          message: r.message_preview,
          previewTruncated: r.preview_truncated,
        },
      });
    for (const r of data.receipts)
      entries.push({
        time: String(r.created_at),
        title: `${words(r.channel)} reply received`,
        body: {
          status: r.status,
          reason: r.reason,
          message: r.message_preview,
          previewTruncated: r.preview_truncated,
        },
        evidence: String(r.evidence_id),
      });
    for (const r of data.deliveryEvents)
      entries.push({
        time: String(r.occurred_at || r.created_at),
        title: `${words(r.channel)} provider: ${words(r.event_type)}`,
        body: { event: r.event_type },
        evidence: String(r.evidence_id),
      });
    for (const r of data.results)
      entries.push({
        time: String(r.created_at),
        title: r.current
          ? "Current outcome recorded"
          : "Earlier outcome (superseded)",
        body: {
          result: object(r.result),
          delivery: r.dispatch_state,
          acknowledgement: r.acknowledgement,
        },
      });
    const list = node("ol", "", "timeline");
    for (const e of entries.sort((a, b) => instant(a.time) - instant(b.time))) {
      const item = node("li"),
        b = node("button", e.title);
      b.onclick = () => show(e.title, e.body, e.evidence);
      item.append(node("time", date(e.time)), b);
      list.append(item);
    }
    view.append(list);
  }
  if(options.mode){host.dataset.view=options.mode;({"Workflow map":workflow,"Communication flow":communication,"Communication network":()=>renderCommunicationNetwork(view,data,evidence),Activity:timeline})[options.mode]();return;}
  const choices = [
    tab("Workflow map", workflow),
    tab("Communication flow", communication),
    tab("Communication network",()=>renderCommunicationNetwork(view,data,evidence)),
    tab("Activity", timeline),
  ];
  const active = choices.find((b) => b.textContent === selected) ?? choices[0]!;
  active.click();
}
