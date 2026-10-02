# Writing a kodo gadget

A gadget is a small web app. Each instance (a "cell") runs in its own sandbox with its own SQLite database, and is served at its own origin, `https://<cell-id>.g.<domain>/`. You write it as one JavaScript module and submit it with `write_gadget`. It becomes a **draft**: only the user can try it until they publish it, and they grant it capabilities themselves.

## The module

Export a class named `App` that extends `Gadget` from the `"kodo"` module. Write plain modern JavaScript: no TypeScript, no other imports, no npm packages, no build step. Put the page's HTML, CSS and browser JavaScript in strings inside the module.

```js
import { Gadget } from "kodo";

export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, author TEXT, at INTEGER NOT NULL)`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const who = request.headers.get("x-kodo-email");
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/notes" && request.method === "GET") {
      return Response.json(this.ctx.storage.sql.exec("SELECT * FROM notes ORDER BY id").toArray());
    }
    if (url.pathname === "/api/notes" && request.method === "POST") {
      const { text } = await request.json();
      if (!text) return Response.json({ error: "text is required" }, { status: 400 });
      this.ctx.storage.sql.exec("INSERT INTO notes (text, author, at) VALUES (?, ?, ?)", text, who, Date.now());
      return Response.json({ ok: true }, { status: 201 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes</title>
<style>body { font: 15px system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }</style>
</head><body>
<h1>Notes</h1>
<form id="f"><input id="t" required> <button>Add</button></form>
<ul id="list"></ul>
<script>
const list = document.getElementById("list");
async function load() {
  const notes = await (await fetch("/api/notes")).json();
  list.replaceChildren(...notes.map((n) => Object.assign(document.createElement("li"), { textContent: n.text })));
}
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: document.getElementById("t").value }) });
  document.getElementById("t").value = "";
  load();
};
load();
</script></body></html>`;
```

Inside the page string, a browser-side template literal needs its backticks and `${` escaped (`\``, `\${`); string concatenation is simpler. Put text into the page with `textContent`, never `innerHTML` with user data.

## What the gadget can use

- `fetch(request)`: every HTTP request to the cell, already authenticated. Required.
- Headers on each request: `x-kodo-user` (a stable id), `x-kodo-email`, `x-kodo-role` (`owner`, `editor` or `viewer`) and `x-kodo-workspace`.
- `this.ctx.storage.sql.exec(query, ...params)`: the cell's SQLite database; `.toArray()` and `.one()` on the result. `this.ctx.storage.kv.get(key)` and `.put(key, value)` for simple values. Create tables in the constructor with `IF NOT EXISTS`. Data survives restarts and new versions, so a new version must read what the old one wrote.
- `this.grants[capability].fetch(path, {method, headers, body})`: a call through a capability the owner granted, returning a `Response`. A capability not granted has no entry: check for it and say on the page that the owner must grant it.
- `this.setAlarm(dateOrMs)` and `onAlarm()`: one scheduled wake-up.
- WebSockets: the browser opens `new WebSocket("wss://" + location.host + "/")`; the gadget's `onMessage(socket, message, caller)` receives each message and may return a string to send back on the same socket. It cannot push unprompted.

## What it cannot do

- Reach the network directly: `fetch()` to anything outside throws. Only `this.grants` reaches out.
- See tokens or cookies of the login.
- Accept writes from other origins: the page must call its own `/api/...` with relative URLs.
- Run long: each request must answer within 30 s and 5 s of CPU.
- Load external scripts, fonts or images from other sites.

A viewer can only send GET requests; owners and editors can do anything.

## Capabilities

Declare in `write_gadget` every capability the gadget calls, as `<provider>:<resource>:<verb>`, using `*` for one path segment the owner will choose (for example `github:repo/*/*:read`). The owner grants concrete ones. Providers:

| Capability | Calls |
| --- | --- |
| `web:<host>[/<path>]:read` | GET on a public API, e.g. `web:hn.algolia.com/api/v1:read`; only hosts the platform allows. |
| `github:repo/<owner>/<repo>:read` | GET on `https://api.github.com/repos/<owner>/<repo>/...` with the owner's GitHub access. |
| `email:outbox:send` | POST `""` with `{to, subject, text}`; answers 202 and waits for the owner's approval. Define `onApproval(approval)` to hear the outcome. |
| `inference:model/<name>:invoke` | POST `/chat/completions` with `{messages, max_tokens}`; within 20 s. |

## Submitting

Call `write_gadget` with a short lowercase `name` (letters, digits, hyphens), the whole `source`, and `capabilities`. The answer says whether the kernel could load it and what `GET /` returned; if it failed, fix it and submit again under the same name, which makes a new version. Then tell the user it is a draft they can try, publish, and grant capabilities to from the chat.
