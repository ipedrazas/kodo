// The settings page at app.<domain>/settings/: everything a user manages,
// in one place. A client of the kernel API (and of the Gatekeeper's, for
// connections and approvals), like the home page; everything it shows goes
// in as text. ?workspace=<ws>&cell=<id> opens on one cell, so a gadget
// missing a grant, or the chat, can send its owner here.
export const SETTINGS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settings · kodo</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --soft: rgba(127,127,127,.08); --accent: #2563eb; --bad: #b91c1c; --good: #15803d; --focus: rgba(250, 204, 21, .18); }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: baseline; padding: .75rem 1rem; border-bottom: 1px solid var(--line); gap: 1rem; flex-wrap: wrap; }
  header h1 { font-size: 1.15rem; margin: 0; }
  header nav { font-size: .9rem; }
  .layout { display: flex; max-width: 72rem; margin: 0 auto; }
  aside { width: 13rem; padding: 1rem .75rem; flex-shrink: 0; }
  aside a { display: block; padding: .35rem .6rem; border-radius: .35rem; color: inherit; text-decoration: none; }
  aside a[aria-current] { background: var(--soft); font-weight: 600; }
  main { flex: 1; min-width: 0; padding: 1rem 1.25rem 3rem; }
  h2 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .lead { color: var(--muted); margin: 0 0 1rem; font-size: .92rem; }
  .muted { color: var(--muted); }
  .hint { font-size: .85rem; }
  .card { border: 1px solid var(--line); border-radius: .6rem; padding: .7rem .9rem; margin: 0 0 .75rem; }
  .card.focus { background: var(--focus); border-color: #ca8a04; }
  .card h3 { font-size: 1rem; margin: 0; display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-top: .45rem; }
  .label { font-size: .85rem; color: var(--muted); min-width: 4.5rem; }
  .chip { font: 13px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 1rem; padding: .05rem .5rem; display: inline-flex; align-items: center; gap: .2rem; }
  .chip button { border: 0; background: none; padding: 0 0 0 .2rem; cursor: pointer; color: var(--muted); font: inherit; }
  .tag { font-size: .78rem; border-radius: .3rem; padding: 0 .4rem; background: var(--soft); }
  .tag.draft { background: rgba(250, 204, 21, .25); }
  .tag.published { background: rgba(21, 128, 61, .15); }
  input, select, button { font: inherit; padding: .25rem .5rem; }
  input.mono { font: 13px ui-monospace, monospace; min-width: min(22rem, 100%); }
  button { cursor: pointer; }
  button.danger { color: var(--bad); }
  form { display: contents; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .6rem; margin-bottom: 1rem; }
  .stat { border: 1px solid var(--line); border-radius: .5rem; padding: .5rem .7rem; }
  .stat b { display: block; font-size: 1.25rem; font-variant-numeric: tabular-nums; }
  #error { color: var(--bad); min-height: 1.4em; margin: 0 0 .5rem; }
  .ok { color: var(--good); } .bad { color: var(--bad); }
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
  <h1>kodo <span class="muted">settings</span></h1>
  <nav><span id="who" class="muted"></span> · <a href="/">Cells</a> · <a href="/chat/">Chat</a> · <a href="/gatekeeper/" id="approvals">Approvals and connections</a> · <a href="/logout">Log out</a></nav>
</header>
<div class="layout">
  <aside id="nav">
    <a href="#workspace">Workspace</a>
    <a href="#cells">Cells</a>
    <a href="#gadgets">Gadgets</a>
    <a href="#chats">Chats</a>
    <a href="#connections">Connections</a>
    <a href="#usage">Usage</a>
  </aside>
  <main>
    <p id="error" role="alert"></p>
    <section id="section-workspace" hidden>
      <h2>Workspace</h2>
      <p class="lead">The workspace the cells, chat and these settings open in. This browser remembers it.</p>
      <div class="card">
        <div class="row">
          <span class="label">Open</span>
          <select id="ws-select" aria-label="Workspace"></select>
          <input id="ws-other" placeholder="another workspace" pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" aria-label="Another workspace" hidden>
          <button id="ws-open" type="button">Open</button>
        </div>
        <div class="row" id="ws-info"></div>
      </div>
    </section>
    <section id="section-cells" hidden>
      <h2>Cells</h2>
      <p class="lead">Your gadget instances in this workspace, and those shared with you. Only a cell's owner grants it capabilities, shares it, moves it to another version or deletes it.</p>
      <div id="cell-list"></div>
    </section>
    <section id="section-gadgets" hidden>
      <h2>Gadgets</h2>
      <p class="lead">Blueprint versions your agent wrote. A draft is yours alone until you publish it; then anyone can open it. Publishing is recorded in the audit log.</p>
      <div id="gadget-list"></div>
    </section>
    <section id="section-chats" hidden>
      <h2>Chats</h2>
      <p class="lead">Your chats with the agent in this workspace. Every run of a chat's code gets exactly the capabilities granted here.</p>
      <div id="chat-list"></div>
    </section>
    <section id="section-connections" hidden>
      <h2>Connections and approvals</h2>
      <p class="lead">Accounts your cells and chats act with through the Gatekeeper, which holds the tokens. Connect and approve on the Gatekeeper's page.</p>
      <div id="connection-list"></div>
    </section>
    <section id="section-usage" hidden>
      <h2>Usage</h2>
      <p class="lead">What your cells and chats did this month in this workspace.</p>
      <div id="usage-view"></div>
    </section>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const cellDomain = location.hostname.replace(/^app\\./, "g.");
let ws = params.get("workspace") || localStorage.getItem("kodo.workspace") || "team";
let focusCell = params.get("cell");
let me;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || data || res.status);
  return data;
}
const api = (method, path, body) => call(method, "/api" + path, body);
const wsApi = (method, path, body) => api(method, "/workspaces/" + encodeURIComponent(ws) + path, body);

