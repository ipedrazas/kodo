package gatekeeper

// gatekeeperPage is served at app.<domain>/gatekeeper/: the calls waiting
// for the user's approval, what happened to earlier ones, and the user's
// connections to external services with a form to add a token. Tokens go
// straight to the Gatekeeper, never through a fleet.
const gatekeeperPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kodo approvals and connections</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --ok: #15803d; --bad: #b91c1c; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
  h1 { font-size: 1.4rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  input, select, button { font: inherit; padding: .25rem .5rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  input[type=password] { flex: 1; min-width: 12rem; }
  #error { color: var(--bad); min-height: 1.5em; }
  .approval { border: 1px solid var(--line); border-radius: 6px; padding: .75rem 1rem; margin: .75rem 0; }
  .approval h3 { font-size: 1rem; margin: 0 0 .25rem; }
  .approval dl { display: grid; grid-template-columns: max-content 1fr; gap: .1rem .75rem; margin: .5rem 0; }
  .approval dt { color: var(--muted); }
  .approval dd { margin: 0; overflow-wrap: anywhere; }
  .approval pre { white-space: pre-wrap; overflow-wrap: anywhere; background: color-mix(in srgb, currentColor 6%, transparent);
    padding: .5rem .75rem; border-radius: 4px; max-height: 24rem; overflow: auto; margin: .5rem 0; }
  .actions { display: flex; gap: .5rem; }
  .state-done { color: var(--ok); }
  .state-failed, .state-rejected, .state-expired { color: var(--bad); }
</style>
</head>
<body>
<header>
  <h1>Approvals</h1>
  <span><span id="who" class="muted"></span> · <a href="/">Cells</a></span>
</header>
<p class="muted">A gadget's calls that send, write or delete wait here until you approve them. Each runs at most once, with your connection, exactly as shown.</p>
<p id="error" role="alert"></p>

<div id="pending"><p class="muted">Loading…</p></div>

<h2>Recent</h2>
<table>
  <thead><tr><th>When</th><th>What</th><th>Cell</th><th>Outcome</th></tr></thead>
  <tbody id="recent"></tbody>
</table>

<h2>Connections</h2>
<p class="muted">Gadgets never see these tokens. A gadget can use a connection only through a capability you grant to one of your cells, and every call is recorded.</p>
<table>
  <thead><tr><th>Service</th><th>Account</th><th>Connected</th><th></th></tr></thead>
  <tbody id="connections"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
</table>

<h2>Connect</h2>
<form id="connect">
  <select id="provider" aria-label="Service"></select>
  <input id="account" type="text" autocomplete="off" aria-label="Account" hidden>
  <input id="token" type="password" required autocomplete="off" placeholder="Token" aria-label="Token">
  <button>Connect</button>
</form>
<p class="muted">For GitHub, a fine-grained personal access token with read-only access to the repositories your gadgets need. For email, a Resend API key (sending access is enough) and the From address to send as, on a domain verified in Resend.</p>

<script>
const $ = (id) => document.getElementById(id);
const cellDomain = location.hostname.replace(/^app\./, "g.");
let providers = [];
const api = async (method, path, body) => {
  const res = await fetch("/gatekeeper/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.status);
  return data;
};
const show = (err) => { $("error").textContent = err ? String(err.message ?? err) : ""; };
const el = (tag, text, attrs = {}) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return Object.assign(e, attrs);
};
const when = (t) => (t ? new Date(t).toLocaleString() : "");
const emptyRow = (text) => { const tr = el("tr"); tr.append(el("td", text, { colSpan: 4, className: "muted" })); return tr; };
const cellLink = (a) => el("a", a.cell, { href: "https://" + a.cell + "." + cellDomain + "/", target: "_blank", rel: "noopener" });

function pendingCard(a) {
  const card = el("section", undefined, { className: "approval" });
  card.append(el("h3", a.summary.title || a.capability));
  const meta = el("p", undefined, { className: "muted" });
  meta.append("Cell ", cellLink(a), " (" + a.blueprint + " " + a.version + ", workspace " + a.workspace + ") asked " + when(a.createdAt) + " under ", el("code", a.capability));
  card.append(meta);
  const dl = el("dl");
  for (const f of a.summary.fields ?? []) dl.append(el("dt", f.name), el("dd", f.value));
  card.append(dl);
  if (a.summary.body) card.append(el("pre", a.summary.body));
  const actions = el("div", undefined, { className: "actions" });
  const approve = el("button", "Approve and run");
  const reject = el("button", "Reject");
  const act = (verb) => async () => {
    approve.disabled = reject.disabled = true;
    try {
      const { approval } = await api("POST", "/approvals/" + a.id + "/" + verb);
      show(approval.state === "failed" ? new Error("The call failed: " + approval.reason) : null);
    } catch (e) { show(e); }
    load();
  };
  approve.onclick = act("approve");
  reject.onclick = act("reject");
  actions.append(approve, reject);
  card.append(actions, el("p", "Expires " + when(a.expiresAt), { className: "muted" }));
  return card;
}

function outcome(a) {
  const td = el("td", undefined, { className: "state-" + a.state });
  let text = a.state;
  if (a.state === "done") text = "sent · " + a.result.status;
  if (a.decidedBy) text += " · by " + a.decidedBy;
  td.append(el("div", text));
  if (a.reason) td.append(el("div", a.reason, { className: "muted" }));
  return td;
}

async function loadApprovals() {
  const { approvals } = await api("GET", "/approvals");
  const pending = approvals.filter((a) => a.state === "pending");
  $("pending").replaceChildren(...(pending.length ? pending.map(pendingCard) : [el("p", "Nothing is waiting for you.", { className: "muted" })]));
  const done = approvals.filter((a) => a.state !== "pending");
  const rows = done.map((a) => {
    const tr = el("tr");
    const what = el("td", (a.summary.title || a.capability));
    const subject = (a.summary.fields ?? []).find((f) => f.name === "Subject");
    if (subject) what.append(el("div", subject.value, { className: "muted" }));
    const cell = el("td");
    cell.append(cellLink(a));
    tr.append(el("td", when(a.finishedAt || a.decidedAt || a.createdAt)), what, cell, outcome(a));
    return tr;
  });
  if (!rows.length) rows.push(emptyRow("None yet."));
  $("recent").replaceChildren(...rows);
}

async function loadConnections() {
  const data = await api("GET", "/connections");
  $("who").textContent = data.user.email || data.user.user;
  providers = data.providers;
  const selected = $("provider").value;
  $("provider").replaceChildren(...providers.map((p) => new Option(p.name, p.name)));
  if (selected) $("provider").value = selected;
  pickProvider();
  const rows = data.connections.map((c) => {
    const tr = el("tr");
    const button = el("button", "Disconnect");
    button.onclick = async () => {
      try { await api("DELETE", "/connections/" + c.provider); show(); load(); } catch (e) { show(e); }
    };
    const td = el("td");
    td.append(button);
    tr.append(el("td", c.provider), el("td", c.account), el("td", when(c.connectedAt)), td);
    return tr;
  });
  if (!rows.length) rows.push(emptyRow("No connections yet."));
  $("connections").replaceChildren(...rows);
}

function pickProvider() {
  const p = providers.find((p) => p.name === $("provider").value);
  $("account").hidden = !p?.account;
  $("account").required = !!p?.account;
  $("account").placeholder = p?.account ?? "";
}

async function load() {
  try { await Promise.all([loadApprovals(), loadConnections()]); } catch (e) { show(e); }
}

$("provider").onchange = pickProvider;
$("connect").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("PUT", "/connections/" + $("provider").value, { token: $("token").value, account: $("account").value });
    $("token").value = "";
    show();
    load();
  } catch (e) { show(e); }
};
load();
// New calls can arrive at any time; look again while the page is open.
setInterval(() => { if (!document.hidden) loadApprovals().catch(show); }, 10000);
</script>
</body>
</html>
`
