// The admin dashboard at app.<domain>/admin/, for platform admins only: the
// fleet and the cluster's configuration, the platform's settings, budgets
// and usage, workspaces, Blueprints, users and the audit log. A client of
// /api/admin/ and the workspace API; everything it shows goes in as text.
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · kodo</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --soft: rgba(127,127,127,.08); --bad: #b91c1c; --good: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: baseline; padding: .75rem 1rem; border-bottom: 1px solid var(--line); gap: 1rem; flex-wrap: wrap; }
  header h1 { font-size: 1.15rem; margin: 0; }
  header nav { font-size: .9rem; }
  .layout { display: flex; max-width: 80rem; margin: 0 auto; }
  aside { width: 12rem; padding: 1rem .75rem; flex-shrink: 0; }
  aside a { display: block; padding: .35rem .6rem; border-radius: .35rem; color: inherit; text-decoration: none; }
  aside a[aria-current] { background: var(--soft); font-weight: 600; }
  main { flex: 1; min-width: 0; padding: 1rem 1.25rem 3rem; }
  h2 { font-size: 1.1rem; margin: 0 0 .25rem; }
  h3 { font-size: 1rem; margin: 0 0 .4rem; }
  .lead { color: var(--muted); margin: 0 0 1rem; font-size: .92rem; }
  .muted { color: var(--muted); }
  .hint { font-size: .85rem; }
  .card { border: 1px solid var(--line); border-radius: .6rem; padding: .7rem .9rem; margin: 0 0 .75rem; overflow-x: auto; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-top: .45rem; }
  .label { font-size: .85rem; color: var(--muted); min-width: 7rem; }
  .chip { font: 13px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 1rem; padding: .05rem .5rem; display: inline-block; margin: .1rem .15rem .1rem 0; }
  .mono { font: 13px ui-monospace, monospace; }
  .tag { font-size: .78rem; border-radius: .3rem; padding: 0 .4rem; background: var(--soft); white-space: nowrap; }
  .tag.draft { background: rgba(250, 204, 21, .25); }
  .tag.published { background: rgba(21, 128, 61, .15); }
  .tag.withdrawn, .tag.suspended { background: rgba(185, 28, 28, .15); }
  input, select, button, textarea { font: inherit; padding: .25rem .5rem; }
  input[type=number] { width: 9rem; }
  button { cursor: pointer; }
  button.danger { color: var(--bad); }
  form { display: contents; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .6rem; margin-bottom: 1rem; }
  .stat { border: 1px solid var(--line); border-radius: .5rem; padding: .5rem .7rem; }
  .stat b { display: block; font-size: 1.25rem; font-variant-numeric: tabular-nums; }
  .bar { height: .4rem; background: var(--soft); border-radius: .2rem; min-width: 6rem; margin-top: .2rem; }
  .bar span { display: block; height: 100%; border-radius: .2rem; background: var(--good); }
  .bar span.high { background: var(--warn); } .bar span.over { background: var(--bad); }
  #error { color: var(--bad); margin: 0 0 .75rem; }
  #error:empty { display: none; }
  .ok { color: var(--good); } .bad { color: var(--bad); }
  pre { white-space: pre-wrap; word-break: break-all; margin: 0; font-size: 12px; }
  [hidden] { display: none !important; }
  @media (max-width: 760px) {
    .layout { flex-direction: column; }
    aside { width: auto; display: flex; gap: .25rem; overflow-x: auto; padding: .5rem 1rem; border-bottom: 1px solid var(--line); }
    aside a { white-space: nowrap; }
    main { padding: 1rem; }
  }
</style>
</head>
<body>
<header>
  <h1>kodo <span class="muted">admin</span></h1>
  <nav><span id="who" class="muted"></span> · <a href="/">Cells</a> · <a href="/settings/">Settings</a> · <a href="/chat/">Chat</a> · <a href="/logout">Log out</a></nav>