function showError(err) { $("error").textContent = err ? String(err.message || err) : ""; }
// Runs an action, reports a failure, and redraws the section.
async function act(fn) {
  try { await fn(); showError(null); } catch (err) { showError(err); }
  await show();
}

const date = (ms) => ms ? new Date(ms).toLocaleString() : "";
const number = (n) => (n ?? 0).toLocaleString();
const bytes = (n) => n == null ? "—" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KiB" : (n / 1048576).toFixed(1) + " MiB";

function chips(list, remove) {
  if (!list.length) return [el("span", { class: "muted hint" }, "none")];
  return list.map((g) => el("span", { class: "chip" }, g,
    remove ? el("button", { type: "button", title: "Take back " + g, "aria-label": "Take back " + g, onclick: () => remove(g) }, "×") : null));
}

// A concrete example of a declared capability with wildcards.
function example(capability) {
  if (capability.startsWith("inference:")) return capability.replace("*", "default");
  if (capability.startsWith("github:")) return capability.replace("*", "acme").replace("*", "api");
  return capability.split("*").join("name");
}

// A form to grant one of offered (declared, maybe with *), or anything if
// offered is null.
function grantForm(offered, current, save) {
  const choices = offered ? offered.filter((c) => !current.includes(c)) : null;
  if (choices && !choices.length) return null;
  const input = el("input", { class: "mono", required: true, "aria-label": "Capability to grant", placeholder: "provider:resource:verb", value: choices ? choices[0] : "" });
  const hint = el("span", { class: "muted hint" });
  const explain = () => {
    const open = input.value.includes("*");
    hint.textContent = open ? "replace each * with what to allow, e.g. " + example(input.value) : "";
    hint.className = open ? "hint" : "muted hint";
  };
  input.addEventListener("input", explain);
  const picker = choices && choices.length > 1
    ? el("select", { "aria-label": "Declared capability", onchange: (e) => { input.value = e.target.value; explain(); input.focus(); } }, choices.map((c) => el("option", {}, c)))
    : null;
  explain();
  const form = el("form", { onsubmit: (e) => {
    e.preventDefault();
    const g = input.value.trim();
    if (!g || g.includes("*")) { hint.className = "hint bad"; input.focus(); return; }
    save([...current, g]);
  } }, el("div", { class: "row" }, el("span", { class: "label" }, "Grant"), picker, input, el("button", {}, "Grant"), hint));
  return form;
}

