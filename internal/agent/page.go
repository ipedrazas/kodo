package agent

// chatPage is the chat at app.<domain>/chat/. It reads sessions and their
// transcripts from the kernel API (/api/, the same origin), and starts
// sessions and turns through the agent (/chat/api/). Everything it shows
// from a transcript goes in as text, never as HTML.
// ?workspace=<ws>&session=<id> opens one session.
const chatPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kodo chat</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --soft: rgba(127,127,127,.08); --note: rgba(250,204,21,.18); --accent: #2563eb; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; align-items: baseline; padding: .75rem 1rem; border-bottom: 1px solid var(--line); gap: 1rem; flex-wrap: wrap; }
  header h1 { font-size: 1.15rem; margin: 0; }
  header nav { font-size: .9rem; }
  .muted { color: var(--muted); }
  main { flex: 1; display: flex; min-height: 0; }
  aside { width: 16rem; border-right: 1px solid var(--line); padding: .75rem; overflow-y: auto; flex-shrink: 0; }
  aside form { display: flex; gap: .35rem; margin-bottom: .75rem; }
  aside input { flex: 1; min-width: 0; }
  #sessions { list-style: none; margin: .5rem 0 0; padding: 0; }
  #sessions li a { display: block; padding: .35rem .5rem; border-radius: .35rem; color: inherit; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #sessions li a[aria-current] { background: var(--soft); font-weight: 600; }
  section#chat { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #top { padding: .6rem 1rem; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
  #title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #log { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: .75rem; }
  .msg { max-width: 48rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .user { align-self: flex-end; background: var(--soft); border-radius: .75rem; padding: .5rem .8rem; }
  .assistant p { margin: 0 0 .5rem; }
  .assistant pre, details pre { background: var(--soft); padding: .5rem .7rem; border-radius: .4rem; overflow-x: auto; white-space: pre; font: 13px/1.45 ui-monospace, monospace; margin: .35rem 0; }
  code { font: 13px ui-monospace, monospace; background: var(--soft); padding: 0 .2rem; border-radius: .2rem; }
  details.tool { border: 1px solid var(--line); border-radius: .5rem; padding: .3rem .6rem; max-width: 48rem; }
  details.tool summary { cursor: pointer; color: var(--muted); font-size: .9rem; }
  .ok { color: #15803d; } .bad { color: #b91c1c; }
  .event { background: var(--note); border-radius: .5rem; padding: .4rem .7rem; font-size: .92rem; max-width: 48rem; }
  #banner { margin: 0 1rem; }
  #composer { display: flex; gap: .5rem; padding: .75rem 1rem; border-top: 1px solid var(--line); }
  #composer textarea { flex: 1; font: inherit; padding: .45rem .6rem; resize: vertical; min-height: 2.6rem; max-height: 12rem; }
  input, button, textarea { font: inherit; }
  input { padding: .25rem .5rem; }
  button { padding: .3rem .8rem; cursor: pointer; }
  #settings { padding: .5rem 1rem .75rem; border-bottom: 1px solid var(--line); }
  .grants { display: flex; flex-wrap: wrap; gap: .35rem; margin: .4rem 0; }
  .grant { font: 13px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 1rem; padding: .05rem .5rem; }
  .grant button { border: 0; background: none; padding: 0 0 0 .3rem; cursor: pointer; color: var(--muted); }
  #grant-form { display: flex; gap: .4rem; flex-wrap: wrap; }
  #grant-form input { font: 13px ui-monospace, monospace; min-width: min(22rem, 100%); flex: 1; }
  .hint { font-size: .85rem; }
  #error { color: #b91c1c; margin: .4rem 1rem 0; min-height: 0; }
  #empty { margin: auto; text-align: center; max-width: 30rem; }
  [hidden] { display: none !important; }
  @media (max-width: 700px) {
    main { flex-direction: column; }
    aside { width: auto; border-right: 0; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; padding: .5rem 1rem; overflow: visible; }
    aside form { margin: 0; flex: 1 1 12rem; }
    #sessions { display: flex; gap: .3rem; overflow-x: auto; margin: 0; width: 100%; }
    #sessions li a { max-width: 12rem; }
  }
</style>
</head>
<body>
<header>
  <h1>kodo <span class="muted">chat</span></h1>
  <nav><span id="who" class="muted"></span> · <a href="/">Cells</a> · <a href="/gatekeeper/">Approvals and connections</a> · <a href="/logout">Log out</a></nav>
</header>
<main>
  <aside>
    <form id="workspace-form">
      <input id="workspace" required pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" aria-label="Workspace" placeholder="workspace">
      <button>Open</button>
    </form>
    <button id="new" type="button">New chat</button>
    <ul id="sessions"></ul>
  </aside>
  <section id="chat">
    <div id="top" hidden>
      <span id="title"></span>
      <span><button id="toggle-settings" type="button">Settings</button></span>
    </div>
    <div id="settings" hidden>
      <div class="hint muted">What this chat's code may use. Each run gets exactly these; calls that send, write or delete still wait for your approval.</div>
      <div class="grants" id="grants"></div>
      <form id="grant-form">
        <input id="grant" placeholder="github:repo/acme/api:read" aria-label="Capability to grant" required>
        <button>Grant</button>
        <button type="button" id="delete" class="bad">Delete chat</button>
      </form>
      <div class="hint muted">Capabilities are provider:resource:verb, for example <code>github:repo/OWNER/REPO:read</code>, <code>web:hn.algolia.com/api/v1:read</code>, <code>email:outbox:send</code> or <code>inference:model/default:invoke</code>. Connect accounts at <a href="/gatekeeper/">Approvals and connections</a>.</div>
    </div>
    <p id="error" role="alert"></p>
    <p id="banner" class="event" hidden></p>
    <div id="log"><div id="empty" class="muted">Open a workspace, then start a chat. The agent answers by writing and running code with the capabilities you grant the chat.</div></div>
    <form id="composer" hidden>
      <textarea id="input" placeholder="Ask the agent…" aria-label="Message" rows="2"></textarea>
      <button id="send">Send</button>
    </form>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let ws = params.get("workspace") || localStorage.getItem("kodo-workspace") || "";
let current = params.get("session");
let session = null;
let seen = 0;
let timer = null;
let config = { grant: "" };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || data || res.status);
  return data;
}
const api = (method, path, body) => call(method, "/api/workspaces/" + encodeURIComponent(ws) + path, body);
const agent = (method, path, body) => call(method, "/chat/api/workspaces/" + encodeURIComponent(ws) + path, body);

