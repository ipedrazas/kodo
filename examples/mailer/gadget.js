import { Gadget } from "kodo";

// Mailer: a kodo gadget that drafts emails and sends them through its owner's
// email connection, each only after the owner approves it. It never sees the
// owner's API key or chooses the sender: the grant email:outbox:send arrives
// as a binding in this.grants, a send on it waits in the Gatekeeper's
// approval queue, and the cell calls onApproval() when the owner approves or
// rejects it. The outbox lives in the cell's own SQLite database, so it
// survives hibernation while a draft waits.
//
//   GET  /                     the page
//   GET  /api/outbox           drafts, newest first, with their state
//   POST /api/outbox           {to, subject, text}: send a draft for approval
//   GET  /api/outbox/:id       one draft; ?check=1 asks the Gatekeeper now
const SEND = "email:outbox:send";

export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, recipients TEXT NOT NULL, subject TEXT NOT NULL, drafted_by TEXT,
      state TEXT NOT NULL, reason TEXT, status INTEGER, response TEXT,
      queued_at INTEGER NOT NULL, settled_at INTEGER, notified INTEGER NOT NULL DEFAULT 0)`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && parts.length === 0) {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        },
      });
    }
    if (parts[0] !== "api" || parts[1] !== "outbox" || parts.length > 3) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (parts.length === 2 && request.method === "GET") {
      return Response.json({ granted: Boolean(this.grants[SEND]), outbox: this.outbox() });
    }
    if (parts.length === 2 && request.method === "POST") return this.draft(request);
    if (parts.length === 3 && request.method === "GET") {
      if (url.searchParams.get("check")) await this.check(parts[2]);
      const [entry] = this.outbox(parts[2]);
      return entry ? Response.json(entry) : Response.json({ error: "no such draft" }, { status: 404 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Sends a draft to the approval queue. The Gatekeeper answers at once: 202
  // with the approval's id, or a denial.
  async draft(request) {
    const grant = this.grants[SEND];
    if (!grant) return Response.json({ error: `this cell has no grant for ${SEND}` }, { status: 403 });
    let draft;
    try {
      draft = await request.json();
    } catch {
      return Response.json({ error: "body must be {to, subject, text}" }, { status: 400 });
    }
    const { to, subject, text } = draft ?? {};
    const res = await grant.fetch("", { method: "POST", body: JSON.stringify({ to, subject, text }) });
    if (res.status !== 202) {
      const error = await res.json().catch(() => ({}));
      return Response.json({ error: error.error ?? error.message ?? `the send answered ${res.status}` }, { status: res.status });
    }
    const id = res.headers.get("x-kodo-approval");
    const recipients = Array.isArray(to) ? to.join(", ") : String(to);
    this.ctx.storage.sql.exec(
      "INSERT INTO outbox (id, recipients, subject, drafted_by, state, queued_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      id, recipients, String(subject), request.headers.get("x-kodo-email"), Date.now(),
    );
    return Response.json(this.outbox(id)[0], { status: 202 });
  }

  // The cell calls this once when an approval this cell is waiting on settles.
  async onApproval(approval) {
    await this.settle(approval, true);
  }

  // Asks the Gatekeeper about one draft now, instead of waiting for the cell.
  async check(id) {
    const [entry] = this.outbox(id);
    if (entry?.state === "pending" || entry?.state === "executing") await this.settle(await this.approval(id), false);
  }

  async settle(approval, notified) {
    const response = approval.response ? await approval.response.text() : null;
    this.ctx.storage.sql.exec(
      `UPDATE outbox SET state = ?, reason = ?, status = ?, response = ?,
         settled_at = CASE WHEN ? IN ('pending', 'executing') THEN NULL ELSE ? END,
         notified = notified OR ? WHERE id = ?`,
      approval.state, approval.reason, approval.response?.status ?? null, response,
      approval.state, Date.now(), notified ? 1 : 0, approval.id,
    );
  }

  outbox(id) {
    const rows = id
      ? this.ctx.storage.sql.exec("SELECT * FROM outbox WHERE id = ?", id).toArray()
      : this.ctx.storage.sql.exec("SELECT * FROM outbox ORDER BY queued_at DESC LIMIT 100").toArray();
    return rows.map((r) => ({
      id: r.id,
      to: r.recipients,
      subject: r.subject,
      draftedBy: r.drafted_by,
      state: r.state,
      reason: r.reason,
      status: r.status,
      response: r.response,
      queuedAt: new Date(r.queued_at).toISOString(),
      settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
      // Whether the cell told the gadget, as opposed to a check.
      notified: Boolean(r.notified),
    }));
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mailer</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --ok: #15803d; --bad: #b91c1c; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  .muted { color: var(--muted); }
  form { display: grid; gap: .5rem; }
  input, textarea, button { font: inherit; padding: .35rem .5rem; }
  textarea { min-height: 8rem; }
  button { justify-self: start; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  .done { color: var(--ok); }
  .failed, .rejected, .expired { color: var(--bad); }
  #error { color: var(--bad); min-height: 1.5em; }
</style>
</head>
<body>
<h1>Mailer</h1>
<p class="muted">Drafts go to your approval queue. Nothing is sent until you approve it at <a id="approvals" target="_blank" rel="noopener">your approvals</a>, and it is sent from the address you connected there.</p>
<p id="error" role="alert"></p>
<form id="draft">
  <input id="to" type="email" multiple required placeholder="To (comma-separated)" aria-label="To">
  <input id="subject" required maxlength="200" placeholder="Subject" aria-label="Subject">
  <textarea id="text" required placeholder="Message" aria-label="Message"></textarea>
  <button>Send for approval</button>
</form>
<h2>Outbox</h2>
<table>
  <thead><tr><th>Queued</th><th>To</th><th>Subject</th><th>State</th></tr></thead>
  <tbody id="outbox"></tbody>
</table>
<script>
const $ = (id) => document.getElementById(id);
const show = (e) => { $("error").textContent = e ? String(e.message ?? e) : ""; };
$("approvals").href = "https://" + location.hostname.replace(/^[^.]+\\.g\\./, "app.") + "/gatekeeper/";
const td = (text, className) => Object.assign(document.createElement("td"), { textContent: text, className: className ?? "" });
let timer;

async function load() {
  clearTimeout(timer);
  try {
    const { granted, outbox } = await (await fetch("/api/outbox")).json();
    if (!granted) show("This cell has no grant for email:outbox:send yet. Its owner grants it with PUT /api/workspaces/<ws>/cells/<cell>/grants.");
    $("outbox").replaceChildren(...outbox.map((m) => {
      const tr = document.createElement("tr");
      let state = m.state;
      if (m.state === "done") state = m.status >= 200 && m.status < 300 ? "sent" : "provider answered " + m.status;
      const cell = td(state, m.state);
      if (m.reason) cell.append(Object.assign(document.createElement("div"), { textContent: m.reason, className: "muted" }));
      tr.append(td(new Date(m.queuedAt).toLocaleString()), td(m.to), td(m.subject), cell);
      return tr;
    }));
    // Look again while anything waits; the cell updates the outbox when the owner decides.
    if (outbox.some((m) => m.state === "pending" || m.state === "executing")) timer = setTimeout(load, 3000);
  } catch (e) { show(e); }
}

$("draft").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const res = await fetch("/api/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: $("to").value.split(",").map((s) => s.trim()).filter(Boolean), subject: $("subject").value, text: $("text").value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    $("draft").reset();
    show();
    load();
  } catch (e) { show(e); }
};
load();
</script>
</body>
</html>
`;