// Workspace

async function showWorkspace() {
  let known = [];
  try { known = (await api("GET", "/workspaces")).workspaces; } catch {}
  if (!known.includes(ws)) known = [ws, ...known];
  const select = $("ws-select");
  select.replaceChildren(...known.map((n) => el("option", { value: n, selected: n === ws }, n)), el("option", { value: "" }, "Other…"));
  select.onchange = () => { $("ws-other").hidden = select.value !== ""; if (!select.value) $("ws-other").focus(); };
  $("ws-other").hidden = true;
  try {
    const info = await wsApi("GET", "");
    $("ws-info").replaceChildren(el("span", { class: "label" }, "Cells"), el("span", {}, number(info.cells) + " of " + number(info.quota) + " in the workspace"));
  } catch (err) {
    $("ws-info").replaceChildren(el("span", { class: "bad" }, String(err.message || err)));
  }
}
$("ws-open").onclick = () => {
  const next = $("ws-select").value || $("ws-other").value.trim();
  if (!next) return;
  ws = next;
  localStorage.setItem("kodo.workspace", ws);
  remember();
  show();
};

// Cells

const declared = {};
async function versionsOf(blueprint) {
  if (!declared[blueprint]) declared[blueprint] = (await api("GET", "/blueprints/" + encodeURIComponent(blueprint))).versions;
  return declared[blueprint];
}

async function showCells() {
  const { cells } = await wsApi("GET", "/cells");
  // Each Blueprint's versions once, all at once.
  await Promise.all([...new Set(cells.map((c) => c.blueprint))].map((b) => versionsOf(b).catch(() => [])));
  const list = $("cell-list");
  if (!cells.length) { list.replaceChildren(el("p", { class: "muted" }, "No cells in " + ws + " yet. Create one on the ", el("a", { href: "/" }, "Cells"), " page.")); return; }
  list.replaceChildren(...(await Promise.all(cells.map(cellCard))));
  if (focusCell) {
    const card = $("cell-" + focusCell);
    if (card) { card.classList.add("focus"); card.scrollIntoView({ block: "center" }); card.querySelector("input.mono")?.focus(); }
    focusCell = null;
  }
}

