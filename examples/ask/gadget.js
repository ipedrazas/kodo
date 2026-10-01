import { Gadget } from "kodo";

// Ask: a kodo gadget that puts questions to a model and keeps the
// conversation. It holds no API key and cannot pick a provider: each model
// its owner granted, inference:model/<name>:invoke, arrives as a binding in
// this.grants, and the Gatekeeper sends the call to the platform's inference
// gateway, which decides which backend answers and counts the tokens against
// the owner's and the workspace's budgets. The conversation lives in the
// cell's own SQLite database.
//
//   GET    /             the page
//   GET    /api/chat     {models, messages}: the granted models and the conversation
//   POST   /api/chat     {prompt, model?}: ask; model defaults to the first granted
//   DELETE /api/chat     forget the conversation
const MODEL = /^inference:model\/([^:]+):invoke$/;
// How many earlier messages go with each question.
const CONTEXT = 10;

export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL,
      model TEXT, backend TEXT, input INTEGER, output INTEGER, asked_by TEXT, at INTEGER NOT NULL)`);
  }

  // The granted models by name, e.g. {default: <binding>}.
  get models() {
    return Object.fromEntries(
      Object.entries(this.grants).flatMap(([c, grant]) => (MODEL.test(c) ? [[MODEL.exec(c)[1], grant]] : [])),
    );
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        },
      });
    }
    if (pathname !== "/api/chat") return Response.json({ error: "not found" }, { status: 404 });
    if (request.method === "GET") return Response.json({ models: Object.keys(this.models), messages: this.messages() });
    if (request.method === "DELETE") {
      this.ctx.storage.sql.exec("DELETE FROM messages");
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST") return this.ask(request);
    return Response.json({ error: "not found" }, { status: 404 });
  }

  async ask(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "body must be {prompt, model?}" }, { status: 400 });
    }
    const prompt = String(body?.prompt ?? "").trim();
    if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });
    const models = this.models;
    const model = body.model ?? Object.keys(models)[0];
    const grant = models[model];
    if (!grant) {
      return Response.json({ error: model ? `no grant for inference:model/${model}:invoke` : "no model is granted" }, { status: 403 });
    }

    const history = this.messages().slice(-CONTEXT).map(({ role, content }) => ({ role, content }));
    const res = await grant.fetch("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [...history, { role: "user", content: prompt }], max_tokens: 256 }),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 429: the owner or the workspace is over budget; 403: outside the grant.
      return Response.json({ error: answer.error?.message ?? answer.error ?? `the model answered ${res.status}` }, { status: res.status });
    }
    const content = answer.choices?.[0]?.message?.content ?? "";
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("INSERT INTO messages (role, content, asked_by, at) VALUES ('user', ?, ?, ?)", prompt, request.headers.get("x-kodo-email"), now);
    sql.exec(
      "INSERT INTO messages (role, content, model, backend, input, output, at) VALUES ('assistant', ?, ?, ?, ?, ?, ?)",
      content, model, answer.model ?? null, answer.usage?.prompt_tokens ?? null, answer.usage?.completion_tokens ?? null, now,
    );
    return Response.json(this.messages().at(-1));
  }

  messages() {
    return this.ctx.storage.sql.exec("SELECT * FROM messages ORDER BY id DESC LIMIT 100").toArray().reverse().map((m) => ({
      role: m.role,
      content: m.content,
      model: m.model,
      // The backend's name for the model that answered.
      backend: m.backend,
      tokens: m.role === "assistant" ? { input: m.input, output: m.output } : undefined,
      askedBy: m.asked_by,
      at: new Date(m.at).toISOString(),
    }));
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ask</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --bad: #b91c1c; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .muted { color: var(--muted); font-size: .85rem; }
  #log > div { padding: .6rem 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; }
  .user { font-weight: 600; }
  form { display: grid; grid-template-columns: 1fr auto auto; gap: .5rem; margin-top: 1rem; }
  input, select, button { font: inherit; padding: .35rem .5rem; }
  #error { color: var(--bad); min-height: 1.5em; }
</style>
</head>
<body>
<h1>Ask</h1>
<p class="muted">Questions go to the model you pick, through your platform's inference gateway, and count against your budget.</p>
<p id="error" role="alert"></p>
<div id="log" aria-live="polite"></div>
<form id="ask">
  <input id="prompt" required placeholder="Ask something" aria-label="Question" autocomplete="off">
  <select id="model" aria-label="Model"></select>
  <button>Ask</button>
</form>
<script>
const $ = (id) => document.getElementById(id);
const show = (e) => { $("error").textContent = e ? String(e.message ?? e) : ""; };
function render(messages) {
  $("log").replaceChildren(...messages.map((m) => {
    const div = Object.assign(document.createElement("div"), { textContent: m.content, className: m.role });
    if (m.role === "assistant") {
      div.append(Object.assign(document.createElement("div"), {
        className: "muted",
        textContent: m.model + (m.backend ? " (" + m.backend + ")" : "") + " · " + (m.tokens.input ?? "?") + " in, " + (m.tokens.output ?? "?") + " out",
      }));
    }
    return div;
  }));
}
async function load() {
  try {
    const { models, messages } = await (await fetch("/api/chat")).json();
    if (!models.length) show("No model is granted yet. The cell's owner grants one, e.g. inference:model/default:invoke.");
    $("model").replaceChildren(...models.map((m) => Object.assign(document.createElement("option"), { value: m, textContent: m })));
    render(messages);
  } catch (e) { show(e); }
}
$("ask").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: $("prompt").value, model: $("model").value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    $("prompt").value = "";
    show();
    await load();
  } catch (e) { show(e); } finally { button.disabled = false; }
};
load();
</script>
</body>
</html>
`;