</header>
<div class="layout">
  <aside id="nav">
    <a href="#fleet">Fleet</a>
    <a href="#settings">Agent and chats</a>
    <a href="#budgets">Models and budgets</a>
    <a href="#workspaces">Workspaces</a>
    <a href="#blueprints">Blueprints</a>
    <a href="#users">Users</a>
    <a href="#audit">Audit log</a>
  </aside>
  <main>
    <p id="error" role="alert"></p>
    <section id="section-fleet" hidden>
      <h2>Fleet</h2>
      <p class="lead">The kernel serving this page, and the fleet as the operator last reported it from the cluster.</p>
      <div id="fleet-view"></div>
    </section>
    <section id="section-settings" hidden>
      <h2>Agent and chats</h2>
      <p class="lead">How the agent works. The agent reads these at the start of every turn, so a change applies to the next one, with no restart.</p>
      <div id="settings-view"></div>
    </section>
    <section id="section-budgets" hidden>
      <h2>Models and budgets</h2>
      <p class="lead">Monthly model token budgets, per user and per workspace, kept by the kernel. The call that crosses a budget is answered and the next is refused. Models, their backends and the gateway's rate limits are cluster configuration, shown as configured.</p>
      <div id="budgets-view"></div>
    </section>
    <section id="section-workspaces" hidden>
      <h2>Workspaces</h2>
      <p class="lead">Only members create cells and chats in a workspace; its admins manage its members, quota and docs.</p>
      <div id="workspaces-view"></div>
    </section>
    <section id="section-blueprints" hidden>
      <h2>Blueprints</h2>
      <p class="lead">Every version, who wrote and published it. A withdrawn version cannot be used by a new cell; cells already on it keep running until their owners move them.</p>
      <div id="blueprints-view"></div>
    </section>
    <section id="section-users" hidden>
      <h2>Users</h2>
      <p class="lead">Everyone who has signed in, and what they spent on models this month. A suspended user is refused everywhere: the API, their chats and every cell, their own included.</p>
      <div id="users-view"></div>
    </section>
    <section id="section-audit" hidden>
      <h2>Audit log</h2>
      <p class="lead">The Gatekeeper's records for this fleet, newest first: calls and their decisions, approvals, Blueprint versions authored and published, and every admin action.</p>
      <div id="audit-view"></div>
    </section>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
let me;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

async function call(method, path, body, raw) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": raw ? "text/markdown" : "application/json" },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || data || res.status);
  return data;
}
const api = (method, path, body, raw) => call(method, "/api" + path, body, raw);
const admin = (method, path, body) => api(method, "/admin" + path, body);
const enc = encodeURIComponent;

function showError(err) { $("error").textContent = err ? String(err.message || err) : ""; }
async function act(fn) {
  try { await fn(); showError(null); } catch (err) { showError(err); }
  await show();
}

const date = (ms) => ms ? new Date(ms).toLocaleString() : "";
const number = (n) => n == null ? "no limit" : Number(n).toLocaleString();
const stat = (label, value) => el("div", { class: "stat" }, el("span", { class: "muted hint" }, label), el("b", {}, value));
const table = (head, rows) => el("table", {}, el("thead", {}, el("tr", {}, head.map((h) => typeof h === "string" ? el("th", {}, h) : h))), el("tbody", {}, rows));
const empty = (text) => el("p", { class: "muted" }, text);

function meter(used, budget) {
  if (budget == null) return el("span", { class: "muted hint" }, "no limit");
  const pct = budget === 0 ? 100 : Math.min(100, Math.round(used / budget * 100));
  return el("div", {}, el("span", { class: "hint" }, pct + "% of " + number(budget)),
    el("div", { class: "bar" }, el("span", { class: pct >= 100 ? "over" : pct >= 80 ? "high" : "", style: "width: " + pct + "%" })));
}

// Fleet