async function cellCard(cell) {
  const owned = cell.owner.user === me.user;
  const base = "/cells/" + cell.id;
  const url = "https://" + cell.id + "." + cellDomain + "/";
  const card = el("div", { class: "card", id: "cell-" + cell.id },
    el("h3", {}, el("a", { href: url, target: "_blank", rel: "noopener" }, cell.id), el("span", { class: "muted" }, cell.blueprint + " " + cell.version),
      owned ? null : el("span", { class: "tag" }, "shared by " + cell.owner.email)));
  if (!owned) {
    card.append(el("div", { class: "row" }, el("span", { class: "label" }, "Your role"), el("span", {}, cell.shares[me.email] || "")));
    return card;
  }
  let versions = [];
  try { versions = await versionsOf(cell.blueprint); } catch {}
  const current = versions.find((v) => v.version === cell.version);
  const setGrants = (grants) => act(() => wsApi("PUT", base + "/grants", { grants }));
  card.append(el("div", { class: "row" }, el("span", { class: "label" }, "Grants"), chips(cell.grants, (g) => setGrants(cell.grants.filter((x) => x !== g)))));
  const declaredCaps = current?.capabilities ?? [];
  if (declaredCaps.length) {
    const form = grantForm(declaredCaps, cell.grants, setGrants);
    if (form) card.append(form);
  } else {
    card.append(el("div", { class: "row" }, el("span", { class: "label" }, ""), el("span", { class: "muted hint" }, "This version asks for no capabilities.")));
  }

  const shares = Object.entries(cell.shares);
  card.append(el("div", { class: "row" }, el("span", { class: "label" }, "Shared with"),
    shares.length ? shares.map(([email, role]) => el("span", { class: "chip" }, email + " (" + role + ")",
      el("button", { type: "button", title: "Stop sharing with " + email, "aria-label": "Stop sharing with " + email,
        onclick: () => act(() => wsApi("DELETE", base + "/shares/" + encodeURIComponent(email))) }, "×"))) : el("span", { class: "muted hint" }, "nobody")));
  const email = el("input", { type: "email", placeholder: "email", required: true, "aria-label": "Share with" });
  const role = el("select", { "aria-label": "Role" }, el("option", {}, "viewer"), el("option", {}, "editor"));
  card.append(el("form", { onsubmit: (e) => { e.preventDefault(); act(() => wsApi("PUT", base + "/shares/" + encodeURIComponent(email.value.trim()), { role: role.value })); } },
    el("div", { class: "row" }, el("span", { class: "label" }, "Share"), email, role, el("button", {}, "Share"))));

  const others = versions.filter((v) => v.version !== cell.version);
  const moveRow = el("div", { class: "row" }, el("span", { class: "label" }, "Version"));
  if (others.length) {
    const pick = el("select", { "aria-label": "Version" }, others.map((v) => el("option", { value: v.version }, v.version + (v.status === "draft" ? " (draft)" : ""))));
    moveRow.append(el("span", {}, cell.version), pick, el("button", { type: "button", onclick: () => {
      if (confirm("Move " + cell.id + " to " + cell.blueprint + " " + pick.value + "? It keeps its data; grants the new version does not declare are dropped.")) act(() => wsApi("PATCH", base, { version: pick.value }));
    } }, "Move"));
  } else {
    moveRow.append(el("span", {}, cell.version), el("span", { class: "muted hint" }, "the only version you can use"));
  }
  moveRow.append(el("span", { style: "flex: 1" }), el("button", { type: "button", class: "danger", onclick: () => {
    if (confirm("Delete " + cell.id + " and all its data? This cannot be undone.")) act(() => wsApi("DELETE", base));
  } }, "Delete cell"));
  card.append(moveRow);
  return card;
}

// Gadgets

async function showGadgets() {
  const { versions } = await api("GET", "/blueprints?author=me");
  const list = $("gadget-list");
  if (!versions.length) {
    list.replaceChildren(el("p", { class: "muted" }, "Your agent has written no gadgets yet. Ask for one in the ", el("a", { href: "/chat/" }, "chat"), "."));
    return;
  }
  const byName = new Map();
  for (const v of versions) byName.set(v.name, [...(byName.get(v.name) ?? []), v]);
  const head = el("tr", {}, el("th", {}, "Version"), el("th", {}, "Status"), el("th", {}, "Asks for"), el("th", {}, "Written"), el("th", {}, ""));
  list.replaceChildren(...[...byName].map(([name, vs]) =>
    el("div", { class: "card" }, el("h3", {}, name),
      el("table", {}, el("thead", {}, head.cloneNode(true)), el("tbody", {}, vs.map((v) => versionRow(name, v)))))));
}

