import { guestLogin, type GuestConfig } from "./guest-login.js";
import {
  renderJourney,
  summary,
  words,
  date,
  type Journey,
} from "./journey.js";
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
  guest?: GuestConfig | null;
};
type Row = Record<string, unknown>;
const root = document.querySelector<HTMLDivElement>("#app")!;
let config: Config,
  token = "",
  expires = 0,
  role = "viewer",
  page = "Overview";
let content: HTMLElement;
let stopLive: (() => void) | undefined;
const pageLabels: Record<string, string> = {
  Overview: "Home",
  Cases: "Requests",
  Tasks: "Tasks",
  Simulator: "Start a scenario",
  Activity: "Activity",
  Settings: "Settings",
  Channels: "People & channels",
  Knowledge: "Reference library",
  Operations: "Advanced operations",
  "Agent review": "AI suggestion",
};
const label = (value: unknown) => pageLabels[String(value)] ?? words(value);
function options(entries: { value: string; label: string }[]) {
  const n = el("select");
  for (const e of entries) {
    const o = el("option", e.label);
    o.value = e.value;
    n.append(o);
  }
  return n;
}
function fold(title: string, parent: HTMLElement) {
  const d = el("details", "", "advanced");
  d.append(el("summary", title));
  parent.append(d);
  return d;
}
function required(n: HTMLInputElement | HTMLTextAreaElement, title: string) {
  if (!n.value.trim()) throw new Error(`Please enter ${title.toLowerCase()}.`);
  return n.value.trim();
}

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
  summary(value, parent);
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
  for (const k of keys) head.append(el("th", label(k)));
  if (onSelect) head.append(el("th", "Open"));
  const thead = el("thead");
  thead.append(head);
  t.append(thead);
  const body = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const k of keys)
      tr.append(
        el(
          "td",
          r[k] !== null && typeof r[k] === "object"
            ? Object.entries(r[k] as Row)
                .map(([a, b]) => `${words(a)}: ${String(b)}`)
                .join(" · ")
            : /(_at|At|deadline)$/.test(k) && r[k]
              ? date(r[k])
              : [
                    "status",
                    "state",
                    "disposition",
                    "event_type",
                    "channel",
                    "role",
                  ].includes(k)
                ? words(r[k] ?? "Not recorded")
                : String(r[k] ?? "—"),
        ),
      );
    if (onSelect) {
      const td = el("td");
      td.append(button("Open", () => onSelect(r)));
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
  if (!response.ok) {
    const messages: Record<string, string> = {
      stale_case_revision:
        "This request changed. Refresh it before trying again.",
      stale_revision: "This request changed. Refresh it before trying again.",
      stale_contact:
        "This message request is out of date. Refresh the request.",
      source_not_authorized:
        "Your account is not connected to this workspace. Ask the administrator.",
      actor_not_authorized: "This participant cannot perform that action.",
      independent_verifier_required:
        "Choose an independent verifier to check this answer.",
      invalid_operator_token:
        "Your sign-in session is no longer valid. Sign in again.",
    };
    throw new Error(
      messages[data.error] ??
        `${words(data.error ?? "Unable to complete this action")}. Please review the form and try again.`,
    );
  }
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
  if (config?.guest)
    guestLogin(
      c,
      config.guest,
      config.clientId,
      async (accessToken, expiresIn) => {
        token = accessToken;
        expires = Date.now() + (expiresIn - 30) * 1000;
        const me = await api<{ role: string }>("/me");
        role = me.role;
        page = "Overview";
        await show("Overview");
      },
    );
  c.append(
    button(
      config?.guest ? "Sign in with your own account" : "Sign in to workspace",
      signIn,
      !config?.guest,
    ),
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
    "Tasks",
    "Simulator",
    "Activity",
    ...(role === "admin" ? ["Settings"] : []),
  ]) {
    const b = button(label(name), () => show(name));
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
    el("div", "Your coordination workspace", "eyebrow"),
    el("h1", label(page)),
  );
  top.append(heading, el("span", "Communication workspace", "badge"));
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
  stopLive?.();
  stopLive = undefined;
  page = name;
  shell();
  content.append(el("p", "Loading…", "muted"));
  try {
    const tasks: Record<string, () => Promise<void>> = {
      Overview: overview,
      Cases: cases,
      Tasks: pendingTasks,
      Activity: activity,
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
function requestList(items: Row[], parent: HTMLElement) {
  if (!items.length) {
    parent.append(
      el(
        "p",
        "No requests yet. Start a scenario to see how a request moves between people.",
        "empty",
      ),
    );
    return;
  }
  for (const r of items) {
    const c = el("article", "", "request-item");
    const subject = r.subject ? decode(r.subject as Row | string) : {};
    c.append(
      el("span", words(r.status), "badge"),
      el("h3", String(subject.id ?? words(r.workflow))),
      el("p", String(r.goal ?? words(r.workflow))),
      el(
        "p",
        `Updated ${date(r.updated_at)}${r.deadline ? ` · Due ${date(r.deadline)}` : ""}`,
        "muted",
      ),
      button("Open request", () => casePage(String(r.id))),
    );
    parent.append(c);
  }
}
async function overview() {
  const data = await api<{ items: Row[] }>("/cases");
  const grid = el("div", "", "grid");
  content.append(grid);
  for (const [title, n] of [
    ["Requests", data.items.length],
    ["In progress", data.items.filter((c) => c.status === "active").length],
    [
      "Needs attention",
      data.items.filter((c) => ["blocked", "paused"].includes(String(c.status)))
        .length,
    ],
    ["Completed", data.items.filter((c) => c.status === "completed").length],
  ]) {
    const c = card(String(title), grid);
    c.append(el("span", String(n), "metric"));
  }
  const welcome = card("Keep every conversation moving");
  welcome.append(
    el(
      "p",
      "Start a request, see who needs to respond, and follow the evidence through to an outcome.",
    ),
    button("Start a scenario", () => show("Simulator"), true),
    button("View tasks", () => show("Tasks")),
  );
  requestList(data.items.slice(0, 6), card("Recent requests"));
  content.append(
    el(
      "p",
      "Showing the latest 50 requests. Counts are for this recent window.",
      "muted",
    ),
    button("Refresh", () => show("Overview")),
  );
}
async function cases() {
  const data = await api<{ items: Row[] }>("/cases");
  const c = card("Find a request"),
    search = input(),
    status = options(
      [
        "all",
        "active",
        "blocked",
        "paused",
        "completed",
        "cancelled",
        "handed_off",
      ].map((value) => ({
        value,
        label: value === "all" ? "All statuses" : words(value),
      })),
    ),
    list = el("div");
  search.placeholder = "Search by subject or request";
  function render() {
    list.replaceChildren();
    requestList(
      data.items.filter(
        (r) =>
          (status.value === "all" || r.status === status.value) &&
          JSON.stringify(r).toLowerCase().includes(search.value.toLowerCase()),
      ),
      list,
    );
  }
  search.oninput = render;
  status.onchange = render;
  c.append(
    field("Search", search),
    field("Status", status),
    el("p", "Latest 50 requests", "muted"),
    list,
  );
  render();
}
async function pendingTasks() {
  const data = await api<{ items: Row[] }>("/tasks");
  const c = card("Work waiting for a response");
  c.append(
    el(
      "p",
      "Shared task list for this workspace, grouped by responsible person. These are not all personally assigned to you. Latest 100 pending tasks.",
      "muted",
    ),
  );
  for (const r of data.items) {
    const item = el("article", "", "request-item");
    item.append(
      el("span", words(r.status), "badge"),
      el("h3", String(r.question)),
      el(
        "p",
        `${words(r.department)} · ${words(r.owner)} · ${String(r.subject)}`,
        "muted",
      ),
      button("Open request", () => casePage(String(r.case_id))),
    );
    c.append(item);
  }
  if (!data.items.length) c.append(el("p", "No pending tasks.", "empty"));
}
async function activity() {
  const data = await api<{ items: Row[] }>("/cases");
  const c = card("Follow a conversation");
  c.append(
    el(
      "p",
      "Choose a request to see its workflow map, channel flow and complete available activity.",
    ),
  );
  requestList(data.items, c);
}
async function casePage(id: string) {
  stopLive?.();
  stopLive = undefined;
  page = "Cases";
  shell();
  const [journey, policy] = await Promise.all([
    api<Journey>(`/cases/${id}/journey`),
    api<Policy>(`/cases/${id}/policy`),
  ]);
  const state = journey.state;
  const heading = card(`${words(state.subject.type)} · ${state.subject.id}`);
  heading.append(
    el("span", words(state.status), "badge"),
    el("p", state.goal),
    el(
      "p",
      `Due ${date(state.deadline)} · Source: ${state.origin === "simulated" ? "Simulated event" : "Recorded request"}`,
      "muted",
    ),
    button("Refresh request", () => casePage(id)),
    button("Back to requests", () => show("Cases")),
  );
  const evidenceHost = el("div");
  async function evidence(evidenceId: string) {
    const data = await api<Row>(`/cases/${id}/evidence/${evidenceId}`);
    evidenceHost.replaceChildren(el("h3", "Original evidence"));
    let original: unknown = data.original_text;
    try {
      original = JSON.parse(String(data.original_text));
    } catch {}
    summary(original, evidenceHost);
    details(
      "Evidence integrity",
      {
        received: date(data.received_at),
        origin: data.origin,
        sha256: data.sha256,
      },
      evidenceHost,
    );
    evidenceHost.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  heading.append(
    button("Read original request", () => evidence(state.sourceEvidenceId)),
  );
  const map = card("Request journey"),
    controls = el("div", "", "row"),
    mapHost = el("div"),
    live = input("", "checkbox"),
    status = el("span", "Updates are off", "muted");
  let disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    refreshing = false;
  let current = journey;
  const draw = () => renderJourney(mapHost, current, evidence);
  async function refresh() {
    if (refreshing || disposed || document.hidden) return;
    refreshing = true;
    try {
      const next = await api<Journey>(`/cases/${id}/journey`);
      if (disposed) return;
      const changed = next.state.revision !== state.revision;
      const changedHistory =
        JSON.stringify({ ...current, observedAt: "" }) !==
        JSON.stringify({ ...next, observedAt: "" });
      current = next;
      if (changedHistory) draw();
      status.textContent = changed
        ? "New activity received. Refresh the request before taking an action."
        : `Updated ${date(next.observedAt)}`;
    } catch (e) {
      if (!disposed)
        status.textContent =
          e instanceof Error ? e.message : "Could not update. Retry.";
    } finally {
      refreshing = false;
    }
  }
  function schedule() {
    if (live.checked && !disposed)
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, 10000);
  }
  live.onchange = () => {
    if (timer) clearTimeout(timer);
    status.textContent = live.checked
      ? "Watching for new activity every 10 seconds"
      : "Updates are off";
    schedule();
  };
  stopLive = () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  };
  controls.append(
    button("Update map", refresh),
    field("Live updates", live),
    status,
  );
  map.append(controls, mapHost);
  draw();
  content.append(evidenceHost);
  const requiredWork = state.obligations.filter(
    (o) => o.required && o.status !== "verified",
  );
  const next = card("What needs to happen next");
  next.append(
    el(
      "p",
      requiredWork.length
        ? `${requiredWork.length} required answers still need verification. ${state.status === "paused" ? "Processing is paused." : ""}`
        : state.status === "completed"
          ? "The request has a completed outcome. Check the source acknowledgement below."
          : "Required answers are verified. Review the outcome before reporting back.",
    ),
  );
  const grid = el("div", "", "grid");
  next.append(grid);
  for (const o of state.obligations) {
    const c = card(words(o.group), grid);
    c.dataset.status = o.status;
    c.classList.add("node");
    c.append(
      el("span", words(o.status), "badge"),
      el("p", o.question),
      el("p", `Responsible: ${words(o.assignee)}`, "muted"),
    );
    if (o.dependencies.length)
      c.append(
        el(
          "p",
          `Waiting for: ${o.dependencies.map((d) => state.obligations.find((n) => n.id === d)?.question ?? d).join("; ")}`,
        ),
      );
    if (o.reply)
      c.append(
        el("p", o.reply.statement),
        el("p", `Answer valid until ${date(o.reply.validUntil)}`, "muted"),
      );
    if (o.verification)
      c.append(el("p", `Verified by ${words(o.verification.actorId)}`));
    if (o.proposal) details("Proposal to decide", o.proposal, c);
    if (o.decision) details("Decision", o.decision, c);
  }
  if (role !== "viewer") {
    caseActions(state, policy, id);
    const send = card("Send through a connected channel");
    send.append(
      el(
        "p",
        "This sends a real message to a consented recipient. A simulated reply is never a channel receipt.",
        "muted",
      ),
    );
    const bindings = await api<{ items: Row[] }>("/channels/bindings");
    const contact = options(
        journey.contacts.map((r) => {
          const c = decode(r.contact as Row | string);
          return {
            value: String(r.id),
            label: `${words(c.actorId)} · ${String(c.question)}`,
          };
        }),
      ),
      binding = el("select"),
      preview = el("p");
    function eligible() {
      binding.replaceChildren();
      const r = journey.contacts.find((r) => r.id === contact.value);
      const c = r ? decode(r.contact as Row | string) : {};
      for (const b of bindings.items.filter(
        (b) => b.enabled && b.actor_id === c.actorId,
      )) {
        const o = el("option", `${words(b.channel)} · ${String(b.address)}`);
        o.value = String(b.id);
        binding.append(o);
      }
      preview.textContent = binding.options.length
        ? "The selected recipient will receive this request."
        : "No enabled, consented channel for this person. Ask an admin to connect a recipient in Settings.";
    }
    contact.onchange = eligible;
    eligible();
    send.append(
      field("Request to send", contact),
      field("Recipient and channel", binding),
      preview,
      button(
        "Send real message",
        async () => {
          if (!contact.value || !binding.value)
            throw new Error("Select a request and an enabled recipient.");
          if (!confirm("Send this request to the selected real recipient now?"))
            return;
          await api("/channels/dispatch", {
            caseId: id,
            contactId: contact.value,
            bindingId: binding.value,
          });
          toast(
            "Delivery queued. Follow its actual status in Communication flow.",
          );
          await casePage(id);
        },
        true,
      ),
    );
  }
  const outcomes = card("Outcome and source response");
  if (!journey.results.length)
    outcomes.append(el("p", "No outcome has been recorded yet.", "empty"));
  for (const r of journey.results) {
    const item = el("article", "", "request-item");
    item.append(
      el("h3", r.current ? "Current outcome" : "Earlier outcome"),
      el(
        "p",
        `Source delivery: ${words(r.dispatch_state ?? "not recorded")} · Acknowledgement: ${words(r.acknowledgement ?? "not received")}`,
      ),
    );
    summary(decode(r.result as Row | string), item);
    if (r.current && !r.acknowledgement && role !== "viewer") {
      const reason = input();
      item.append(
        field("Why is the source accepting this outcome?", reason),
        button("Simulate source acknowledgement", async () => {
          await api(`/cases/${id}/acknowledgements`, {
            acknowledgementId: crypto.randomUUID(),
            resultId: r.id,
            disposition: "accepted",
            reason: required(reason, "a reason"),
          });
          await casePage(id);
        }),
      );
    }
    outcomes.append(item);
  }
  const ai = card("AI assistance");
  ai.append(
    el(
      "p",
      "Ask the assistant to review the evidence and suggest a next step. Suggestions require review; requesting a review uses model tokens.",
      "muted",
    ),
  );
  if (role !== "viewer")
    ai.append(
      button("Ask AI to review this request", async () => {
        await api(`/cases/${id}/agent`, { requestId: crypto.randomUUID() });
        toast("Review requested. Check suggestions when ready.");
      }),
    );
  ai.append(
    button("View suggestions", async () => {
      const runs = await api<{ items: Row[] }>(`/cases/${id}/agent`);
      table(runs.items, ["state", "created_at"], ai, (r) =>
        runPage(String(r.id)),
      );
    }),
  );
  if (role === "admin")
    details(
      "Advanced request identifiers",
      {
        id: state.id,
        revision: state.revision,
        configuration: state.configurationVersion,
        sourceEvidenceId: state.sourceEvidenceId,
      },
      heading,
    );
}
function caseActions(state: CaseState, policy: Policy, id: string) {
  const c = card("Practice a response");
  c.append(
    notice(
      "Simulation only: act as a participant to explore this case. These actions are labelled as role-play and do not send WhatsApp or email messages.",
    ),
  );
  const labels: Record<string, string> = {
    reply: "Provide information",
    verify: "Check an answer",
    attach_proposal: "Propose a decision",
    decide: "Approve or reject a proposal",
    add_child: "Ask for additional information",
    link_dependency: "Wait for another task",
    reassign: "Change responsible person",
    reopen: "Ask again",
    pause: "Pause request",
    resume: "Resume request",
    takeover: "Take manual control",
    release: "Return to automatic coordination",
    report: "Prepare source report",
    cancel: "Cancel request",
    handoff: "Hand over request",
    adopt_configuration: "Use updated workflow settings",
    amend_subject: "Correct request details",
  };
  const actor = options(
      policy.actors
        .filter((a) => a.enabled)
        .map((a) => ({
          value: a.id,
          label: `${words(a.id)} · ${words(a.role)}`,
        })),
    ),
    task = options(
      state.obligations.map((o) => ({
        value: o.id,
        label: `${words(o.group)} · ${o.question}`,
      })),
    ),
    action = options(
      Object.entries(labels).map(([value, label]) => ({ value, label })),
    ),
    fields = el("div");
  let read = () => ({}) as Row;
  function draft() {
    fields.replaceChildren();
    const o = state.obligations.find((n) => n.id === task.value);
    const now = new Date().toISOString(),
      end = new Date(Date.now() + 1800000).toISOString();
    if (!o) {
      fields.append(el("p", "No task available."));
      return;
    }
    const previousActor = actor.value;
    actor.replaceChildren();
    const eligibleActors = policy.actors.filter(
      (a) =>
        a.enabled &&
        (action.value === "verify"
          ? a.role === "verifier" &&
            a.group === o.group &&
            a.id !== o.reply?.actorId
          : ["reply", "decide"].includes(action.value)
            ? a.id === o.assignee
            : ["add_child"].includes(action.value)
              ? a.role === "coordinator" || a.id === o.assignee
              : a.role === "coordinator"),
    );
    for (const a of eligibleActors) {
      const option = el("option", `${words(a.id)} · ${words(a.role)}`);
      option.value = a.id;
      actor.append(option);
    }
    if (eligibleActors.some((a) => a.id === previousActor))
      actor.value = previousActor;
    const base = { obligationId: o.id };
    const seeds: Record<string, Row> = {
      reply: {
        type: "reply",
        ...base,
        expectedObligationRevision: o.revision,
        statement: "",
        observedAt: now,
        validUntil: end,
        subjectRevision: state.subject.revision,
      },
      verify: {
        type: "verify",
        ...base,
        replyRevision: o.reply?.revision ?? 1,
        accept: true,
        reason: "",
      },
      attach_proposal: {
        type: "attach_proposal",
        ...base,
        proposalId:
          o.proposal?.id ?? `proposal_${crypto.randomUUID().slice(0, 8)}`,
        proposalRevision: (o.proposal?.revision ?? 0) + 1,
        statement: "",
        reason: "",
      },
      decide: {
        type: "decide",
        ...base,
        expectedObligationRevision: o.revision,
        proposalHash: o.proposal?.sha256 ?? "",
        choice: "approve",
        reason: "",
        subjectRevision: state.subject.revision,
        observedAt: now,
        validUntil: end,
      },
      add_child: {
        type: "add_child",
        parentId: o.id,
        obligationId: `child_${crypto.randomUUID().slice(0, 8)}`,
        group: policy.groups[0],
        kind: "fact",
        question: "",
      },
      link_dependency: { type: "link_dependency", ...base, dependencyId: "" },
      reassign: { type: "reassign", ...base, actorId: "", reason: "" },
      reopen: { type: "reopen", ...base, reason: "" },
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
    const seed = seeds[action.value] ?? { type: action.value, reason: "" };
    read = formFields(seed, fields, {
      hidden: [
        "type",
        "obligationId",
        "parentId",
        "proposalId",
        "proposalRevision",
        "expectedObligationRevision",
        "replyRevision",
        "proposalHash",
        ...(action.value !== "amend_subject" ? ["subjectRevision"] : []),
      ],
      choices: {
        group: policy.groups,
        kind: ["fact", "decision", "acknowledgement", "evidence", "commitment"],
        choice: ["approve", "reject"],
        actorId: policy.actors.filter((a) => a.enabled).map((a) => a.id),
        dependencyId: state.obligations
          .filter((n) => n.id !== o.id)
          .map((n) => n.id),
      },
    });
    if (action.value === "verify")
      fields.prepend(
        el(
          "p",
          o.reply
            ? `Answer to check: ${o.reply.statement}`
            : "No answer has been recorded for this task.",
        ),
      );
    if (action.value === "decide")
      fields.prepend(
        el(
          "p",
          o.proposal
            ? `Exact proposal: ${o.proposal.statement}`
            : "Record a proposal before deciding.",
        ),
      );
  }
  action.onchange = draft;
  task.onchange = draft;
  draft();
  c.append(
    field("Act as", actor),
    field("Task", task),
    field("What do you want to do?", action),
    fields,
    button(
      "Record simulated response",
      async () => {
        if (!actor.value)
          throw new Error(
            "No eligible participant for this action. Ask an administrator to review the workflow.",
          );
        await api(`/cases/${id}/commands`, {
          commandId: crypto.randomUUID(),
          expectedRevision: state.revision,
          actorId: actor.value,
          operation: read(),
        });
        await casePage(id);
      },
      true,
    ),
  );
}
async function runPage(id: string) {
  stopLive?.();
  stopLive = undefined;
  page = "Agent review";
  shell();
  const data = await api<Row>(`/ai/runs/${id}`);
  const c = card("Evidence-bound proposal");
  const run = (data.run ?? data) as Row;
  c.append(el("span", words(run.state), "badge"));
  let proposal = run.proposal;
  try {
    proposal = decode(proposal as Row | string);
  } catch {}
  if (proposal && typeof proposal === "object") {
    const p = proposal as Row,
      operation = p.operation as Row | null;
    c.append(el("p", String(p.reason ?? "")));
    if (operation) {
      const state = await api<CaseState>(`/cases/${run.case_id}`);
      const task = state.obligations.find(
        (o) => o.id === operation.obligationId || o.id === operation.parentId,
      );
      summary(
        {
          suggestedAction: words(operation.type),
          task: task?.question,
          department: task ? words(task.group) : undefined,
          ...Object.fromEntries(
            Object.entries(operation).filter(([k]) =>
              [
                "statement",
                "question",
                "reason",
                "choice",
                "group",
                "accept",
                "goal",
              ].includes(k),
            ),
          ),
        },
        c,
      );
    }
    if (Array.isArray(p.uncertainties) && p.uncertainties.length)
      details("What remains uncertain", p.uncertainties, c);
    if (Array.isArray(p.citations))
      for (const quote of p.citations as Row[])
        c.append(el("blockquote", String(quote.quote)));
  } else
    summary({ message: "No suggestion is ready yet.", reason: run.reason }, c);
  if (data.review) details("Review decision", data.review, c);
  if (role === "admin") details("Advanced investigation details", data, c);
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
              reason: required(reason, "a review reason"),
            });
            await runPage(id);
          },
        ),
      );
  }
}
function formFields(
  seed: Row,
  parent: HTMLElement,
  settings: { hidden?: string[]; choices?: Record<string, string[]> } = {},
) {
  const readers: Record<string, () => unknown> = {};
  const labels: Record<string, string> = {
    statement: "Your information",
    reason: "Reason or supporting evidence",
    observedAt: "When was this observed?",
    validUntil: "Valid until",
    subjectRevision: "Subject version",
    actorId: "Responsible person",
    dependencyId: "Task to wait for",
    group: "Department",
    kind: "Information needed",
    accept: "Does this answer pass verification?",
    enabled: "Enabled",
    consentRef: "Consent reference",
    address: "Email address or international phone number",
    expectedRevision: "Settings version",
    autoReceipts: "Request AI review for incoming replies",
    intakePaused: "Pause new requests",
    agentPaused: "Pause AI reviews",
    outboundPaused: "Pause outgoing messages",
    resultsPaused: "Pause source reports",
    legalHold: "Keep data on legal hold",
    targetId: "Record reference",
    retentionDays: "Retention period (days)",
    requestId: "Change reference",
    action: "Action",
    role: "Access role",
  };
  for (const [key, value] of Object.entries(seed)) {
    if (settings.hidden?.includes(key)) {
      readers[key] = () => value;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const d = fold(label(key), parent);
      const readObject = formFields(value as Row, d, settings);
      if (key === "payload") {
        const extra = fold("Additional information fields", d),
          names: { key: HTMLInputElement; value: HTMLInputElement }[] = [];
        extra.append(
          button("Add information field", () => {
            const name = input(),
              text = input(),
              row = el("div", "", "form-group");
            names.push({ key: name, value: text });
            row.append(field("Field name", name), field("Value", text));
            extra.append(row);
          }),
        );
        readers[key] = () => {
          const out = readObject();
          for (const item of names) {
            const name = required(item.key, "a field name");
            if (
              !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name) ||
              ["constructor", "prototype"].includes(name) ||
              Object.hasOwn(out, name)
            )
              throw new Error(
                "Use a unique field name containing letters, numbers or underscores.",
              );
            out[name] = required(item.value, "a field value");
          }
          return out;
        };
      } else readers[key] = readObject;
      continue;
    }
    const templates: Record<string, Row> = {
      workflows: {
        eventType: "",
        workflow: "",
        goal: "",
        requiredPayloadKeys: ["siteId"],
        branches: [{ group: "", kind: "fact", question: "" }],
      },
      actors: { id: "", group: "", role: "respondent", enabled: true },
      branches: { group: "", kind: "fact", question: "" },
    };
    if (
      Array.isArray(value) &&
      (templates[key] || value.some((v) => v && typeof v === "object"))
    ) {
      const d = fold(label(key), parent),
        list = el("div");
      d.append(list);
      const entries: { read: () => Row; box: HTMLElement }[] = [];
      function appendItem(seed: Row) {
        const box = el("section", "", "form-group");
        const read = formFields(seed, box, settings);
        const entry = { read, box };
        entries.push(entry);
        box.append(
          button("Remove item", () => {
            entries.splice(entries.indexOf(entry), 1);
            box.remove();
          }),
        );
        list.append(box);
      }
      for (const v of value) appendItem(v as Row);
      if (templates[key])
        d.append(
          button("Add item", () =>
            appendItem(structuredClone(templates[key]!)),
          ),
        );
      readers[key] = () => entries.map((e) => e.read());
      continue;
    }
    if (key === "whatsappTemplate" && value === null) {
      const d = fold("Optional approved WhatsApp template", parent),
        enabled = input("", "checkbox"),
        body = el("div");
      const read = formFields(
        { name: "", language: "en", approvalRef: "", enabled: true },
        body,
        settings,
      );
      body.hidden = true;
      enabled.onchange = () => (body.hidden = !enabled.checked);
      d.append(field("Configure an approved template", enabled), body);
      readers[key] = () => (enabled.checked ? read() : null);
      continue;
    }
    let n: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const choices =
      settings.choices?.[key] ??
      (
        {
          channel: ["email", "whatsapp"],
          role: ["viewer", "operator", "admin"],
          choice: ["approve", "reject"],
          outcome: ["not_sent", "accepted"],
        } as Record<string, string[]>
      )[key];
    const isDate = typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value);
    if (typeof value === "boolean") {
      n = options([
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ]);
      n.value = String(value);
      readers[key] = () => n.value === "true";
    } else if (choices) {
      n = options(choices.map((v) => ({ value: v, label: words(v) })));
      if (choices.includes(String(value))) n.value = String(value);
      readers[key] = () => n.value;
    } else if (Array.isArray(value)) {
      n = el("textarea");
      n.value = value.join("\n");
      n.rows = 3;
      readers[key] = () =>
        n.value
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean);
    } else {
      n =
        typeof value === "string" &&
        (value.length > 110 ||
          ["statement", "reason", "body", "goal", "question"].includes(key))
          ? el("textarea")
          : input();
      n.value = value === null ? "" : String(value);
      if (n instanceof HTMLInputElement)
        n.type =
          typeof value === "number"
            ? "number"
            : isDate
              ? "datetime-local"
              : "text";
      if (isDate)
        n.value = new Date(
          Date.parse(String(value)) - new Date().getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16);
      readers[key] = () => {
        if (value === null && !n.value) return null;
        const text = n.value.trim();
        if (typeof value === "number") {
          const result = Number(text);
          if (!text || !Number.isFinite(result))
            throw new Error(`Enter a number for ${label(key)}.`);
          return result;
        }
        if (isDate) {
          const result = new Date(text);
          if (!Number.isFinite(result.getTime()))
            throw new Error(`Enter a valid time for ${label(key)}.`);
          return result.toISOString();
        }
        if (!text)
          throw new Error(`Please enter ${labels[key] ?? label(key)}.`);
        return text;
      };
    }
    parent.append(field(labels[key] ?? label(key), n));
  }
  return () =>
    Object.fromEntries(
      Object.entries(readers).map(([key, read]) => [key, read()]),
    );
}
async function simulator() {
  const c = card("Start a practice request");
  c.append(
    notice(
      "The source event is simulated. Connected channel sends are real if enabled recipients are configured. This form does not create real factory data.",
    ),
  );
  const catalog = (await fetch("/catalog.json").then((r) => r.json())) as {
    eventType: string;
    fixture: string;
    workflowSupported: boolean;
  }[];
  const choice = options([
    {
      value: "material-readiness",
      label: "Material readiness · stock, quality and supplier information",
    },
    {
      value: "revision-acknowledgement",
      label: "Revision acknowledgement · confirm a changed specification",
    },
    {
      value: "maintenance-escalation",
      label:
        "Maintenance · inspection, parts and scheduling (requires configured workflow)",
    },
  ]);
  c.append(button("Create a custom source event", () => load("custom")));
  const fields = el("div"),
    feedback = el("div");
  let custom = false;
  let event: Row = {},
    read = () => ({}) as Row;
  async function load(value: string) {
    feedback.replaceChildren();
    const selected = catalog.find((c) => c.eventType === value);
    const url = selected
      ? `/fixtures/${encodeURIComponent(selected.fixture)}`
      : `/examples/${value}.event.json`;
    custom = value === "custom";
    event = custom
      ? {
          contractVersion: "1.0",
          eventId: crypto.randomUUID(),
          eventType: "custom.information_requested",
          payloadVersion: "1.0",
          occurredAt: new Date().toISOString(),
          correlationId: crypto.randomUUID(),
          subject: { type: "request", id: "my-request", revision: "1" },
          payload: {
            siteId: "my-site",
            requestedInformation: ["Describe the information you need"],
          },
        }
      : await fetch(url).then((r) => r.json());
    event.eventId = crypto.randomUUID();
    event.occurredAt = new Date().toISOString();
    const payload = event.payload as Row;
    if (payload?.neededBy)
      payload.neededBy = new Date(Date.now() + 86400000).toISOString();
    fields.replaceChildren(el("h3", words(event.eventType)));
    read = formFields(event, fields, {
      hidden: [
        "eventId",
        "occurredAt",
        "contractVersion",
        "payloadVersion",
        "correlationId",
        ...(custom ? [] : ["eventType"]),
      ],
    });
  }
  choice.onchange = () =>
    void load(choice.value).catch((e) => toast(String(e)));
  await load(choice.value);
  c.append(field("Choose a scenario", choice));
  const catalogue = fold("Browse other source events", c),
    search = input(),
    browse = el("select");
  search.placeholder = "Find an event by name";
  function filter() {
    browse.replaceChildren();
    for (const item of catalog.filter((i) =>
      i.eventType.toLowerCase().includes(search.value.toLowerCase()),
    )) {
      const o = el(
        "option",
        `${words(item.eventType)}${item.workflowSupported ? "" : " · May need routing review"}`,
      );
      o.value = item.eventType;
      browse.append(o);
    }
  }
  search.oninput = filter;
  filter();
  catalogue.append(
    field("Search event catalogue", search),
    field("Event", browse),
    button("Use this event", async () => {
      await load(browse.value);
      toast("Selected event loaded into the form below.");
    }),
    el(
      "p",
      "One sample per declared event. Events without a configured workflow enter the review queue; a sample is not a working integration.",
      "muted",
    ),
  );
  c.append(fields, feedback);
  if (role !== "viewer")
    c.append(
      button(
        "Start request",
        async () => {
          const original = read();
          const result = await api<Row>("/events", original);
          feedback.replaceChildren(
            notice(
              "Request received. Processing continues in the background. Open Requests or refresh the received-event list below.",
            ),
          );
          event = {
            ...original,
            eventId: crypto.randomUUID(),
            occurredAt: new Date().toISOString(),
          };
          fields.replaceChildren(el("h3", words(event.eventType)));
          read = formFields(event, fields, {
            hidden: [
              "eventId",
              "occurredAt",
              "contractVersion",
              "payloadVersion",
              "correlationId",
              ...(custom ? [] : ["eventType"]),
            ],
          });
          if (role === "admin") details("Receipt reference", result, feedback);
        },
        true,
      ),
    );
  c.append(button("Open requests", () => show("Cases")));
  const inbox = card("Recently received events");
  async function refresh() {
    inbox.replaceChildren(el("h2", "Recently received events"));
    const data = await api<{ items: Row[] }>("/events");
    table(data.items, ["event_type", "status", "disposition"], inbox);
    inbox.append(button("Refresh received events", refresh));
  }
  await refresh();
}
function jsonForm(
  parent: HTMLElement,
  title: string,
  path: string,
  seed: unknown,
  choices: Record<string, string[]> = {},
) {
  if (path === "/configuration") {
    seed = structuredClone(seed);
    const proposal = seed as { policy: Policy };
    proposal.policy.version = `workspace-${Date.now()}`;
    choices = {
      ...choices,
      role: ["respondent", "verifier", "coordinator"],
      group: proposal.policy.groups,
    };
  }
  const d = fold(title, parent),
    read = formFields(seed as Row, d, {
      hidden: [
        "requestId",
        "expectedRevision",
        ...(path === "/configuration" ? [] : ["action"]),
      ],
      choices:
        path === "/configuration"
          ? { ...choices, action: ["preview", "publish"] }
          : choices,
    });
  d.append(
    button(
      "Save changes",
      async () => {
        const result = await api(path, read());
        const message = el("div");
        d.append(message);
        message.append(
          notice("Changes saved. Refresh before making another change."),
        );
        if (role === "admin")
          details("Advanced result details", result, message);
        toast("Changes saved.");
      },
      true,
    ),
  );
}
async function channels() {
  const configuration = await api<{ policy: Policy }>("/configuration");
  const c = card("People & communication channels");
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
          details(
            `${words(item.channel ?? item.actor_id ?? section)} · ${words(item.status ?? "")} · ${date(item.created_at)}`,
            item,
            target,
          );
      }),
    );
  c.append(row, target);
  if (role === "admin")
    jsonForm(
      c,
      "Add or update a consented binding",
      "/channels/bindings",
      {
        actorId: "",
        channel: "email",
        address: "",
        consentRef: "",
        enabled: false,
        priority: 10,
      },
      {
        actorId: configuration.policy.actors
          .filter((a) => a.enabled)
          .map((a) => a.id),
      },
    );
  c.append(button("Open a request to send a message", () => show("Cases")));
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
  const intro = card("Workspace settings");
  intro.append(
    el(
      "p",
      "Manage recipients, approved reference material and workflow rules. Only workspace administrators can change these settings.",
    ),
  );
  intro.append(
    button("People & channels", () => show("Channels")),
    button("Reference library", () => show("Knowledge")),
  );
  if (role === "admin")
    intro.append(button("Advanced operations", () => show("Operations")));
  const c = card("Workflow rules");
  const configSummary = configuration.configuration as { workflows?: Row[] };
  for (const rule of configSummary.workflows ?? [])
    c.append(el("p", `${words(rule.eventType)} → ${words(rule.workflow)}`));
  const advanced = fold("Advanced workflow configuration", c);
  details("Current workflow settings", configuration, advanced);
  details("AI assistance settings", ai, advanced);
  if (role === "admin") {
    c.append(
      el(
        "p",
        "Changes to workflow rules are advanced administrator tasks. Preview before publishing. Existing requests retain their rules until explicitly updated.",
        "muted",
      ),
    );
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