async function showFleet() {
  const o = await admin("GET", "/overview");
  const c = o.cluster;
  const view = [
    el("div", { class: "stats" }, stat("Workspaces", number(o.workspaces)), stat("Blueprints", number(o.blueprints)),
      stat("Versions", number(o.versions)), stat("Users", number(o.users)), stat("Suspended", number(o.suspended))),
    el("div", { class: "card" }, el("h3", {}, "Kernel"),
      el("div", { class: "row" }, el("span", { class: "label" }, "Build"), el("span", { class: "mono" }, o.build))),
  ];
  if (!c) {
    view.push(el("div", { class: "card" }, el("h3", {}, "Cluster"), empty("The operator has not reported the cluster yet. It does so every minute for a Fleet it manages.")));
  } else {
    const f = c.fleet || {};
    const age = Math.round((Date.now() - c.reportedAt) / 1000);
    view.push(el("div", { class: "card" }, el("h3", {}, "Fleet " + (f.name || "")),
      el("div", { class: "row" }, el("span", { class: "label" }, "Reported"), el("span", { class: age > 180 ? "bad" : "" }, date(c.reportedAt) + " (" + age + " s ago)")),
      el("div", { class: "row" }, el("span", { class: "label" }, "Nodes"), el("span", {}, (f.readyReplicas ?? 0) + " ready of " + (f.replicas ?? "?"))),
      el("div", { class: "row" }, el("span", { class: "label" }, "celld"), el("span", { class: "mono" }, f.celld || "")),
      el("div", { class: "row" }, el("span", { class: "label" }, "Kernel image"), el("span", { class: "mono" }, f.kernel || "")),
      (f.conditions || []).length ? table(["Condition", "Status", "Reason", "Message"], f.conditions.map((x) =>
        el("tr", {}, el("td", {}, x.type), el("td", { class: x.status === "True" ? "ok" : "bad" }, x.status), el("td", {}, x.reason || ""), el("td", { class: "hint" }, x.message || "")))) : null));
    const nodes = c.nodes || [];
    view.push(el("div", { class: "card" }, el("h3", {}, "Nodes"), nodes.length ? table(["Pod", "Ready", "Restarts", "Host", "Started"], nodes.map((n) =>
      el("tr", {}, el("td", { class: "mono" }, n.name), el("td", { class: n.ready ? "ok" : "bad" }, n.ready ? "ready" : (n.phase || "not ready")),
        el("td", { class: "num" }, String(n.restarts ?? 0)), el("td", {}, n.node || ""), el("td", { class: "hint" }, n.startedAt ? date(Date.parse(n.startedAt)) : "")))) : empty("No nodes.")));
    view.push(el("p", { class: "muted hint" }, "Activations, hibernations and node metrics come with the exporter of Phase 6."));
  }
  $("fleet-view").replaceChildren(...view);
}

// Agent and chats

async function showSettings() {
  const s = await admin("GET", "/settings");
  const model = el("input", { class: "mono", value: s.agent.model, required: true, "aria-label": "Agent model", pattern: "[a-z0-9][a-z0-9._-]*" });
  const tokens = el("input", { type: "number", min: 256, max: 200000, value: s.agent.maxTokens, required: true, "aria-label": "Output limit" });
  const steps = el("input", { type: "number", min: 1, max: 50, value: s.agent.maxSteps, required: true, "aria-label": "Steps per turn" });
  const grants = el("textarea", { class: "mono", rows: 3, cols: 50, "aria-label": "Grants of new chats", placeholder: "one capability per line; empty for just the agent's model" });
  grants.value = (s.sessionGrants || []).join("\\n");
  const save = () => act(() => admin("PUT", "/settings", {
    agent: { model: model.value.trim(), maxTokens: Number(tokens.value), maxSteps: Number(steps.value) },
    sessionGrants: grants.value.trim() ? grants.value.split(/\\s+/).filter(Boolean) : null,
  }));
  $("settings-view").replaceChildren(el("form", { onsubmit: (e) => { e.preventDefault(); save(); } },
    el("div", { class: "card" }, el("h3", {}, "The agent"),
      el("div", { class: "row" }, el("span", { class: "label" }, "Model"), model, el("span", { class: "muted hint" }, "a model name of the inference gateway; chats get inference:model/<name>:invoke when their owner next writes")),
      el("div", { class: "row" }, el("span", { class: "label" }, "Output limit"), tokens, el("span", { class: "muted hint" }, "max_tokens of each model call; a whole gadget is written in one answer")),
      el("div", { class: "row" }, el("span", { class: "label" }, "Steps per turn"), steps, el("span", { class: "muted hint" }, "model calls in one turn, at most"))),
    el("div", { class: "card" }, el("h3", {}, "New chats"),
      el("div", { class: "row" }, el("span", { class: "label" }, "Granted"), grants),
      el("div", { class: "row" }, el("span", { class: "label" }, ""), el("span", { class: "muted hint" }, "Every run of a chat's code gets exactly its grants; owners change them in their settings."))),
    el("div", { class: "row" }, el("button", {}, "Save"), el("span", { class: "muted hint" }, "Saving is recorded in the audit log."))));
}

// Models and budgets