function showError(err) { $("error").textContent = err ? String(err.message || err) : ""; }

function remember() {
  const q = new URLSearchParams();
  if (ws) q.set("workspace", ws);
  if (current) q.set("session", current);
  history.replaceState(null, "", "/chat/" + (q.toString() ? "?" + q : ""));
}

async function loadSessions() {
  if (!ws) return;
  const { sessions } = await api("GET", "/sessions");
  const list = $("sessions");
  list.replaceChildren(...sessions.map((s) => el("li", {}, el("a", {
    href: "?workspace=" + encodeURIComponent(ws) + "&session=" + s.id,
    ...(s.id === current ? { "aria-current": "page" } : {}),
    onclick: (e) => { e.preventDefault(); open(s.id); },
  }, s.title))));
}

async function open(id) {
  current = id;
  session = null;
  seen = 0;
  $("log").replaceChildren();
  remember();
  await refresh();
  await loadSessions();
}

// Simple markdown: fenced code, inline code, bold and paragraphs, all as
// text.
function inline(p, text) {
  text.split(/\x60([^\x60]+)\x60/).forEach((bit, j) => {
    if (j % 2) { p.append(el("code", {}, bit)); return; }
    bit.split(/\*\*([^*]+)\*\*/).forEach((b, k) => p.append(k % 2 ? el("strong", {}, b) : b));
  });
}
function prose(text) {
  const box = el("div", { class: "msg assistant" });
  const parts = text.split(/\x60\x60\x60[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2) { box.append(el("pre", {}, part.replace(/\n$/, ""))); return; }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el("p");
      inline(p, para);
      box.append(p);
    }
  });
  return box;
}

function parse(json) { try { return JSON.parse(json); } catch { return null; } }

// A tool call and, once it arrives, its result, in one box.
const tools = new Map();
function toolBox(call) {
  const args = parse(call.function.arguments) || {};
  const summary = el("summary", {}, call.function.name === "run_code" ? "Ran code" : call.function.name === "read_doc" ? "Read " + (args.path || "a document") : call.function.name);
  const box = el("details", { class: "tool" }, summary);
  if (args.code) box.append(el("pre", {}, args.code));
  tools.set(call.id, { box, summary });
  return box;
}
function toolResult(m) {
  const t = tools.get(m.tool_call_id);
  if (!t) return;
  const r = parse(m.content);
  if (m.name === "run_code" && r) {
    t.summary.append(" — ", el("span", { class: r.ok ? "ok" : "bad" }, r.ok ? "ok" : "failed"));
    if (r.approvals && r.approvals.length) t.summary.append(" — waiting for approval");
    const shown = r.ok ? r.value : r.error;
    t.box.append(el("pre", {}, typeof shown === "string" ? shown : JSON.stringify(shown, null, 2)));
    if (r.logs && r.logs.length) t.box.append(el("div", { class: "muted hint" }, "Logs"), el("pre", {}, r.logs.join("\n")));
    if (m.run) t.box.append(el("div", { class: "muted hint" }, "Run " + m.run));
  } else {
    t.box.append(el("pre", {}, m.content.length > 4000 ? m.content.slice(0, 4000) + "\n…" : m.content));
  }
}

