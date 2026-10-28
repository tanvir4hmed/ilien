import { scenarioFields, userGuide } from "./operator-guide.js";
import { guestLogin, type GuestConfig } from "./guest-login.js";
import { renderRecovery } from "./recovery.js";
import { companySettings } from "./company-settings.js";
import type {ProductConfiguration} from "../../../packages/product/src/configuration.js";
import { WorkspaceSession, SessionError, SESSION_KEY } from "./session.js";
import { authoredReplyText } from "../../../packages/channels/src/text.js";
import { statusTone,communicationPending } from "./network.js";
import {
  renderJourney,
  recordedRequirements,
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
  guestClientId?: string;
  redirectUri: string;
  redirectUris?: string[];
  guest?: GuestConfig | null;
};
type Row = Record<string, unknown>;
const root = document.querySelector<HTMLDivElement>("#app")!;
let config: Config,
  session: WorkspaceSession,
  role = "viewer",
  page = "Overview";
let content: HTMLElement;
let stopLive: (() => void) | undefined;
let preferredJourneyView = "Workflow map";
let preferredCaseTab = "Flow";
let currentCaseId="";
const pageLabels: Record<string, string> = {
  Overview: "Home",
  Cases: "Cases",
  Tasks: "Tasks",
  Simulator: "Cases",
  Activity: "Activity",
  Settings: "Settings",
  Channels: "People & channels",
  Inbox: "Unassigned messages",
  Knowledge: "Reference library",
  Operations: "Operations",
  Help: "User guide",
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
function panelTabs(parent:HTMLElement,names:string[],selected=names[0]!,change?:(name:string)=>void) {
  const nav=el("div","","workspace-tabs"),panels=new Map<string,HTMLElement>(),buttons=new Map<string,HTMLButtonElement>(),id=`tabs-${crypto.randomUUID()}`;
  nav.setAttribute("role","tablist");parent.append(nav);
  const activate=(name:string,notify=true)=>{for(const [key,panel] of panels){panel.hidden=key!==name;const b=buttons.get(key)!;b.setAttribute("aria-selected",String(key===name));b.tabIndex=key===name?0:-1;b.classList.toggle("active",key===name);}if(notify)change?.(name);};
  for(const [index,name] of names.entries()){const b=button(name,()=>activate(name));b.id=`${id}-tab-${index}`;b.setAttribute("role","tab");const panel=el("section","","workspace-panel");panel.id=`${id}-panel-${index}`;panel.setAttribute("role","tabpanel");panel.setAttribute("aria-labelledby",b.id);b.setAttribute("aria-controls",panel.id);b.onkeydown=event=>{const offset=event.key==="ArrowRight"?1:event.key==="ArrowLeft"?-1:0;const next=event.key==="Home"?0:event.key==="End"?names.length-1:offset?(index+offset+names.length)%names.length:-1;if(next>=0){event.preventDefault();activate(names[next]!);buttons.get(names[next]!)?.focus();}};panels.set(name,panel);buttons.set(name,b);nav.append(b);parent.append(panel);}
  activate(panels.has(selected)?selected:names[0]!,false);return {panels,activate};
}

function workspaceTabs(active:string) {
  const nav=el("div","","workspace-tabs");nav.setAttribute("role","tablist");
  for(const [name,title] of [["Cases","Case list"],["Simulator","Start case"]]) {const b=button(title!,()=>show(name!));b.setAttribute("role","tab");b.setAttribute("aria-selected",String(name===active));b.classList.toggle("active",name===active);nav.append(b);}
  content.append(nav);
}
function tuningTabs(active:string) {
  const nav=el("div","","workspace-tabs");nav.setAttribute("role","tablist");
  for(const [name,title] of [["Channels","People & channels"],["Settings","Organization & rules"],["Knowledge","Knowledge"]]){const b=button(title!,()=>show(name!));b.setAttribute("role","tab");b.setAttribute("aria-selected",String(name===active));b.classList.toggle("active",name===active);nav.append(b);}
  content.append(nav);
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
  if(className.split(" ").includes("badge"))n.dataset.tone=statusTone(text.toLowerCase());
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
const pendingReads=new Map<string,Promise<unknown>>();
async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  if(body!==undefined)return apiRequest<T>(path,body);
  const existing=pendingReads.get(path);if(existing)return existing as Promise<T>;
  const request=apiRequest<T>(path);pendingReads.set(path,request);
  try{return await request;}finally{if(pendingReads.get(path)===request)pendingReads.delete(path);}
}
async function apiRequest<T = unknown>(path: string, body?: unknown): Promise<T> {
  let access:string;
  try {access=await session.accessToken();}catch(error){if(error instanceof SessionError && error.ended){stopLive?.();loginScreen(error.message);}throw error;}
  const request = () => fetch(`${config.apiUrl}/console/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
  });
  let response = await request();
  if(body===undefined && response.status===401) {access=await session.accessToken(true);response=await request();}
  // Aurora can resume after inactivity. Retry reads only; never replay a mutation.
  for(let attempt=0;body===undefined && response.status===503 && attempt<3;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));
    response=await request();
  }
  const data = await response.json();
  if (!response.ok) {
    const messages: Record<string, string> = {
      temporarily_unavailable: "The workspace is waking up. Please try again shortly.",
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
async function signOut() {
  stopLive?.();
  connectingScreen("Signing out…");
  await session.logout();
  sessionStorage.removeItem("ilien-pkce");
  const url = new URL("/logout", config.authDomain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.redirectUri,
  }).toString();
  location.assign(url);
}
function connectingScreen(message="Signed in. Opening the communication workspace…") {
  root.replaceChildren();
  const c=el("main","","card login connection-state");
  c.append(el("div","ILIEN","brand"),el("h1","Connecting workspace"),el("p",message,"muted"));
  c.setAttribute("role","status");root.append(c);
}
async function openWorkspace() {
  connectingScreen();
  try {
    const me=await api<{role:string}>("/me");role=me.role;
    await show("Cases");
  }catch(error){
    if(error instanceof SessionError && error.ended)return;
    root.replaceChildren();const c=el("main","","card login");
    c.append(el("h1","Workspace connection paused"),notice(error instanceof Error?error.message:"Unable to connect",true),button("Retry connection",openWorkspace,true),button("Sign out",signOut));root.append(c);
  }
}
function loginScreen(message?: string) {
  root.replaceChildren();
  const c = el("main", "", "card login");
  c.append(
    el("div", "ILIEN", "brand"),
    el("h1", "Every conversation. One context."),
    el(
      "p",
      "Coordinate requests, collect evidence and bring traceable outcomes back to their source.",
      "muted",
    ),
  );
  if (message) c.append(notice(message, true));
  if (config?.guest)
    guestLogin(
      c,
      config.guest,
      config.guestClientId ?? config.clientId,
      async (tokens) => {
        session.accept(config.guestClientId ?? config.clientId,tokens);
        await openWorkspace();
      },
    );
  c.append(
    button(
      config?.guest ? "Sign in with your own account" : "Sign in to workspace",
      signIn,
      !config?.guest,
    ),
    el(
      "p",
      "Guest access is available for the workspace walkthrough. Personal accounts require an invitation.",
      "muted",
    ),
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
    el("div", "Communication service", "muted"),
  );
  for (const name of [
    "Cases",
    ...(role === "admin" ? ["Settings","Operations"] : []),
    "Help",
  ]) {
    const b = button(label(name), () => show(name));
    if (page === name || (name==="Cases" && page==="Simulator") || (name==="Settings" && ["Channels","Knowledge"].includes(page)) || (name==="Operations" && page==="Inbox")) b.classList.add("active");
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
  if(["Overview","Tasks","Activity"].includes(name))name="Cases";
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
      Help: async () => userGuide(content, (name) => void show(name)),
      Simulator: simulator,
      Channels: channels,
      Inbox: inbox,
      Knowledge: knowledge,
      Settings: settings,
      Operations: operations,
    };
    content.replaceChildren();
    if(["Cases","Simulator"].includes(name))workspaceTabs(name);
    if(role==="admin" && ["Settings","Channels","Knowledge"].includes(name))tuningTabs(name);
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
      button("Open map & request", () => casePage(String(r.id))),
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
  const help = card("New to ILIEN?");
  help.append(
    el(
      "p",
      "Start a scenario, open its live map, and follow the conversation. The guide explains practice responses, real channels and every status.",
    ),
    button("Read the user guide", () => show("Help")),
  );
  const welcome = card("Keep every conversation moving");
  welcome.append(
    el(
      "p",
      "Start a request, see who needs to respond, and follow the evidence through to an outcome.",
    ),
    button("Start a scenario", () => show("Simulator"), true),
    button("View tasks", () => show("Tasks")),
    button("Incoming messages", () => show("Inbox")),
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
  const data = await api<{items:Row[]}>("/cases");
  const c = card("Requests"),
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
    list = el("div","","case-list"),pager=el("div","","case-pager");
  search.placeholder = "Search by subject or request";
  let pageIndex=0,openId="";
  function render() {
    list.replaceChildren();
    pager.replaceChildren();
    const matches=data.items.filter(
        (r) =>
          (status.value === "all" || r.status === status.value) &&
          JSON.stringify(r).toLowerCase().includes(search.value.toLowerCase()),
      ),pages=Math.max(1,Math.ceil(matches.length/10));
    pageIndex=Math.min(pageIndex,pages-1);
    const visible=matches.slice(pageIndex*10,pageIndex*10+10);
    if(!visible.length){list.append(el("p","No requests match these filters.","empty"));return;}
    for(const r of visible){
      const subject=r.subject?decode(r.subject as Row|string):{},item=el("details","","request-item compact-request");
      item.open=openId===String(r.id);
      const summary=el("summary","","request-summary"),main=el("span","","request-title");
      main.append(el("strong",String(subject.id??words(r.workflow))),el("small",`Updated ${date(r.updated_at)}${r.deadline?` · Due ${date(r.deadline)}`:""}`));
      summary.append(main,el("span",words(r.status),"badge"));item.append(summary);
      const detail=el("div","","request-detail");detail.append(el("p",String(r.goal??words(r.workflow))),button("Open request",()=>casePage(String(r.id))));item.append(detail);
      item.ontoggle=()=>{if(!item.open)return;openId=String(r.id);for(const other of list.querySelectorAll<HTMLDetailsElement>("details"))if(other!==item)other.open=false;};list.append(item);
    }
    if(pages>1){const previous=button("Previous",()=>{pageIndex--;render()}),next=button("Next",()=>{pageIndex++;render()});previous.disabled=pageIndex===0;next.disabled=pageIndex===pages-1;pager.append(previous,el("span",`Page ${pageIndex+1} of ${pages} · ${matches.length} requests`,`muted`),next);}
  }
  search.oninput = () => {pageIndex=0;render();};
  status.onchange = () => {pageIndex=0;render();};
  const filters=el("div","","case-filters");filters.append(field("Search",search),field("Status",status));
  c.append(
    filters,
    el("p", "Latest 50 requests · 10 shown per page", "muted"),
    list,
    pager,
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
      button("Open map & request", () => casePage(String(r.case_id))),
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
  if(currentCaseId!==id){preferredCaseTab="Flow";currentCaseId=id;}
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
  heading.classList.add("case-heading");
  heading.append(el("span",words(state.status),"badge"));
  const brief=fold(`Case brief · Due ${date(state.deadline)} · ${state.origin === "simulated" ? "Simulated source" : "Recorded source"}`,heading);
  brief.append(el("p",state.goal));
  const back=button("Back to cases",()=>show("Cases"));
  const sections=panelTabs(content,["Flow","Messages","Outcome","History"],preferredCaseTab,name=>{
    preferredCaseTab=name;
    if(name==="Flow")requestAnimationFrame(()=>sections.panels.get("Flow")!.querySelector<HTMLButtonElement>("[data-fit-map]")?.click());
  });
  const flowPanel=sections.panels.get("Flow")!,messagesPanel=sections.panels.get("Messages")!,outcomePanel=sections.panels.get("Outcome")!,historyPanel=sections.panels.get("History")!;
  const evidenceHost = el("div");
  async function evidence(evidenceId: string) {
    const data = await api<Row>(`/cases/${id}/evidence/${evidenceId}`);
    sections.activate("History");
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
  historyPanel.append(
    button("Read original request", () => evidence(state.sourceEvidenceId)),
  );
  if (state.status === "blocked")
    heading.append(
      notice(
        `${Date.parse(state.deadline) <= Date.now() ? "The response deadline has passed. " : ""}This request needs attention. ${journey.deliveries.length === 0 ? "No real channel messages have been sent. " : ""}Read the tasks below; a blocked outcome is not a completed request.`,
      ),
    );
  const questions=(state.sourceQuestions ?? []).filter(q=>!q.answer);
  if(questions.length) {
    const pending=card("Waiting for source clarification",flowPanel);
    pending.append(el("p","ILIEN has returned these questions to the requesting source. Source responses resume the same case automatically.","muted"));
    for(const q of questions)pending.append(el("p",q.question));
  }
  const deliveryIssues = journey.deliveries.filter((d) =>
    ["blocked", "uncertain"].includes(String(d.status)),
  );
  if (deliveryIssues.length) {
    const waitingIssues = deliveryIssues.filter((d) =>
      state.status === "active" && state.obligations.some((o) =>
        o.id === d.obligation_id && o.status === "waiting"),
    );
    const attention = card(waitingIssues.length ? "Messages need attention" : "Earlier delivery problems",waitingIssues.length?flowPanel:historyPanel);
    const seenIssues = new Set<string>();
    for (const d of deliveryIssues) {
      const provider = d.provider_error
        ? decode(d.provider_error as Row | string)
        : null;
      const key = `${d.obligation_id}/${d.channel}/${d.status}/${JSON.stringify(provider ?? d.reason)}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);
      const waiting = waitingIssues.includes(d);
      attention.append(
        notice(
          `${words(d.channel)} message ${d.status === "uncertain" ? "has an unconfirmed provider result; check it before retrying" : "could not be delivered"}. ${provider?.message ? `${String(provider.message)}${provider.code ? ` (${String(provider.code)})` : ""}` : words(d.reason)}. ${waiting ? "The related task is waiting for a response." : "This is delivery history; it does not establish how the task was answered. Read the recorded evidence below."}`,
        ),
      );
    }
    attention.append(button("People & channels", () => show("Channels")));
  }
  const map = card("Live communication map",flowPanel),
    controls = el("div", "", "row"),
    mapViews=el("div","","workspace-tabs map-views"),
    mapHost = el("div"),
    live = input("", "checkbox"),
    status = el("span", "Updates are off", "muted");
  let disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    refreshing = false;
  let current = journey;
  const messagesHost=el("div"),historyHost=el("div");messagesPanel.append(messagesHost);historyPanel.append(historyHost);
  const draw = () => {
    const message=(messageId:string)=>api(`/cases/${id}/journey?messageId=${encodeURIComponent(messageId)}`);
    renderJourney(mapHost,current,evidence,{mode:preferredJourneyView as "Workflow map"|"Communication network",compact:true,message});
    renderJourney(messagesHost,current,evidence,{mode:"Communication flow",compact:true,message});
    renderJourney(historyHost,current,evidence,{mode:"Activity",compact:true,message});
  };
  historyPanel.append(button("Load older history",async()=>{
    if(current.nextPage===null||current.nextPage===undefined){toast("All available history is loaded.");return;}
    live.checked=false;if(timer)clearTimeout(timer);
    const older=await api<Journey>(`/cases/${id}/journey?page=${current.nextPage}&asOf=${encodeURIComponent(current.asOf??current.observedAt)}`);
    for(const key of ["contacts","deliveries","receipts","deliveryEvents","journal","aiRuns","results"] as const)current[key]=[...new Map([...current[key],...older[key]].map(r=>[String(r.id),r])).values()];
    current.nextPage=older.nextPage;current.truncated=older.truncated;draw();status.textContent="History expanded; live refresh paused.";
  }));
  map.classList.add("case-map");
  mapHost.dataset.view=preferredJourneyView;
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
      // Provider receipts and source publishing change without a case revision.
      // Keep the outcome cards and observer map consistent with the same snapshot.
      if(changedHistory && state.autonomous) { preferredJourneyView=mapHost.dataset.view ?? "Workflow map"; await casePage(id); return; }
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
  live.checked=communicationPending(journey);status.textContent=live.checked?"Live · checks every 10 seconds":"Updates are off";schedule();
  stopLive = () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  };
  for(const [view,title] of [["Workflow map","Dependencies"],["Communication network","Communication network"]]) {
    const b=button(title!,()=>{preferredJourneyView=view!;for(const child of mapViews.children){child.classList.toggle("active",child===b);}draw();});
    b.classList.toggle("active",view===preferredJourneyView);mapViews.append(b);
  }
  controls.append(
    back,
    field("Live", live),
    status,
    button("Refresh", refresh),
  );
  controls.classList.add("case-controls");heading.append(controls);map.append(mapViews,mapHost);
  draw();
  historyPanel.append(evidenceHost);
  const requiredWork = state.obligations.filter(
    (o) => o.required && !["verified","accepted"].includes(o.status),
  );
  const next = card("Responsibilities",outcomePanel);
  next.append(
    el(
      "p",
      requiredWork.length
        ? state.autonomous ? `${requiredWork.length} required outcomes remain. ILIEN manages the next questions and follow-ups automatically.` : `${requiredWork.length} required answers still need verification. ${state.status === "paused" ? "Processing is paused." : ""}`
        : state.status === "completed"
          ? "The request has a completed outcome. Check the source acknowledgement below."
          : "Required outcomes are accepted. Source reporting continues automatically.",
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
          `${o.dependencies.every((d) => ["verified","accepted"].includes(state.obligations.find((n) => n.id === d)?.status ?? "")) ? "Prerequisites satisfied" : "Waiting for"}: ${o.dependencies.map((d) => state.obligations.find((n) => n.id === d)?.question ?? d).join("; ")}`,
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
  if (role !== "viewer" && !state.autonomous) {
    caseActions(state, policy, id,fold("Practice response",historyPanel));
  }
  if(role!=="viewer" && state.autonomous && ["blocked","paused"].includes(state.status)){
    const recoveryHost=fold("Exception recovery",flowPanel);
    recoveryHost.append(el("p","Automatic coordination normally needs no app action. Use these controls only to resolve this case’s exception.","muted"));
    renderRecovery(recoveryHost,state,policy,async(operation,actorId)=>{
    await api(`/cases/${id}/commands`,{commandId:crypto.randomUUID(),expectedRevision:state.revision,actorId,operation});
    await casePage(id);
    });
  }
  if (role !== "viewer" && state.status === "active" && !state.autonomous) {
    const send = card("Send through a connected channel",fold("Advanced delivery controls",historyPanel));
    send.append(
      el(
        "p",
        "This sends a real message to a consented recipient. A simulated reply is never a channel receipt.",
        "muted",
      ),
    );
    const bindings = await api<{ items: Row[] }>("/channels/bindings");
    const offered = new Set<string>();
    const openContacts = journey.contacts.filter((r) => {
      const c = decode(r.contact as Row | string);
      const o = state.obligations.find((o) => o.id === c.obligationId);
      const key = `${String(c.obligationId)}/${String(c.actorId)}/${String(c.kind)}`;
      const eligible = o && (c.kind === "verify_request"
        ? o.status === "answered" && o.reply?.revision === c.replyRevision
        : o.status === "waiting" && o.assignee === c.actorId);
      if (!eligible || offered.has(key)) return false;
      offered.add(key);
      return true;
    });
    const contact = options(
        openContacts.map((r) => {
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
  const outcomes = card("Outcome and source response",outcomePanel);
  outcomePanel.prepend(outcomes);
  const earlierResults=journey.results.some(r=>!r.current)?fold("Earlier source results",historyPanel):null;
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
    const result = decode(r.result as Row | string);
    if(r.current && Array.isArray(result.data)) {
      const information=(result.data as Row[]).flatMap(record=>Array.isArray(record.facts)?(record.facts as Row[]).map(fact=>({information:words(fact.key),value:`${String(fact.value)}${fact.unit?` ${String(fact.unit)}`:""}`,department:words(record.department)})):[]);
      if(information.length)table(information,["information","value","department"],item);
    }
    summary(
      {
        outcome: words(result.outcome),
        summary: result.summary,
        created: date(result.generatedAt),
        requirements: recordedRequirements(result),
      },
      item,
    );
    if (role === "admin") details("Advanced result references", result, item);
    if (r.current && !r.acknowledgement && role !== "viewer" && !state.autonomous) {
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
    if(r.current)outcomes.append(item);else earlierResults?.append(item);
  }
  const ai = card("AI decisions",historyPanel);
  ai.append(
    el(
      "p",
      state.autonomous ? "ILIEN reacts to replies and case changes automatically. This page observes its decisions; normal coordination needs no internal operator approval." : "Ask the assistant to review the evidence and suggest a next step. Suggestions require review; requesting a review uses model tokens.",
      "muted",
    ),
  );
  if (role !== "viewer" && !state.autonomous)
    ai.append(
      button("Ask AI to review this request", async () => {
        await api(`/cases/${id}/agent`, { requestId: crypto.randomUUID() });
        toast("Review requested. Check suggestions when ready.");
      }),
    );
  ai.append(
    button(state.autonomous ? "View AI decisions" : "View suggestions", async () => {
      const runs = await api<{ items: Row[] }>(`/cases/${id}/agent`);
      table(runs.items, ["state", "created_at"], ai, (r) =>
        runPage(String(r.id)),
      );
    }),
  );
}
function caseActions(state: CaseState, policy: Policy, id: string,parent:HTMLElement=content) {
  const c = card("Practice a response",parent);
  c.append(
    notice(
      "Act as a synthetic participant to explore this case. Your answer is labelled as role-play. Any new questions or verification requests may use connected real channels.",
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
  const context = run.context ? decode(run.context as Row | string) : null;
  const original = context?.receipt as Row | undefined;
  if (original)
    c.append(
      el("h3", "Original participant message"),
      el("blockquote", String(original.text), "message-body"),
    );
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
  if (role === "admin") c.append(el("p","Technical trace, source evidence, and audit records are retained automatically. They are intentionally kept out of this decision view.","muted"));
  if (
    role !== "viewer" &&
    run.proposal_hash &&
    !data.review &&
    ["proposed", "waiting", "needs_review"].includes(String(run.state))
  ) {
    const reason = input();
    c.append(field("Review reason", reason));
    const actionable =
      proposal &&
      typeof proposal === "object" &&
      (proposal as Row).disposition === "propose" &&
      (proposal as Row).operation;
    if (!actionable)
      c.append(
        el(
          "p",
          "No action was proposed. Read the original message in Incoming messages if a human interpretation is needed.",
        ),
      );
    for (const disposition of actionable ? ["approve", "reject"] : ["reject"])
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
async function reviewIncoming(r: Row) {
  stopLive?.();
  stopLive = undefined;
  page = "Incoming reply";
  shell();
  const [state, config] = await Promise.all([
    api<CaseState>(`/cases/${r.caseId}`),
    api<{ policy: Policy }>("/configuration"),
  ]);
  const request = r.request as {
    contact: { obligationId: string; kind: string; replyRevision?: number };
  };
  const task = state.obligations.find(
    (o) => o.id === request.contact.obligationId,
  );
  if (!task) throw new Error("The related task is no longer available.");
  const c = card("Review the original reply");
  c.append(
    el(
      "p",
      `${words(r.actorId)} · ${String(state.subject.id)} · ${task.question}`,
    ),
    el("blockquote", String(r.text), "message-body"),
    el(
      "p",
      "Keep the sender's meaning, units, uncertainty and evidence times. Missing information needs clarification. Saving records an interpretation of this original message; independent verification is still required.",
    ),
  );
  const choice = options(
      request.contact.kind === "verify_request"
        ? [{ value: "verify", label: "Record independent verification" }]
        : [
            ...(task.kind !== "decision"
              ? [{ value: "reply", label: "Record reported information" }]
              : []),
            { value: "add_child", label: "Request prerequisite information" },
            ...(task.proposal
              ? [{ value: "decide", label: "Record an explicit decision" }]
              : []),
          ],
    ),
    area = el("div"),
    reason = input();
  choice.value =
    request.contact.kind === "verify_request"
      ? "verify"
      : task.kind === "decision"
        ? "decide"
        : "reply";
  let read = () => ({}) as Row;
  function render() {
    area.replaceChildren();
    let seed: Row;
    if (choice.value === "verify")
      seed = {
        type: "verify",
        obligationId: task!.id,
        replyRevision:
          request.contact.replyRevision ?? task!.reply?.revision ?? 0,
        accept: false,
        reason: "",
      };
    else if (choice.value === "add_child")
      seed = {
        type: "add_child",
        parentId: task!.id,
        obligationId: `followup_${crypto.randomUUID().slice(0, 8)}`,
        group: task!.group,
        question: "",
        kind: "evidence",
      };
    else if (choice.value === "decide")
      seed = {
        type: "decide",
        obligationId: task!.id,
        expectedObligationRevision: task!.revision,
        proposalHash: task!.proposal?.sha256 ?? "",
        choice: "reject",
        reason: "",
        subjectRevision: state.subject.revision,
        observedAt: "",
        validUntil: "",
      };
    else
      seed = {
        type: "reply",
        obligationId: task!.id,
        expectedObligationRevision: task!.revision,
        statement: String(r.text).replace(/^\s*ILIEN [a-f0-9]{32}\s*/, ""),
        subjectRevision: state.subject.revision,
        observedAt: "",
        validUntil: "",
      };
    read = formFields(seed, area, {
      hidden: [
        "type",
        "obligationId",
        "parentId",
        "expectedObligationRevision",
        "replyRevision",
        "subjectRevision",
        "proposalHash",
      ],
      choices: {
        group: config.policy.groups,
        kind: ["fact", "evidence", "decision", "acknowledgement", "commitment"],
        choice: ["approve", "reject"],
      },
    });
  }
  choice.onchange = render;
  render();
  c.append(
    field("What does this reply do?", choice),
    area,
    field(
      "Why is this interpretation supported by the original message?",
      reason,
    ),
    button(
      "Record reviewed reply",
      async () => {
        await api("/channels/review", {
          receiptId: r.id,
          operation: read(),
          reason: required(reason, "a review reason"),
        });
        toast("Reply recorded with its original external evidence.");
        await casePage(String(r.caseId));
      },
      true,
    ),
    button("Back to incoming messages", () => show("Inbox")),
  );
}
function formFields(
  seed: Row,
  parent: HTMLElement,
  settings: { hidden?: string[]; choices?: Record<string, string[]>; blank?: boolean } = {},
) {
  const readers: Record<string, () => unknown> = {};
  const labels: Record<string, string> = {
    subject: "What this request concerns",
    payload: "Request details",
    id: "Reference",
    type: "Item type",
    revision: "Version",
    siteId: "Factory reference",
    materialLotId: "Material batch",
    requiredQuantity: "Amount needed",
    value: "Amount",
    unit: "Unit",
    neededBy: "Needed by",
    requestedInformation: "Information to collect",
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
    autoReceipts: "Process incoming replies with AI",
    executionMode: "AI execution mode",
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
    const isDate =
      typeof value === "string" &&
      (/^\d{4}-\d\d-\d\dT/.test(value) ||
        ["observedAt", "validUntil"].includes(key));
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
      if (isDate && value)
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
    if(settings.blank && typeof value!=="boolean") {
      if(n instanceof HTMLSelectElement) {
        const prompt=el("option","Choose an option");prompt.value="";n.prepend(prompt);
        const readChoice=readers[key]!;
        readers[key]=()=>{if(!n.value)throw new Error(`Please choose ${labels[key] ?? label(key)}.`);return readChoice();};
      } else if(n.type!=="datetime-local") n.placeholder=Array.isArray(value)?value.join("\n"):`For example: ${String(value ?? "")}`;
      n.value="";
    }
    parent.append(field(labels[key] ?? label(key), n));
  }
  return () =>
    Object.fromEntries(
      Object.entries(readers).map(([key, read]) => [key, read()]),
    );
}
async function simulator() {
  const c = card("1. Choose and describe a request");
  c.append(
    el(
      "p",
      "Fill in the business details below. After you start, ILIEN prepares the tasks and opens the request map.",
    ),
    button("Read the step-by-step guide", () => show("Help")),
  );
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
    {value:"dispatch-exception",label:"Partial dispatch · email, WhatsApp and return to email"},
    {value:"production-coordination",label:"Autonomous coordination · quantity, schedule, approval and production readiness"},
    {value:"generic-communication",label:"Custom communication · information, approval or completion"},
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
  const customButton = button("Create a custom source event", () =>
    load("custom"),
  );
  const fields = el("div"),
    feedback = el("div");
  let custom = false;
  let loadSequence = 0, loaded = false;
  let event: Row = {},
    read = () => ({}) as Row;
  async function load(value: string) {
    const sequence=++loadSequence;
    loaded=false;
    fields.replaceChildren(el("p","Loading request fields…","muted"));
    feedback.replaceChildren();
    const selected = catalog.find((c) => c.eventType === value);
    const url = selected
      ? `/fixtures/${encodeURIComponent(selected.fixture)}`
      : `/examples/${value}.event.json`;
    custom = value === "custom";
    const nextEvent:Row = custom
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
    if(sequence!==loadSequence)return;
    event=nextEvent;
    event.eventId = crypto.randomUUID();
    event.occurredAt = new Date().toISOString();
    const payload = event.payload as Row;
    if (payload?.neededBy)
      payload.neededBy = new Date(Date.now() + 86400000).toISOString();
    fields.replaceChildren(el("h3", words(event.eventType)));
    read =
      scenarioFields(event, fields) ??
      formFields(event, fields, {
        blank:true,
        hidden: [
          "eventId",
          "occurredAt",
          "contractVersion",
          "payloadVersion",
          "correlationId",
          ...(custom ? [] : ["eventType"]),
        ],
      });
    loaded=true;
  }
  choice.onchange = () =>
    void load(choice.value).catch((e) => toast(String(e)));
  await load(choice.value);
  c.append(field("Choose a scenario", choice));
  const catalogue = fold("Browse other source events", c),
    search = input(),
    browse = el("select");
  catalogue.remove();
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
        "Start request & open map",
        async () => {
          if(!loaded)throw new Error("Wait for the selected request fields to finish loading.");
          const original = read();
          const result = await api<Row>("/events", original);
          feedback.replaceChildren(
            notice(
              "Request received. Processing continues in the background. Open the Case list tab to see its status.",
            ),
          );
          event = {
            ...original,
            eventId: crypto.randomUUID(),
            occurredAt: new Date().toISOString(),
          };
          fields.replaceChildren(el("h3", words(event.eventType)));
          read =
            scenarioFields(event, fields) ??
            formFields(event, fields, {
              blank:true,
              hidden: [
                "eventId",
                "occurredAt",
                "contractVersion",
                "payloadVersion",
                "correlationId",
                ...(custom ? [] : ["eventType"]),
              ],
            });
          if (role === "admin")
            details("Advanced receipt reference", result, feedback);
          await openWhenReady(String(result.inboxId));
        },
        true,
      ),
    );
  c.append(
    button("Open requests", () => show("Cases")),
    catalogue,
    customButton,
  );
  async function openWhenReady(inboxId: string) {
    feedback.replaceChildren(notice("2. Request accepted. Preparing its map…"));
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!feedback.isConnected || page !== "Simulator" || document.hidden)
        return;
      const data = await api<{ items: Row[] }>("/events");
      const row = data.items.find((r) => r.id === inboxId);
      if (row?.case_id) {
        await casePage(String(row.case_id));
        return;
      }
      if (
        row?.disposition === "triage" &&
        row?.status === "awaiting_coordination"
      ) {
        feedback.replaceChildren(
          notice(
            "This request needs routing review. It has no configured workflow yet, so no map has been created.",
          ),
          button("Read the user guide", () => show("Help")),
        );
        return;
      }
      if (attempt < 7) await new Promise((r) => setTimeout(r, 2500));
    }
    if (feedback.isConnected) {
      feedback.replaceChildren(
        notice(
          "Your request is saved. Preparing the map is taking longer than usual. Check the Case list tab; do not submit it again.",
        ),
        button("Check and open map", () => openWhenReady(inboxId)),
      );
    }
  }
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
  const [configuration,bindings]=await Promise.all([api<{policy:Policy}>("/configuration"),api<{items:Row[]}>("/channels/bindings")]);
  const tabs=panelTabs(content,["Connected people",...(role==="admin"?["Connect person"]:[])]);
  const list=card("People & channels",tabs.panels.get("Connected people")!);
  list.append(el("p","Each person may have email, WhatsApp, or both. ILIEN selects the registered channel when the request needs it. Consent and past messages remain recorded.","muted"));
  const names=new Map(configuration.policy.actors.map(a=>[a.id,a.name??words(a.id)]));
  for(const b of bindings.items){const row=el("article","","binding-item");row.append(el("strong",names.get(String(b.actor_id))??words(b.actor_id)),el("span",`${words(b.channel)} · ${String(b.address)}`,"muted"),el("span",b.enabled?"Active":"Archived","badge"));if(role==="admin"&&b.enabled)row.append(button("Archive contact",async()=>{await api("/channels/bindings",{action:"archive",bindingId:b.id,reason:"Administrator archived endpoint; case history retained."});await show("Channels");}));list.append(row);}
  if(!bindings.items.length)list.append(el("p","No people are connected to a live channel yet.","empty"));
  list.append(button("Refresh people",()=>show("Channels")));
  if(role==="admin"){
    const create=card("Connect a person",tabs.panels.get("Connect person")!);
    create.append(el("p","Add one endpoint at a time. Choose Email or WhatsApp first; the address field changes to match.","muted"));
    const person=options(configuration.policy.actors.filter(a=>a.enabled).map(a=>({value:a.id,label:`${a.name??words(a.id)} · ${words(a.group)} · ${words(a.role)}`}))),channel=options([{value:"email",label:"Email"},{value:"whatsapp",label:"WhatsApp"}]),address=input(),consent=input(),enabled=input("","checkbox"),priority=input("10","number");
    const addressField=field("Email address",address);const sync=()=>{const whatsapp=channel.value==="whatsapp";addressField.firstChild!.textContent=whatsapp?"WhatsApp number":"Email address";address.placeholder=whatsapp?"+880…":"name@company.com";};channel.onchange=sync;sync();
    create.append(field("Person",person),field("Channel",channel),addressField,field("Consent record",consent),field("Enable this endpoint now",enabled),field("Priority (lower sends first when options are equivalent)",priority),button("Connect channel",async()=>{await api("/channels/bindings",{actorId:person.value,channel:channel.value,address:required(address,"an address or number"),consentRef:required(consent,"a consent record"),enabled:enabled.checked,priority:Number(priority.value)});toast("Channel connected.");await show("Channels");},true));
  }
}

async function inbox() {
  const [data, configuration] = await Promise.all([
    api<{ items: Row[] }>("/channels/inbox"),
    api<{ policy: Policy }>("/configuration"),
  ]);
  const intro = card("Unassigned messages");
  const unassigned=data.items.filter(r=>!r.caseId);
  intro.append(
    el(
      "p",
      "Only messages without a case are shown here. Assigned conversations stay in their case’s Messages tab. Connecting a sender requires an authorised person and recorded consent.",
    ),
    button("Refresh messages", () => show("Inbox")),
    button("Back to operations", () => show("Operations")),
    button("Manage people & channels", () => show("Channels")),
  );
  if (!unassigned.length)
    intro.append(el("p", "No messages need case assignment.", "empty"));
  const explanations: Record<string, string> = {
    identity_or_correlation_required:
      "Connect this sender to a person, then check for a matching request.",
    sender_not_registered:
      "This sender has not been connected to a workspace person.",
    greeting_received:
      "Greeting received. This person is recognised; no task was answered by the greeting.",
    no_open_request_for_participant:
      "This person is recognised, but no current sent request matches this message.",
    multiple_open_requests_choose_one:
      "This person has more than one open request. Choose which request this reply concerns.",
    request_reference_not_found:
      "The message references a request that cannot be found. Review it before linking.",
    sender_not_authorized_for_request:
      "The sender is not authorised to answer the referenced request.",
    unstructured_reply:
      "Reply linked to its original request. AI interpretation is waiting for review.",
    authorized_structured_reply:
      "The authorised reply was recorded against the request.",
    consent_withdrawn:
      "The sender asked to stop receiving messages. This channel is disabled.",
  };
  for (const r of unassigned) {
    const c = card(
      `${words(r.channel)} · ${r.actorId ? words(r.actorId) : "New sender"}`,
    );
    const originalText = String(r.text || "Message contains no supported text");
    const authoredText = authoredReplyText(originalText);
    const earlierReply = r.status === "needs_review" && r.reason === "unstructured_reply" && !r.reviewAvailable;
    c.append(
      el("p", `${String(r.sender)} · ${date(r.receivedAt)}`, "muted"),
      el(
        "blockquote",
        authoredText || originalText,
        "message-body",
      ),
      el("p", earlierReply ? "Retained for history. Its task has changed or is no longer awaiting this answer; it cannot be applied to the current request." : explanations[String(r.reason)] ?? words(r.reason)),
      el("span", earlierReply ? "Earlier reply" : words(r.status), "badge"),
    );
    if (authoredText !== originalText) {
      const original = fold("Read full original message and quoted history", c);
      original.append(el("blockquote", originalText, "message-body"));
    }
    if (r.caseId)
      c.append(button("Open request & map", () => casePage(String(r.caseId))));
    if (r.runId)
      c.append(button("View AI interpretation", () => runPage(String(r.runId))));
    if (r.bindingId && r.bindingEnabled === false)
      c.append(
        notice(
          "This person's channel is disabled or consent was withdrawn. An administrator must record renewed consent before messaging can continue.",
        ),
      );
    if (
      role !== "viewer" &&
      r.status === "needs_review" &&
      r.reason === "unstructured_reply" &&
      r.reviewAvailable &&
      r.request
    )
      c.append(button("Review original reply", () => reviewIncoming(r)));
    if (
      role === "viewer" ||
      r.blockedReason ||
      (r.bindingId && r.bindingEnabled === false) ||
      !["unmatched", "received"].includes(String(r.status))
    )
      continue;
    if (!r.actorId && role === "admin") {
      const form = el("div", "", "form-group"),
        actor = options(
          configuration.policy.actors
            .filter((a) => a.enabled)
            .map((a) => ({
              value: a.id,
              label: `${words(a.id)} · ${words(a.group)} · ${words(a.role)}`,
            })),
        ),
        consent = input(),
        checked = input("", "checkbox");
      consent.placeholder = "Who consented, when, and for what communication?";
      form.append(
        field("Who is this sender?", actor),
        field("Consent record", consent),
        field(
          "I checked this identity and have permission to contact this person",
          checked,
        ),
        button(
          "Connect sender and recognise message",
          async () => {
            if (!checked.checked)
              throw new Error(
                "Confirm this person's identity and consent first.",
              );
            await api("/channels/bindings", {
              actorId: actor.value,
              channel: r.channel,
              address: r.sender,
              consentRef: required(consent, "a consent record"),
              enabled: true,
              priority: 10,
            });
            await api("/channels/resolve", {
              receiptId: r.id,
              reason:
                "Sender identity and consent checked by workspace administrator",
            });
            toast(
              "Sender connected. The original message and evidence are preserved.",
            );
            await show("Inbox");
          },
          true,
        ),
      );
      c.append(form);
    } else if (r.actorId) {
      const candidates = (r.candidates ?? []) as Row[];
      if (candidates.length && r.reason !== "greeting_received") {
        const choose = options([
            { value: "", label: "Choose the request this message answers" },
            ...candidates.map((d) => ({
              value: String(d.id),
              label: `${String((d.subject as Row).id)} · ${String(d.question)}`,
            })),
          ]),
          reason = input();
        c.append(
          field("Related request", choose),
          field("Why does this message belong to that request?", reason),
          button("Link reply to request", async () => {
            if (!choose.value) throw new Error("Choose the related request.");
            await api("/channels/resolve", {
              receiptId: r.id,
              deliveryId: choose.value,
              reason: required(reason, "a matching reason"),
            });
            await show("Inbox");
          }),
        );
      }
      c.append(
        button("Check matching again", async () => {
          await api("/channels/resolve", {
            receiptId: r.id,
            reason: "Operator requested a fresh identity and request match",
          });
          await show("Inbox");
        }),
      );
    }
  }
}
async function knowledge() {
  const tabs=panelTabs(content,["Documents",...(role==="admin"?["Publish","Revoke"]:[])]);
  const c = card("Approved knowledge",tabs.panels.get("Documents")!);
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
    jsonForm(tabs.panels.get("Publish")!, "Publish a version", "/ai/knowledge", {
      action: "publish",
      documentKey: "",
      version: 1,
      group: "",
      title: "",
      body: "",
      effectiveAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 2592000000).toISOString(),
    });
    jsonForm(tabs.panels.get("Revoke")!, "Revoke a document", "/ai/knowledge", {
      action: "revoke",
      id: "",
      reason: "",
    });
  }
}
async function settings() {
  const [configuration, ai, membership] = await Promise.all([
    api<Row>("/configuration"),
    api<Row>("/ai/settings"),
    role==="admin"?api<{items:Row[]}>("/members"):Promise.resolve({items:[]}),
  ]);
  const intro = card("Workspace settings");
  intro.append(
    el(
      "p",
      "Manage recipients, approved reference material and workflow rules. Only workspace administrators can change these settings.",
    ),
  );
  const tabs=panelTabs(content,["Organization & rules","AI behavior","Workspace access"]);
  if(role==="admin")companySettings(tabs.panels.get("Organization & rules")!,configuration as unknown as {revision:number;policy:Policy;configuration:ProductConfiguration},api);
  const c = card("Active workflow rules",tabs.panels.get("Organization & rules")!);
  const configSummary = configuration.configuration as { workflows?: Row[] };
  for (const rule of configSummary.workflows ?? [])
    c.append(el("p", `${words(rule.eventType)} → ${words(rule.workflow)}`));
  const advanced = fold("Technical configuration record", c);
  details("Current workflow settings", configuration, advanced);
  details("AI assistance settings", ai, advanced);
  if (role === "admin") {
    const aiPanel=tabs.panels.get("AI behavior")!,aiCard=card("How ILIEN handles incoming replies",aiPanel);
    aiCard.append(el("p","These settings control whether ILIEN reads replies and whether a validated coordination step is applied automatically. Business approvals still come only from the responsible person through their channel.","muted"));
    const enabled=input("","checkbox"),automatic=input("","checkbox"),mode=options([{value:"autonomous",label:"Autonomous — apply validated coordination steps"},{value:"review",label:"Review first — hold AI suggestions for an operator"}]);enabled.checked=Boolean(ai.enabled);automatic.checked=Boolean(ai.auto_receipts);mode.value=String(ai.execution_mode??"autonomous");
    aiCard.append(field("Use AI to process incoming replies",enabled),field("Process eligible replies automatically",automatic),field("How to apply AI suggestions",mode),button("Save AI behavior",async()=>{await api("/ai/settings",{enabled:enabled.checked,autoReceipts:automatic.checked,executionMode:mode.value,expectedRevision:ai.revision});toast("AI behavior updated.");await show("Settings");},true));
    const m = card("Workspace access",tabs.panels.get("Workspace access")!);
    m.append(el("p","These are application sign-in identities, separate from textile employees and channel contacts. Add only people who should administer or view this workspace.","muted"));
    const members=membership.items.map(member=>({"Account ID":String(member.subject),Role:member.role,Active:member.enabled,Added:member.created_at}));
    table(members,["Account ID","Role","Active","Added"],m);
    const identity=input(),accessRole=options([{value:"viewer",label:"Viewer — read cases"},{value:"admin",label:"Administrator — change company settings"}]),active=input("","checkbox");active.checked=true;
    m.append(field("Account ID from your identity provider",identity),field("Access role",accessRole),field("Enable access",active),button("Save workspace access",async()=>{await api("/members",{subject:required(identity,"an account ID"),role:accessRole.value,enabled:active.checked});toast("Workspace access updated.");await show("Settings");},true));
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
  const sections=panelTabs(content,["Status","History"]);
  const actions=card("Operational activity",sections.panels.get("Status")!);
  actions.append(el("p","Use this area only when automatic coordination needs review: unmatched messages, delivery issues, queue health, or recovery actions.","muted"),button("Unassigned messages",()=>show("Inbox")));
  const c = card("Automatic safeguards",sections.panels.get("Status")!);
  c.append(
    notice(
      "ILIEN coordinates normal work without this page. When a specific case is blocked or uncertain, use that case’s Exception recovery section. Every recovery action is recorded automatically.",
    ),
  );
  c.append(el("p","Processing safeguards and retention rules are active. There is no routine control to operate here.","muted"));
  const queues = card("Queue health",sections.panels.get("Status")!);
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
  table(data.work.map(row=>({"Work area":words(row.lane),Status:words(row.state),Attempts:row.attempts,Started:row.created_at})),["Work area","Status","Attempts","Started"],card("Pending and interrupted work",sections.panels.get("Status")!));
  table(data.caseChecks.map(row=>({Status:words(row.status),Issues:Array.isArray(row.issues)?row.issues.length:"None",Checked:row.checked_at})),["Status","Issues","Checked"],card("Case supervision",sections.panels.get("Status")!));
  table(data.deliveries.map(row=>({Channel:words(row.channel),Status:words(row.status),Reason:row.reason?words(row.reason):"No attention needed",Attempts:row.queue_attempts})),["Channel","Status","Reason","Attempts"],card("Delivery attention",sections.panels.get("Status")!));
  const history=card("Recovery history",sections.panels.get("History")!);
  history.append(el("p","This is a readable record of exceptional operator actions. Technical identifiers remain protected in the audit trail and are not needed to understand the outcome.","muted"));
  table(data.audit.map(row=>({Action:words(row.action),When:row.created_at,Reason:row.reason??"Recorded automatically",Outcome:row.outcome?words(row.outcome):"Recorded"})),["Action","When","Reason","Outcome"],history);
  const retention=card("Evidence retention",sections.panels.get("History")!);
  retention.append(el("p","Original communication evidence is retained under legal hold. Routine users do not delete evidence or alter retention from the app.","muted"));
  table(data.retention.map(row=>({Status:words(row.status),Updated:row.updated_at,"Eligible AI traces":row.eligible_traces})),["Status","Updated","Eligible AI traces"],retention);
  content.append(button("Refresh operations", () => show("Operations")));
}
async function boot() {
  config = await fetch("/config.json", { cache: "no-store", signal: AbortSignal.timeout(10000) }).then((r) => {
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
  session=new WorkspaceSession(localStorage,[config.clientId,...(config.guestClientId?[config.guestClientId]:[])]);
  window.addEventListener("storage",event=>{if(event.key===SESSION_KEY && event.newValue===null){session.clear();stopLive?.();loginScreen("Signed out in another tab.");}});
  const params = new URLSearchParams(location.search),
    code = params.get("code");
  if (params.has("error")) {
    history.replaceState(null, "", "/");
    loginScreen("Sign-in did not complete. Please try again.");
    return;
  }
  if (!code) {
    if(session.available)await openWorkspace();else loginScreen();
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
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Sign-in exchange failed.");
  const result = await response.json();
  session.accept(config.clientId,{accessToken:result.access_token,refreshToken:result.refresh_token,expiresIn:result.expires_in});
  await openWorkspace();
}
void boot().catch((e) =>
  loginScreen(e instanceof Error ? e.message : "Unable to start workspace"),
);