async function showBudgets() {
  const [u, o] = await Promise.all([admin("GET", "/usage"), admin("GET", "/overview")]);
  const b = u.budgets;
  const limitInput = (value, label) => el("input", { type: "number", min: 0, value: value == null ? "" : value, placeholder: "no limit", "aria-label": label });
  const userIn = limitInput(b.user, "Each user"), wsIn = limitInput(b.workspace, "Each workspace");
  const parse = (input) => input.value === "" ? null : Number(input.value);
  const saveBudgets = (next) => act(() => admin("PUT", "/budgets", next));
  const override = (scope, key, value) => {
    const next = { ...b, users: { ...b.users }, workspaces: { ...b.workspaces } };
    if (value === undefined) delete next[scope][key]; else next[scope][key] = value;
    return saveBudgets(next);
  };
  const overrideCell = (scope, key) => {
    const has = Object.prototype.hasOwnProperty.call(b[scope], key);
    const input = el("input", { type: "number", min: 0, value: has && b[scope][key] != null ? b[scope][key] : "", placeholder: has ? "no limit" : "default", "aria-label": "Budget for " + key });
    return el("td", {}, el("form", { onsubmit: (e) => { e.preventDefault(); override(scope, key, input.value === "" ? null : Number(input.value)); } },
      el("div", { class: "row", style: "margin: 0" }, input, el("button", {}, "Set"), has ? el("button", { type: "button", onclick: () => override(scope, key, undefined) }, "Default") : null)));
  };
  const c = o.cluster || {};
  const routes = c.models || [];
  const limits = c.rateLimits || [];
  $("budgets-view").replaceChildren(
    el("form", { onsubmit: (e) => { e.preventDefault(); saveBudgets({ ...b, user: parse(userIn), workspace: parse(wsIn) }); } },
      el("div", { class: "card" }, el("h3", {}, "Monthly token budgets"),
        el("div", { class: "row" }, el("span", { class: "label" }, "Each user"), userIn, el("span", { class: "muted hint" }, "across every workspace")),
        el("div", { class: "row" }, el("span", { class: "label" }, "Each workspace"), wsIn),
        el("div", { class: "row" }, el("button", {}, "Save defaults"), el("span", { class: "muted hint" }, "Empty is no limit. Overrides below raise or lower one user's or workspace's.")))),
    el("div", { class: "card" }, el("h3", {}, "Users, " + u.month),
      u.users.length ? table(["User", el("th", { class: "num" }, "Calls"), el("th", { class: "num" }, "Tokens"), "Budget", "Override"], u.users.map((r) =>
        el("tr", {}, el("td", {}, r.email || r.user, el("div", { class: "muted hint mono" }, r.user)), el("td", { class: "num" }, number(r.calls)), el("td", { class: "num" }, number(r.tokens)),
          el("td", {}, meter(r.tokens, r.budget)), overrideCell("users", r.user)))) : empty("Nobody has signed in yet.")),
    el("div", { class: "card" }, el("h3", {}, "Workspaces, " + u.month),
      u.workspaces.length ? table(["Workspace", el("th", { class: "num" }, "Calls"), el("th", { class: "num" }, "Tokens"), "Budget", "Override"], u.workspaces.map((r) =>
        el("tr", {}, el("td", {}, r.workspace), el("td", { class: "num" }, number(r.calls)), el("td", { class: "num" }, number(r.tokens)),
          el("td", {}, meter(r.tokens, r.budget)), overrideCell("workspaces", r.workspace)))) : empty("No workspaces.")),
    el("div", { class: "card" }, el("h3", {}, "Models (cluster)"),
      routes.length ? table(["Model", "Backend", "Serves as", "Timeout"], routes.map((m) =>
        el("tr", {}, el("td", { class: "mono" }, m.name), el("td", {}, (m.backends || []).map((x) => x.backend).join(", ")),
          el("td", { class: "mono" }, (m.backends || []).map((x) => x.model || "").join(", ")), el("td", {}, m.timeout || "")))) : empty("Not reported by the operator."),
      c.inferenceRoute ? el("p", { class: "muted hint" }, "From AIGatewayRoute " + c.inferenceRoute + ". Grant a model as inference:model/<name>:invoke.") : null),
    el("div", { class: "card" }, el("h3", {}, "Rate limits (cluster)"),
      limits.length ? table(["Per", el("th", { class: "num" }, "Limit"), "Unit", "Counts"], limits.map((l) =>
        el("tr", {}, el("td", {}, (l.headers || []).join(", ") || "everything"), el("td", { class: "num" }, number(l.limit)), el("td", {}, l.unit || ""), el("td", {}, l.cost || "requests")))) : empty("None reported.")));
}