function render(m) {
  const log = $("log");
  if (m.role === "user") log.append(el("div", { class: "msg user" }, m.content));
  else if (m.role === "assistant") {
    if (m.content) log.append(prose(m.content));
    for (const c of m.tool_calls || []) log.append(toolBox(c));
  } else if (m.role === "tool") toolResult(m);
  else if (m.role === "event") {
    const e = el("div", { class: "event" }, m.content);
    if (m.approval) e.append(" ", el("a", { href: "/gatekeeper/" }, "Approvals"));
    log.append(e);
  }
}

function showSession() {
  $("top").hidden = $("composer").hidden = false;
  $("title").textContent = session.title;
  document.title = session.title + " · kodo chat";
  const busy = !!session.turn;
  $("send").disabled = busy;
  $("send").textContent = busy ? "Thinking…" : "Send";
  const pending = session.pending || [];
  $("banner").hidden = !pending.length;
  if (pending.length) {
    $("banner").replaceChildren(pending.length + (pending.length === 1 ? " call waits" : " calls wait") + " for your approval: ", el("a", { href: "/gatekeeper/" }, "Approvals"));
  }
  $("grants").replaceChildren(...(session.grants.length ? session.grants.map((g) => el("span", { class: "grant" }, g,
    el("button", { type: "button", title: "Revoke " + g, "aria-label": "Revoke " + g, onclick: () => setGrants(session.grants.filter((x) => x !== g)) }, "×"))) : [el("span", { class: "muted hint" }, "No capabilities: the agent cannot think until you grant " + (config.grant || "its model") + ".")]));
}

async function refresh() {
  clearTimeout(timer);
  if (!current) return;
  try {
    const s = await api("GET", "/sessions/" + current + "?after=" + seen);
    const fresh = !session;
    session = { ...s, messages: undefined };
    if (fresh) $("log").replaceChildren();
    for (const m of s.messages) { render(m); seen = m.seq; }
    if (s.messages.length) $("log").scrollTop = $("log").scrollHeight;
    showSession();
    showError(null);
    const again = session.turn ? 1000 : session.pending.length ? 5000 : 0;
    if (again) timer = setTimeout(refresh, again);
  } catch (err) {
    showError(err);
    timer = setTimeout(refresh, 5000);
  }
}

async function setGrants(grants) {
  try {
    session.grants = await api("PUT", "/sessions/" + current + "/grants", { grants });
    showSession();
    showError(null);
  } catch (err) { showError(err); }
}

$("workspace-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  ws = $("workspace").value;
  localStorage.setItem("kodo-workspace", ws);
  current = null;
  remember();
  try { await loadSessions(); showError(null); } catch (err) { showError(err); }
});

$("new").addEventListener("click", async () => {
  if (!ws) return showError("Open a workspace first.");
  try {
    const s = await agent("POST", "/sessions", {});
    await open(s.id);
    $("input").focus();
  } catch (err) { showError(err); }
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = $("input").value.trim();
  if (!content || !current) return;
  $("send").disabled = true;
  try {
    await agent("POST", "/sessions/" + current + "/messages", { content });
    $("input").value = "";
    await refresh();
    await loadSessions();
  } catch (err) { showError(err); $("send").disabled = false; }
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});

$("toggle-settings").addEventListener("click", () => { $("settings").hidden = !$("settings").hidden; });
$("grant-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const g = $("grant").value.trim();
  if (g && !session.grants.includes(g)) setGrants([...session.grants, g]).then(() => { $("grant").value = ""; });
});
$("delete").addEventListener("click", async () => {
  if (!confirm("Delete this chat and its transcript?")) return;
  try {
    await api("DELETE", "/sessions/" + current);
    current = null;
    session = null;
    remember();
    $("top").hidden = $("composer").hidden = $("settings").hidden = true;
    $("log").replaceChildren();
    await loadSessions();
  } catch (err) { showError(err); }
});
window.addEventListener("focus", () => { if (current) refresh(); });

(async () => {
  $("workspace").value = ws;
  try {
    const me = await call("GET", "/api/whoami");
    $("who").textContent = me.email || me.user || "";
    config = await call("GET", "/chat/api/config");
  } catch (err) { showError(err); }
  if (ws) {
    try { await loadSessions(); } catch (err) { showError(err); }
    if (current) await open(current);
  }
})();
</script>
</body>
</html>
`