function versionRow(name, v) {
  const path = "/blueprints/" + encodeURIComponent(name) + "/" + encodeURIComponent(v.version);
  const publish = () => {
    const asks = v.capabilities.length ? " It asks for " + v.capabilities.join(", ") + "." : "";
    if (confirm("Publish " + name + " " + v.version + "? Anyone will then be able to open it." + asks)) act(() => api("POST", path + "/publish"));
  };
  const open = () => act(async () => {
    const cell = await wsApi("POST", "/cells", { blueprint: name, version: v.version });
    focusCell = cell.id;
    location.hash = "#cells";
  });
  const status = el("td", {}, el("span", { class: "tag " + v.status }, v.status === "draft" ? "draft" : "published"));
  if (v.publishedBy) status.append(el("div", { class: "muted hint" }, date(v.publishedAt)));
  const asks = v.capabilities.length ? v.capabilities.map((c) => el("div", { class: "chip" }, c)) : el("span", { class: "muted hint" }, "nothing");
  const actions = el("div", { class: "row", style: "margin: 0" },
    v.status === "draft" ? el("button", { type: "button", onclick: publish }, "Publish") : null,
    el("button", { type: "button", onclick: open }, "New cell"));
  return el("tr", {}, el("td", {}, v.version), status, el("td", {}, asks), el("td", { class: "muted hint" }, date(v.createdAt)), el("td", {}, actions));
}

// Chats

async function showChats() {
  const { sessions } = await wsApi("GET", "/sessions");
  const list = $("chat-list");
  if (!sessions.length) { list.replaceChildren(el("p", { class: "muted" }, "No chats in " + ws + " yet. ", el("a", { href: "/chat/" }, "Start one"), ".")); return; }
  const views = await Promise.all(sessions.map((s) => wsApi("GET", "/sessions/" + s.id + "?after=999999999")));
  const cards = [];
  for (const [i, s] of sessions.entries()) {
    const view = views[i];
    const save = (grants) => act(() => wsApi("PUT", "/sessions/" + s.id + "/grants", { grants }));
    cards.push(el("div", { class: "card" },
      el("h3", {}, el("a", { href: "/chat/?workspace=" + encodeURIComponent(ws) + "&session=" + s.id }, s.title), el("span", { class: "muted hint" }, date(s.createdAt))),
      el("div", { class: "row" }, el("span", { class: "label" }, "Grants"), chips(view.grants, (g) => save(view.grants.filter((x) => x !== g)))),
      grantForm(null, view.grants, save),
      el("div", { class: "row" }, el("span", { class: "label" }, ""),
        view.pending.length ? el("span", {}, view.pending.length + " call(s) wait for approval: ", el("a", { href: "/gatekeeper/" }, "Approvals")) : null,
        el("span", { style: "flex: 1" }),
        el("button", { type: "button", class: "danger", onclick: () => { if (confirm("Delete the chat \\"" + s.title + "\\" and its transcript?")) act(() => wsApi("DELETE", "/sessions/" + s.id)); } }, "Delete chat"))));
  }
  list.replaceChildren(...cards);
}

// Connections and approvals

async function showConnections() {
  const list = $("connection-list");
  let data, pending = [];
  try {
    data = await call("GET", "/gatekeeper/api/connections");
    pending = (await call("GET", "/gatekeeper/api/approvals?state=pending")).approvals;
  } catch (err) {
    list.replaceChildren(el("p", { class: "muted" }, "This deployment has no Gatekeeper, or it did not answer: " + String(err.message || err)));
    return;
  }
  const connected = new Map(data.connections.map((c) => [c.provider, c]));
  list.replaceChildren(
    el("div", { class: "card" }, el("h3", {}, "Approvals"),
      el("div", { class: "row" }, pending.length ? el("span", {}, el("b", {}, String(pending.length)), " call(s) wait for your approval.") : el("span", { class: "muted" }, "Nothing waits for your approval."),
        el("a", { href: "/gatekeeper/" }, pending.length ? "Review them" : "History"))),
    el("div", { class: "card" }, el("h3", {}, "Accounts"),
      el("table", {}, el("tbody", {}, data.providers.map((p) => {
        const c = connected.get(p.name);
        return el("tr", {}, el("td", {}, p.name), el("td", {}, c ? el("span", { class: "ok" }, "connected" + (c.account ? " as " + c.account : "")) : el("span", { class: "muted" }, "not connected")),
          el("td", { class: "muted hint" }, c ? date(Date.parse(c.connectedAt)) : ""));
      }))),
      el("div", { class: "row" }, el("a", { href: "/gatekeeper/" }, "Connect or disconnect accounts"),
        el("span", { class: "muted hint" }, "Models and public web APIs need no connection."))));
}