// Workspaces

let openWs = null;
async function showWorkspaces() {
  const { workspaces } = await admin("GET", "/workspaces");
  const name = el("input", { required: true, placeholder: "name", pattern: "[a-z0-9]([a-z0-9-]*[a-z0-9])?", "aria-label": "New workspace" });
  const quota = el("input", { type: "number", min: 0, value: 100, "aria-label": "Quota" });
  const firstAdmin = el("input", { type: "email", placeholder: "first admin's email", "aria-label": "First admin" });
  const view = [
    el("div", { class: "card" }, workspaces.length ? table(["Workspace", el("th", { class: "num" }, "Cells"), el("th", { class: "num" }, "Quota"), el("th", { class: "num" }, "Members"), "Admins", ""], workspaces.map((w) =>
      el("tr", {}, el("td", {}, w.name), el("td", { class: "num" }, number(w.cells)), el("td", { class: "num" }, number(w.quota)), el("td", { class: "num" }, number(w.members)),
        el("td", {}, w.admins.length ? w.admins.map((a) => el("span", { class: "chip" }, a)) : el("span", { class: "muted hint" }, "none")),
        el("td", {}, el("button", { type: "button", onclick: () => { openWs = w.name; show(); } }, "Manage"))))) : empty("No workspaces yet.")),
    el("form", { onsubmit: (e) => { e.preventDefault(); act(async () => {
      const members = firstAdmin.value.trim() ? { [firstAdmin.value.trim()]: "admin" } : undefined;
      await api("PUT", "/workspaces/" + enc(name.value.trim()), { quota: Number(quota.value), members });
      openWs = name.value.trim();
    }); } }, el("div", { class: "card" }, el("h3", {}, "New workspace"), el("div", { class: "row" }, name, quota, firstAdmin, el("button", {}, "Create")))),
  ];
  if (openWs) view.push(await workspaceCard(openWs));
  $("workspaces-view").replaceChildren(...view);
}

async function workspaceCard(ws) {
  const base = "/workspaces/" + enc(ws);
  const [info, { members }, { docs }] = await Promise.all([api("GET", base), api("GET", base + "/members"), api("GET", base + "/docs")]);
  const quota = el("input", { type: "number", min: 0, value: info.quota, "aria-label": "Quota" });
  const email = el("input", { type: "email", required: true, placeholder: "email", "aria-label": "Member's email" });
  const role = () => el("select", { "aria-label": "Role" }, ["viewer", "member", "admin"].map((r) => el("option", { value: r }, r)));
  const newRole = role(); newRole.value = "member";
  const path = el("input", { class: "mono", required: true, placeholder: "skills/email.md", "aria-label": "Document path" });
  const content = el("textarea", { class: "mono", rows: 6, cols: 60, required: true, "aria-label": "Document" });
  return el("div", { class: "card" }, el("h3", {}, "Workspace " + ws),
    el("form", { onsubmit: (e) => { e.preventDefault(); act(() => api("PUT", base, { quota: Number(quota.value) })); } },
      el("div", { class: "row" }, el("span", { class: "label" }, "Quota"), quota, el("button", {}, "Save"), el("span", { class: "muted hint" }, info.cells + " cells now"))),
    el("h3", { style: "margin-top: 1rem" }, "Members"),
    members.length ? table(["Email", "Role", "Added", ""], members.map((m) => {
      const r = role(); r.value = m.role;
      r.onchange = () => act(() => api("PUT", base + "/members/" + enc(m.email), { role: r.value }));
      return el("tr", {}, el("td", {}, m.email), el("td", {}, r), el("td", { class: "hint muted" }, date(m.addedAt) + " by " + m.addedBy),
        el("td", {}, el("button", { type: "button", class: "danger", onclick: () => { if (confirm("Remove " + m.email + " from " + ws + "? Their cells and chats stay theirs.")) act(() => api("DELETE", base + "/members/" + enc(m.email))); } }, "Remove")));
    })) : empty("No members."),
    el("form", { onsubmit: (e) => { e.preventDefault(); act(() => api("PUT", base + "/members/" + enc(email.value.trim()), { role: newRole.value })); } },
      el("div", { class: "row" }, el("span", { class: "label" }, "Add"), email, newRole, el("button", {}, "Add"))),
    el("h3", { style: "margin-top: 1rem" }, "Docs"),
    docs.length ? table(["Path", "Description", el("th", { class: "num" }, "Bytes"), ""], docs.map((d) =>
      el("tr", {}, el("td", { class: "mono" }, d.path), el("td", {}, d.description), el("td", { class: "num" }, number(d.bytes)),
        el("td", {}, el("button", { type: "button", onclick: async () => { path.value = d.path; content.value = await api("GET", base + "/docs/" + d.path.split("/").map(enc).join("/")); path.focus(); } }, "Edit"),
          el("button", { type: "button", class: "danger", onclick: () => { if (confirm("Delete " + d.path + "?")) act(() => api("DELETE", base + "/docs/" + d.path.split("/").map(enc).join("/"))); } }, "Delete"))))) : empty("No docs. The agent lists them in its prompt and reads one when it needs it."),
    el("form", { onsubmit: (e) => { e.preventDefault(); act(() => api("PUT", base + "/docs/" + path.value.trim().split("/").map(enc).join("/"), content.value, true)); } },
      el("div", { class: "row" }, el("span", { class: "label" }, "Write"), path), el("div", { class: "row" }, el("span", { class: "label" }, ""), content),
      el("div", { class: "row" }, el("span", { class: "label" }, ""), el("button", {}, "Save document"))));
}

