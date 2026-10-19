import type {
  CaseState,
  Policy,
} from "../../../packages/coordination/src/types.js";
type Config = {
  apiUrl: string;
  authDomain: string;
  clientId: string;
  redirectUri: string;
  redirectUris?: string[];
};
type Row = Record<string, unknown>;
const root = document.querySelector<HTMLDivElement>("#app")!;
let config: Config,
  token = "",
  expires = 0,
  role = "viewer",
  page = "Overview";
let content: HTMLElement;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const decode = <T>(v: T | string): T =>
  typeof v === "string" ? JSON.parse(v) : v;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = className;
  return n;
}
function notice(text: string, error = false) {
  const n = el("div", text, `notice ${error ? "error" : ""}`);
  n.setAttribute("role", error ? "alert" : "status");
  return n;
}
function toast(text: string) {
  const n = el("div", text, "toast");
  n.setAttribute("role", "status");
  document.body.append(n);
  setTimeout(() => n.remove(), 7000);
}
function button(text: string, action: () => unknown, primary = false) {
  const b = el("button", text, primary ? "primary" : "");
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Request failed");
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
function field(name: string, input: HTMLElement) {
  const l = el("label", name);
  l.append(input);
  return l;
}
function input(value = "", type = "text") {
  const n = el("input");
  n.type = type;
  n.value = value;
  return n;
}
function select(values: string[]) {
  const n = el("select");
  for (const v of values) {
    const o = el("option", v);
    o.value = v;
    n.append(o);
  }
  return n;
}
function card(title: string, parent: HTMLElement = content) {
  const n = el("section", "", "card");
  n.append(el("h2", title));
  parent.append(n);
  return n;
}
function json(value: unknown, parent: HTMLElement) {
  const n = el("pre", pretty(value));
  parent.append(n);
}
function details(title: string, value: unknown, parent: HTMLElement) {
  const d = el("details");
  d.append(el("summary", title));
  json(value, d);
  parent.append(d);
}
function table(
  rows: Row[],
  keys: string[],
  parent: HTMLElement,
  onSelect?: (row: Row) => unknown,
) {
  if (!rows.length) {
    parent.append(el("p", "Nothing here yet.", "empty"));
    return;
  }
  const wrap = el("div", "", "table-wrap"),
    t = el("table"),
    head = el("tr");
  for (const k of keys) head.append(el("th", k.replaceAll("_", " ")));
  if (onSelect) head.append(el("th", "Open"));
  const thead = el("thead");
  thead.append(head);
  t.append(thead);
  const body = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const k of keys)
      tr.append(
        el("td", typeof r[k] === "object" ? pretty(r[k]) : String(r[k] ?? "—")),
      );
    if (onSelect) {
      const td = el("td");
      td.append(button("Inspect", () => onSelect(r)));
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(body);
  wrap.append(t);
  parent.append(wrap);
}
async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  if (!token || Date.now() > expires) {
    token = "";
    loginScreen();
    throw new Error("Session expired. Sign in again.");
  }
  const response = await fetch(`${config.apiUrl}/console/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${data.error ?? "Request failed"} (${response.status})`);
  return data as T;
}
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function signIn() {
  const verifier = base64(crypto.getRandomValues(new Uint8Array(32))),
    state = base64(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(
    "ilien-pkce",
    JSON.stringify({ verifier, state, created: Date.now() }),
  );
  const challenge = base64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const url = new URL("/oauth2/authorize", config.authDomain);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  location.assign(url);
}
function signOut() {
  token = "";
  expires = 0;
  sessionStorage.removeItem("ilien-pkce");
  const url = new URL("/logout", config.authDomain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.redirectUri,
  }).toString();
  location.assign(url);
}
function loginScreen(message?: string) {
  root.replaceChildren();
  const c = el("main", "", "card login");
  c.append(
    el("div", "ILIEN", "brand"),
    el("h1", "Every conversation. One context."),
    el(
      "p",
      "Coordinate requests, collect evidence and bring verified outcomes back to their source.",
      "muted",
    ),
  );
  if (message) c.append(notice(message, true));
  c.append(
    button("Sign in to workspace", signIn, true),
    el("p", "Access is restricted to invited workspace members.", "muted"),
  );
  root.append(c);
}
function shell() {
  root.replaceChildren();
  const layout = el("div", "", "layout"),
    side = el("aside"),
    nav = el("nav");
  side.append(
    el("div", "ILIEN", "brand"),
    el("div", "Coordination workspace", "muted"),
  );
  for (const name of [
    "Overview",
    "Cases",
    "Simulator",
    "Channels",
    "Knowledge",
    "Settings",
    ...(role === "admin" ? ["Operations"] : []),
  ]) {
    const b = button(name, () => show(name));
    if (page === name) b.classList.add("active");
    nav.append(b);
  }
  side.append(
    nav,
    el("p", `Signed in · ${role}`, "muted"),
    button("Sign out", signOut),
  );
  const main = el("main", "", "main"),
    top = el("header", "", "top"),
    heading = el("div");
  heading.append(
    el("div", "Workspace / Textile & apparel", "eyebrow"),
    el("h1", page),
  );
  top.append(
    heading,
    el("span", "Synthetic source · Real channel adapters", "badge"),
  );
  content = el("div");
  main.append(
    top,
    content,
    el(
      "footer",
      "ILIEN coordinates information and decisions. Operational execution remains with the source.",
    ),
  );
  layout.append(side, main);
  root.append(layout);
}
async function show(name: string) {
  page = name;
  shell();
  content.append(el("p", "Loading…", "muted"));
  try {
    const tasks: Record<string, () => Promise<void>> = {
      Overview: overview,
      Cases: cases,
      Simulator: simulator,
      Channels: channels,
      Knowledge: knowledge,
      Settings: settings,
      Operations: operations,
    };
    content.replaceChildren();
    await tasks[name]!();
  } catch (e) {
    content.append(
      notice(e instanceof Error ? e.message : "Unable to load", true),
    );
  }
}
async function overview() {
  const [cases, events] = await Promise.all([
    api<{ items: Row[] }>("/cases"),
    api<{ items: Row[] }>("/events"),
  ]);
  const grid = el("div", "", "grid");
  content.append(grid);
  for (const [label, n] of [
    ["Recent cases", cases.items.length],
    ["Active", cases.items.filter((c) => c.status === "active").length],
    [
      "Needs attention",
      cases.items.filter((c) => c.status === "blocked" || c.status === "paused")
        .length,
    ],
    ["Completed", cases.items.filter((c) => c.status === "completed").length],
  ]) {
    const c = card(String(label), grid);
    c.append(el("span", String(n), "metric"));
  }
  content.append(
    el(
      "p",
      "Counts reflect the latest 50 cases. Refresh is manual; no background model calls.",
      "muted",
    ),
  );
  table(
    cases.items.slice(0, 8),
    ["workflow", "status", "revision", "updated_at"],
    card("Recent work"),
    (r) => casePage(String(r.id)),
  );
  table(
    events.items.slice(0, 8),
    ["event_type", "status", "disposition"],
    card("Source inbox"),
  );
  content.append(button("Refresh workspace", () => show("Overview")));
}
async function cases() {
  const data = await api<{ items: Row[] }>("/cases");
  table(
    data.items,
    ["workflow", "status", "revision", "updated_at"],
    card("Cases"),
    (r) => casePage(String(r.id)),
  );
}
async function casePage(id: string) {
  page = "Cases";
  shell();
  const state = await api<CaseState>(`/cases/${id}`),
    policy = await api<Policy>(`/cases/${id}/policy`);
  const heading = card(state.workflow);
  heading.append(
    el("p", state.goal),
    el("span", `${state.status} · revision ${state.revision}`, "badge"),
    el(
      "p",
      `${state.subject.type} / ${state.subject.id} / revision ${state.subject.revision}`,
      "muted",
    ),
  );
  details(
    "Case identity and bounds",
    {
      id: state.id,
      configuration: state.configurationVersion,
      deadline: state.deadline,
      sourceEvidenceId: state.sourceEvidenceId,
      missionRevision: state.missionRevision ?? 1,
    },
    heading,
  );
  heading.append(
    button("Read original evidence", async () =>
      json(
        await api(`/cases/${id}/evidence/${state.sourceEvidenceId}`),
        heading,
      ),
    ),
    button("Refresh case", () => casePage(id)),
  );
  const grid = el("div", "", "grid");
  content.append(grid);
  for (const o of state.obligations) {
    const c = card(o.group, grid);
    c.classList.add("node");
    c.dataset.status = o.status;
    c.append(
      el("span", o.status, "badge"),
      el("p", o.question),
      el("p", `${o.id} · ${o.assignee} · revision ${o.revision}`, "muted"),
    );
    if (o.dependencies.length)
      c.append(el("p", `Waiting on: ${o.dependencies.join(", ")}`));
    if (o.proposal) details("Bound proposal", o.proposal, c);
    if (o.decision) details("Recorded decision", o.decision, c);
    if (o.reply) details("Reported information", o.reply, c);
    if (o.verification) details("Verification", o.verification, c);
  }
  if (role !== "viewer") {
    const c = card("Participant simulator");
    c.append(
      notice(
        "Authenticated role-play for synthetic cases. Commands use the selected actor’s authority and do not represent real participant identity.",
      ),
    );
    const actor = select(
        policy.actors.filter((a) => a.enabled).map((a) => a.id),
      ),
      node = select(state.obligations.map((o) => o.id)),
      kind = select([
        "reply",
        "verify",
        "attach_proposal",
        "decide",
        "add_child",
        "link_dependency",
        "reassign",
        "reopen",
        "pause",
        "resume",
        "takeover",
        "release",
        "report",
        "cancel",
        "handoff",
        "adopt_configuration",
        "amend_subject",
      ]),
      editor = el("textarea");
    editor.classList.add("code");
    function draft() {
      const o = state.obligations.find((o) => o.id === node.value)!;
      const now = new Date().toISOString();
      const common = { obligationId: o.id };
      const map: Record<string, unknown> = {
        attach_proposal: {
          type: "attach_proposal",
          ...common,
          proposalId: o.proposal?.id ?? "proposal",
          proposalRevision: (o.proposal?.revision ?? 0) + 1,
          statement: "",
          reason: "",
        },
        decide: {
          type: "decide",
          ...common,
          expectedObligationRevision: o.revision,
          proposalHash: o.proposal?.sha256 ?? "",
          choice: "approve",
          reason: "",
          subjectRevision: state.subject.revision,
          observedAt: now,
          validUntil: new Date(Date.now() + 1800000).toISOString(),
        },
        reply: {
          type: "reply",
          ...common,
          expectedObligationRevision: o.revision,
          statement: "",
          observedAt: now,
          validUntil: new Date(Date.now() + 1800000).toISOString(),
          subjectRevision: state.subject.revision,
        },
        verify: {
          type: "verify",
          ...common,
          replyRevision: o.reply?.revision ?? 1,
          accept: true,
          reason: "",
        },
        add_child: {
          type: "add_child",
          parentId: o.id,
          obligationId: `child_${crypto.randomUUID().slice(0, 8)}`,
          group: policy.groups[0],
          kind: "fact",
          question: "",
        },
        link_dependency: {
          type: "link_dependency",
          ...common,
          dependencyId: "",
        },
        reassign: { type: "reassign", ...common, actorId: "", reason: "" },
        reopen: { type: "reopen", ...common, reason: "" },
        adopt_configuration: {
          type: "adopt_configuration",
          version: policy.version,
          reason: "",
        },
        amend_subject: {
          type: "amend_subject",
          subjectRevision: "",
          goal: state.goal,
          reason: "",
        },
      };
      editor.value = pretty(
        map[kind.value] ?? { type: kind.value, reason: "" },
      );
    }
    kind.onchange = draft;
    node.onchange = draft;
    draft();
    c.append(
      field("Actor", actor),
      field("Obligation", node),
      field("Operation", kind),
      field("Command body", editor),
      button(
        "Apply simulated command",
        async () => {
          await api(`/cases/${id}/commands`, {
            commandId: crypto.randomUUID(),
            expectedRevision: state.revision,
            actorId: actor.value,
            operation: JSON.parse(editor.value),
          });
          await casePage(id);
        },
        true,
      ),
    );
  }
  const tabs = card("Evidence, conversation and outcomes");
  const target = el("div");
  const row = el("div", "", "row");
  for (const section of [
    "journal",
    "contacts",
    "claims",
    "results",
    "rejections",
  ])
    row.append(
      button(section, async () => {
        target.replaceChildren();
        const data = await api<Row[]>(`/cases/${id}/${section}`);
        for (const item of data) {
          details(String(item.id ?? item.command_id ?? section), item, target);
          if (item.evidence_id)
            target.append(
              button("Read evidence", async () =>
                json(
                  await api(`/cases/${id}/evidence/${item.evidence_id}`),
                  target,
                ),
              ),
            );
          if (section === "results" && item.current && role !== "viewer") {
            const reason = input();
            target.append(
              field("Source acknowledgement reason", reason),
              button("Acknowledge result as simulated source", async () => {
                await api(`/cases/${id}/acknowledgements`, {
                  acknowledgementId: crypto.randomUUID(),
                  resultId: item.id,
                  disposition: "accepted",
                  reason: reason.value,
                });
                toast("Source acknowledgement recorded");
              }),
            );
          }
        }
        if (!data.length) target.append(el("p", "No records yet.", "empty"));
      }),
    );
  tabs.append(row, target);
  const ai = card("Agent investigation & review");
  ai.append(
    el(
      "p",
      "Bounded investigations spend model tokens only when requested or when eligible inbound receipts arrive. Every proposal needs review.",
      "muted",
    ),
  );
  if (role !== "viewer")
    ai.append(
      button(
        "Request investigation",
        async () => {
          const r = await api(`/cases/${id}/agent`, {
            requestId: crypto.randomUUID(),
          });
          json(r, ai);
        },
        true,
      ),
    );
  ai.append(
    button("Load agent runs", async () => {
      const data = await api<{ items: Row[] }>(`/cases/${id}/agent`);
      table(data.items, ["id", "state", "created_at"], ai, (r) =>
        runPage(String(r.id)),
      );
    }),
  );
}
async function runPage(id: string) {
  page = "Agent review";
  shell();
  const data = await api<Row>(`/ai/runs/${id}`);
  const c = card("Evidence-bound proposal");
  json(data, c);
  const run = (data.run ?? data) as Row;
  if (role !== "viewer" && run.proposal_hash) {
    const reason = input();
    c.append(field("Review reason", reason));
    for (const disposition of ["approve", "reject"])
      c.append(
        button(
          disposition === "approve"
            ? "Approve exact proposal"
            : "Reject proposal",
          async () => {
            await api(`/ai/runs/${id}/review`, {
              proposalHash: run.proposal_hash,
              disposition,
              reason: reason.value,
            });
            await runPage(id);
          },
        ),
      );
  }
}
async function simulator() {
  const c = card("Source event simulator");
  c.append(
    el(
      "p",
      "Choose a synthetic source event or author your own. Catalogue coverage does not mean every event has a configured workflow. Unmapped events enter triage.",
      "muted",
    ),
  );
  const catalog = (await fetch("/catalog.json").then((r) => r.json())) as {
    eventType: string;
    fixture: string;
    workflowSupported: boolean;
  }[];
  const choice = select([
      "material-readiness",
      "revision-acknowledgement",
      "maintenance-escalation",
      ...catalog.map((x) => x.eventType),
    ]),
    editor = el("textarea");
  editor.classList.add("code");
  editor.rows = 20;
  async function load() {
    const selected = catalog.find((c) => c.eventType === choice.value);
    const url = selected
      ? `/fixtures/${encodeURIComponent(selected.fixture)}`
      : `/examples/${choice.value}.event.json`;
    const event = await fetch(url).then((r) => r.json());
    event.eventId = crypto.randomUUID();
    event.occurredAt = new Date().toISOString();
    if (event.payload?.neededBy)
      event.payload.neededBy = new Date(Date.now() + 86400000).toISOString();
    editor.value = pretty(event);
  }
  choice.onchange = () => {
    void load().catch((e) => toast(String(e)));
  };
  await load();
  c.append(field("Event", choice), field("Editable original event", editor));
  if (role !== "viewer")
    c.append(
      button(
        "Submit source event",
        async () => {
          const r = await api("/events", JSON.parse(editor.value));
          json(r, c);
          toast("Event accepted. Refresh Cases to see processing.");
        },
        true,
      ),
    );
  c.append(
    button("New event identity", () => {
      const v = JSON.parse(editor.value);
      v.eventId = crypto.randomUUID();
      v.occurredAt = new Date().toISOString();
      editor.value = pretty(v);
    }),
  );
}
function jsonForm(
  parent: HTMLElement,
  title: string,
  path: string,
  seed: unknown,
) {
  const d = el("details");
  d.append(el("summary", title));
  const t = el("textarea");
  t.classList.add("code");
  t.value = pretty(seed);
  d.append(
    field("Request", t),
    button(
      "Save",
      async () => {
        const result = await api(path, JSON.parse(t.value));
        json(result, d);
        toast("Saved");
      },
      true,
    ),
  );
  parent.append(d);
}
async function channels() {
  const c = card("Communication channels");
  c.append(
    el(
      "p",
      "Bindings require recorded consent. Creating a binding can enable real delivery for future contacts. No personal contact is added automatically.",
      "muted",
    ),
  );
  const row = el("div", "", "row"),
    target = el("div");
  for (const section of [
    "bindings",
    "deliveries",
    "receipts",
    "delivery-events",
  ])
    row.append(
      button(section, async () => {
        target.replaceChildren();
        const data = await api<{ items: Row[] }>(`/channels/${section}`);
        if (!data.items.length)
          target.append(el("p", "No records yet.", "empty"));
        for (const item of data.items)
          details(String(item.id ?? section), item, target);
      }),
    );
  c.append(row, target);
  if (role === "admin")
    jsonForm(c, "Add or update a consented binding", "/channels/bindings", {
      actorId: "",
      channel: "email",
      address: "",
      consentRef: "",
      enabled: false,
      priority: 10,
    });
  if (role !== "viewer")
    jsonForm(c, "Explicit channel dispatch", "/channels/dispatch", {
      caseId: "",
      contactId: "",
      bindingId: "",
    });
}
async function knowledge() {
  const c = card("Approved knowledge");
  c.append(
    el(
      "p",
      "Only effective, non-revoked documents in the source’s scope are eligible for retrieval. Publishing a document does not change permissions.",
      "muted",
    ),
  );
  const data = await api<Row[]>("/ai/knowledge");
  table(
    data,
    ["document_key", "version", "group_id", "title", "revoked", "expires_at"],
    c,
  );
  if (role === "admin") {
    jsonForm(c, "Publish a version", "/ai/knowledge", {
      action: "publish",
      documentKey: "",
      version: 1,
      group: "",
      title: "",
      body: "",
      effectiveAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 2592000000).toISOString(),
    });
    jsonForm(c, "Revoke a document", "/ai/knowledge", {
      action: "revoke",
      id: "",
      reason: "",
    });
  }
}
async function settings() {
  const [configuration, ai] = await Promise.all([
    api<Row>("/configuration"),
    api<Row>("/ai/settings"),
  ]);
  const c = card("Workspace configuration");
  details("Current configuration", configuration, c);
  details("AI settings", ai, c);
  if (role === "admin") {
    c.append(
      button("Prepare maintenance workflow", () => {
        const policy = structuredClone(configuration.policy) as Policy;
        policy.version = `textile-${Date.now()}`;
        if (!policy.groups.includes("maintenance"))
          policy.groups.push("maintenance");
        for (const r of ["respondent", "verifier"] as const)
          if (
            !policy.actors.some(
              (a) => a.group === "maintenance" && a.role === r && a.enabled,
            )
          )
            policy.actors.push({
              id: `maintenance_${r}`,
              group: "maintenance",
              role: r,
              enabled: true,
            });
        const cfg = structuredClone(configuration.configuration) as {
          workflows: Row[];
        };
        cfg.workflows = cfg.workflows.filter(
          (w) => w.eventType !== "maintenance.breakdown_logged",
        );
        cfg.workflows.push({
          eventType: "maintenance.breakdown_logged",
          workflow: "maintenance-escalation-v1",
          goal: "Collect verified inspection, spare-part availability and scheduling impact. No maintenance or machine command is authorized.",
          requiredPayloadKeys: ["siteId", "machineId", "faultCode"],
          branches: [
            {
              group: "maintenance",
              kind: "evidence",
              question:
                "Report the current inspection finding and supporting evidence for the exact machine revision.",
            },
            {
              group: "procurement",
              kind: "fact",
              question:
                "Confirm availability and lead time for the parts identified by the inspection; request a child clarification if part identity is missing.",
            },
            {
              group: "planning",
              kind: "fact",
              question:
                "Report the schedule impact after inspection and parts information is available; establish dependencies as needed.",
            },
          ],
        });
        jsonForm(
          c,
          "Maintenance configuration: preview before publishing",
          "/configuration",
          {
            action: "preview",
            expectedRevision: configuration.revision,
            policy,
            configuration: cfg,
          },
        );
      }),
    );
    jsonForm(c, "Preview or publish configuration", "/configuration", {
      action: "preview",
      expectedRevision: configuration.revision,
      policy: configuration.policy,
      configuration: configuration.configuration,
    });
    jsonForm(c, "Update AI controls", "/ai/settings", {
      enabled: ai.enabled,
      autoReceipts: ai.auto_receipts,
      expectedRevision: ai.revision,
    });
    const m = card("Workspace access");
    table(
      (await api<{ items: Row[] }>("/members")).items,
      ["subject", "role", "enabled", "created_at"],
      m,
    );
    jsonForm(m, "Manage an existing identity", "/members", {
      subject: "",
      role: "viewer",
      enabled: true,
    });
  }
}
async function operations() {
  const data = await api<{
    controls: Record<string, unknown>;
    work: Row[];
    deliveries: Row[];
    audit: Row[];
    retention: Row[];
    caseChecks: Row[];
  }>("/operations");
  const c = card("Recovery & processing controls");
  c.append(
    notice(
      "Recovery changes require an operator reason and are audited. Pausing stops new work at the next gate; in-flight provider/model calls may already have happened. Uncertain outcomes require evidence review.",
    ),
  );
  details("Current controls", data.controls, c);
  const queues = card("Queue health");
  queues.append(
    button("Refresh queue counts", async () => {
      const snapshot = await api<{
        queues: Row[];
        dashboard?: string;
        observedAt: string;
      }>("/operations/queues");
      table(
        snapshot.queues,
        ["name", "visible", "inFlight", "delayed", "error"],
        queues,
      );
      queues.append(
        el("p", `Approximate counts · ${snapshot.observedAt}`, "muted"),
      );
      if (snapshot.dashboard) {
        const a = el("a", "Open CloudWatch dashboard");
        a.href = snapshot.dashboard;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        queues.append(a);
      }
    }),
  );
  table(
    data.work,
    ["lane", "id", "state", "attempts", "created_at"],
    card("Pending and interrupted work"),
  );
  table(
    data.caseChecks,
    ["case_id", "checked_revision", "status", "issues", "checked_at"],
    card("Independent structural supervision"),
  );
  table(
    data.deliveries,
    ["id", "channel", "status", "reason", "queue_attempts"],
    card("Delivery attention"),
  );
  const mutation = (title: string, body: Row) =>
    jsonForm(c, title, "/operations", {
      requestId: crypto.randomUUID(),
      reason: "",
      ...body,
    });
  mutation("Pause or resume processing", {
    action: "controls",
    expectedRevision: data.controls.revision,
    intakePaused: data.controls.intake_paused,
    agentPaused: data.controls.agent_paused,
    outboundPaused: data.controls.outbound_paused,
    resultsPaused: data.controls.results_paused,
    retentionDays: data.controls.retention_days,
    legalHold: data.controls.legal_hold,
  });
  mutation("Run bounded reconciliation", { action: "reconcile" });
  mutation("Requeue eligible durable work", {
    action: "requeue_work",
    lane: "intake",
    targetId: "",
  });
  mutation("Reconcile an uncertain provider send", {
    action: "resolve_delivery",
    targetId: "",
    outcome: "not_sent",
    evidenceRef: "",
  });
  mutation("Retry a definitively unsent delivery", {
    action: "retry_delivery",
    targetId: "",
    evidenceRef: "",
  });
  const r = card("Retention review");
  r.append(
    el(
      "p",
      "Legal hold is enabled by default. No evidence is automatically deleted. This action redacts eligible finished AI traces from aged terminal cases and retains hash tombstones; it does not erase original case evidence or backups.",
      "muted",
    ),
  );
  table(data.retention, ["id", "status", "updated_at", "eligible_traces"], r);
  jsonForm(r, "Redact eligible AI traces", "/operations", {
    requestId: crypto.randomUUID(),
    action: "redact_ai_traces",
    targetId: "",
    reason: "",
  });
  for (const row of data.audit)
    details(
      `${String(row.action)} · ${String(row.created_at)}`,
      row,
      card("Recovery audit"),
    );
  content.append(button("Refresh operations", () => show("Operations")));
}
async function boot() {
  config = await fetch("/config.json", { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("Workspace configuration unavailable");
    return r.json();
  });
  const localCallback = new URL("/", location.origin).href;
  if (config.redirectUris) {
    if (!config.redirectUris.includes(localCallback))
      throw new Error("This hostname is not an approved sign-in origin.");
    config.redirectUri = localCallback;
  } else if (config.redirectUri !== localCallback)
    throw new Error("Sign-in origin does not match workspace configuration.");
  const params = new URLSearchParams(location.search),
    code = params.get("code");
  if (params.has("error")) {
    history.replaceState(null, "", "/");
    loginScreen("Sign-in did not complete. Please try again.");
    return;
  }
  if (!code) {
    loginScreen();
    return;
  }
  const saved = sessionStorage.getItem("ilien-pkce");
  sessionStorage.removeItem("ilien-pkce");
  history.replaceState(null, "", "/");
  if (!saved) throw new Error("Sign-in state missing. Please start again.");
  const flow = JSON.parse(saved);
  if (params.get("state") !== flow.state || Date.now() - flow.created > 600000)
    throw new Error("Sign-in state expired. Please start again.");
  const response = await fetch(`${config.authDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code,
      code_verifier: flow.verifier,
    }),
    credentials: "omit",
  });
  if (!response.ok) throw new Error("Sign-in exchange failed.");
  const result = await response.json();
  token = result.access_token;
  expires = Date.now() + (result.expires_in - 30) * 1000;
  const me = await api<{ role: string }>("/me");
  role = me.role;
  await show("Overview");
}
void boot().catch((e) =>
  loginScreen(e instanceof Error ? e.message : "Unable to start workspace"),
);