// Usage

async function showUsage() {
  const u = await wsApi("GET", "/usage");
  const t = u.totals;
  const stat = (label, value) => el("div", { class: "stat" }, el("span", { class: "muted hint" }, label), el("b", {}, value));
  $("usage-view").replaceChildren(
    el("p", { class: "muted hint" }, u.month + ", UTC"),
    el("div", { class: "stats" }, stat("Cells", number(t.cells)), stat("Active cells", number(t.activeCells)), stat("Chats", number(t.sessions)),
      stat("Requests", number(t.requests)), stat("Model tokens", number(t.inference.total)), stat("Storage", bytes(t.storageBytes))),
    u.cells.length ? el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Cell or chat"), el("th", {}, "Blueprint"), el("th", { class: "num" }, "Requests"), el("th", { class: "num" }, "Model calls"), el("th", { class: "num" }, "Tokens"), el("th", { class: "num" }, "Storage"))),
      el("tbody", {}, u.cells.map((r) => {
        const calls = Object.values(r.inference).reduce((a, m) => a + m.calls, 0);
        const tokens = Object.values(r.inference).reduce((a, m) => a + m.total, 0);
        return el("tr", {}, el("td", {}, r.kind === "session" ? "chat " + r.id : r.id, r.error ? el("div", { class: "bad hint" }, r.error) : null),
          el("td", {}, r.kind === "session" ? "agent" : r.blueprint + " " + r.version), el("td", { class: "num" }, number(r.requests)),
          el("td", { class: "num" }, number(calls)), el("td", { class: "num" }, number(tokens)), el("td", { class: "num" }, bytes(r.storageBytes)));
      }))) : el("p", { class: "muted" }, "Nothing yet this month."));
}

// Navigation

let shown = null;
const SECTIONS = { workspace: showWorkspace, cells: showCells, gadgets: showGadgets, chats: showChats, connections: showConnections, usage: showUsage };
function remember() {
  const q = new URLSearchParams({ workspace: ws });
  history.replaceState(null, "", "/settings/?" + q + location.hash);
}
async function show() {
  const name = SECTIONS[location.hash.slice(1)] ? location.hash.slice(1) : (focusCell ? "cells" : "workspace");
  for (const id of Object.keys(SECTIONS)) $("section-" + id).hidden = id !== name;
  for (const a of $("nav").querySelectorAll("a")) {
    if (a.getAttribute("href") === "#" + name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const section = $("section-" + name);
  document.title = section.querySelector("h2").textContent + " · " + ws + " · kodo";
  // Sections that load show it until they do; a redraw after an action
  // keeps what is there.
  const target = section.querySelector("div[id]");
  if (name !== shown && target && name !== "workspace") target.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  shown = name;
  try { await SECTIONS[name](); } catch (err) { showError(err); }
}
window.addEventListener("hashchange", () => { showError(null); show(); });
// Opening a section never scrolls the page to it.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

(async () => {
  try {
    me = await api("GET", "/whoami");
    $("who").textContent = me.email || me.user;
  } catch (err) { showError(err); return; }
  localStorage.setItem("kodo.workspace", ws);
  remember();
  show();
  try {
    const n = (await call("GET", "/gatekeeper/api/approvals?state=pending")).approvals.length;
    if (n) { $("approvals").textContent = n + " waiting for approval"; $("approvals").style.fontWeight = "600"; }
  } catch {}
})();
</script>
</body>
</html>
`;