// Blueprints

async function showBlueprints() {
  const { versions } = await admin("GET", "/blueprints");
  if (!versions.length) { $("blueprints-view").replaceChildren(empty("No Blueprints yet.")); return; }
  const byName = new Map();
  for (const v of versions) byName.set(v.name, [...(byName.get(v.name) ?? []), v]);
  $("blueprints-view").replaceChildren(...[...byName].map(([name, vs]) => el("div", { class: "card" }, el("h3", {}, name),
    table(["Version", "Status", "Author", "Published", "Asks for", ""], vs.slice().reverse().map((v) => {
      const path = "/blueprints/" + enc(name) + "/" + enc(v.version);
      const who = (o) => o ? (o.email || o.user) : "";
      return el("tr", {}, el("td", {}, v.version, el("div", { class: "muted hint mono" }, v.bundle.slice(0, 12))),
        el("td", {}, el("span", { class: "tag " + v.status }, v.status), v.withdrawnBy ? el("div", { class: "muted hint" }, "by " + who(v.withdrawnBy) + ", " + date(v.withdrawnAt)) : null),
        el("td", {}, v.author ? who(v.author) : el("span", { class: "muted hint" }, "admin"), v.session ? el("div", { class: "muted hint mono" }, v.workspace + " · " + v.session) : null),
        el("td", {}, v.publishedAt ? date(v.publishedAt) : "", v.publishedBy ? el("div", { class: "muted hint" }, "by " + who(v.publishedBy)) : null),
        el("td", {}, v.capabilities.length ? v.capabilities.map((c) => el("span", { class: "chip" }, c)) : el("span", { class: "muted hint" }, "nothing")),
        el("td", {}, v.status === "published" ? el("button", { type: "button", class: "danger", onclick: () => { if (confirm("Withdraw " + name + " " + v.version + "? No new cell can use it; cells on it keep running.")) act(() => api("POST", path + "/withdraw")); } }, "Withdraw")
          : v.status === "withdrawn" ? el("button", { type: "button", onclick: () => act(() => api("POST", path + "/restore")) }, "Restore") : null));
    })))));
}

// Users

async function showUsers() {
  const { users, month } = await admin("GET", "/users");
  $("users-view").replaceChildren(el("div", { class: "card" }, users.length ? table(["User", "First seen", "Last seen", el("th", { class: "num" }, "Tokens, " + month), "Budget", ""], users.map((u) =>
    el("tr", {}, el("td", {}, u.email || u.user, u.suspended ? el("span", { class: "tag suspended" }, " suspended") : null, el("div", { class: "muted hint mono" }, u.user),
      u.suspended ? el("div", { class: "muted hint" }, "by " + u.suspended.by + ", " + date(u.suspended.at)) : null),
      el("td", { class: "hint" }, date(u.firstSeen)), el("td", { class: "hint" }, date(u.lastSeen)), el("td", { class: "num" }, number(u.tokens)), el("td", {}, meter(u.tokens, u.budget)),
      el("td", {}, u.user === me.user ? el("span", { class: "muted hint" }, "you") : u.suspended
        ? el("button", { type: "button", onclick: () => act(() => admin("PUT", "/users/" + enc(u.user), { suspended: false })) }, "Lift suspension")
        : el("button", { type: "button", class: "danger", onclick: () => { if (confirm("Suspend " + (u.email || u.user) + "? Their requests, turns and cells are refused until you lift it.")) act(() => admin("PUT", "/users/" + enc(u.user), { suspended: true })); } }, "Suspend")))))
    : empty("Nobody has signed in yet.")));
}

// Audit log

const auditFilter = { user: "", workspace: "", cell: "", blueprint: "", decision: "", days: "1" };
async function showAudit() {
  const inputs = Object.fromEntries(Object.keys(auditFilter).map((k) => [k, el("input", { value: auditFilter[k], placeholder: k === "days" ? "days" : k, "aria-label": k, size: k === "days" ? 4 : 14 })]));
  const form = el("form", { onsubmit: (e) => { e.preventDefault(); for (const k of Object.keys(inputs)) auditFilter[k] = inputs[k].value.trim(); show(); } },
    el("div", { class: "card" }, el("div", { class: "row" }, Object.values(inputs), el("button", {}, "Search")),
      el("div", { class: "row muted hint" }, "user is a subject or an email; decision is e.g. allowed, denied, queued, metered, authored, published or admin")));
  const q = new URLSearchParams(Object.entries(auditFilter).filter(([, v]) => v));
  $("audit-view").replaceChildren(form, el("p", { class: "muted" }, "Searching…"));
  let r;
  try { r = await admin("GET", "/audit?" + q); } catch (err) { $("audit-view").replaceChildren(form, el("p", { class: "bad" }, String(err.message || err))); return; }
  const what = (x) => [x.action, x.grant, x.blueprint ? x.blueprint + (x.version ? "@" + x.version : "") : "", x.target, x.method && x.path ? x.method + " " + x.path : "", x.provider].filter(Boolean).join(" · ");
  $("audit-view").replaceChildren(form,
    el("p", { class: "muted hint" }, r.records.length + " records from " + r.scanned + " read" + (r.truncated ? "; there are more, narrow the search or the days" : "")),
    el("div", { class: "card" }, r.records.length ? table(["Time", "Decision", "Who", "Workspace", "Cell", "What", "Detail"], r.records.map((x) =>
      el("tr", {}, el("td", { class: "hint" }, new Date(x.time).toLocaleString()), el("td", {}, el("span", { class: "tag" }, x.decision)),
        el("td", {}, x.email || x.user), el("td", {}, x.workspace || ""), el("td", { class: "mono" }, x.cell || ""), el("td", { class: "mono" }, what(x)),
        el("td", {}, x.reason ? el("div", { class: "hint" }, x.reason) : null, x.detail ? el("pre", {}, x.detail) : null, x.status ? el("div", { class: "hint" }, "status " + x.status) : null,
          x.usage ? el("div", { class: "hint" }, number(x.usage.total ?? (x.usage.input + x.usage.output)) + " tokens") : null)))) : empty("No records match.")));
}

// Navigation

const SECTIONS = { fleet: showFleet, settings: showSettings, budgets: showBudgets, workspaces: showWorkspaces, blueprints: showBlueprints, users: showUsers, audit: showAudit };
let shown = null;
async function show() {
  const name = SECTIONS[location.hash.slice(1)] ? location.hash.slice(1) : "fleet";
  for (const id of Object.keys(SECTIONS)) $("section-" + id).hidden = id !== name;
  for (const a of $("nav").querySelectorAll("a")) {
    if (a.getAttribute("href") === "#" + name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const section = $("section-" + name);
  document.title = section.querySelector("h2").textContent + " · admin · kodo";
  const target = section.querySelector("div[id]");
  if (name !== shown) target.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  shown = name;
  try { await SECTIONS[name](); } catch (err) { showError(err); }
}
window.addEventListener("hashchange", () => { showError(null); show(); });
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

(async () => {
  try {
    me = await api("GET", "/whoami");
    $("who").textContent = me.email || me.user;
  } catch (err) { showError(err); return; }
  show();
})();
</script>
</body>
</html>
`;
