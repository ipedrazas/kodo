import { Gadget } from "kodo";

// Chat: a kodo gadget for a room of people, one room per cell, whose members
// are the people the cell is shared with as editors. Lines live in the cell's
// own database; the cell holds everyone's WebSocket, and the gadget sends
// each new line to all of them, so nobody polls.
//
//   GET  /            the page
//   GET  /api/lines   {lines, online}: the last lines and who is connected
//   POST /api/lines   {text}: say something without a socket; sent to everyone
//
// On the socket the page sends {text}; it gets {type: "hello", you, lines,
// online} when it connects, then {type: "line", line} for each new line and
// {type: "online", online} when someone comes or goes. "ping" is answered
// "pong" by the kernel.
const HISTORY = 50;
const MAX_TEXT = 2000;

export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'self'; connect-src 'self' wss://${url.host}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'`,
        },
      });
    }
    if (url.pathname !== "/api/lines") return Response.json({ error: "not found" }, { status: 404 });
    if (request.method === "GET") return Response.json({ lines: this.recent(), online: await this.online() });
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const line = this.add(request.headers.get("x-kodo-email"), body.text);
      if (!line) return Response.json({ error: `text must be 1 to ${MAX_TEXT} characters` }, { status: 400 });
      await this.broadcast(JSON.stringify({ type: "line", line }));
      return Response.json(line, { status: 201 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  async onOpen(socket, caller) {
    const online = await this.online();
    await this.send(socket, JSON.stringify({ type: "hello", you: caller.email, lines: this.recent(), online }));
    await this.broadcast(JSON.stringify({ type: "online", online }), { except: socket });
  }

  async onMessage(socket, message, caller) {
    let text;
    try {
      text = JSON.parse(String(message)).text;
    } catch {
      return JSON.stringify({ type: "error", error: "send {text}" });
    }
    const line = this.add(caller.email, text);
    if (!line) return JSON.stringify({ type: "error", error: `text must be 1 to ${MAX_TEXT} characters` });
    await this.broadcast(JSON.stringify({ type: "line", line }));
  }

  async onClose() {
    await this.broadcast(JSON.stringify({ type: "online", online: await this.online() }));
  }

  // Adds a line and returns it, or null if the text is empty or too long.
  add(email, text) {
    text = typeof text === "string" ? text.trim() : "";
    if (!text || text.length > MAX_TEXT) return null;
    const at = Date.now();
    const { id } = this.ctx.storage.sql
      .exec("INSERT INTO lines (email, text, at) VALUES (?, ?, ?) RETURNING id", email, text, at)
      .one();
    return { id, email, text, at };
  }

  recent() {
    return this.ctx.storage.sql.exec("SELECT * FROM lines ORDER BY id DESC LIMIT ?", HISTORY).toArray().reverse();
  }

  // Who has the room open, once each.
  async online() {
    return [...new Set((await this.sockets()).map((s) => s.email))].sort();
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --bad: #b91c1c; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .muted { color: var(--muted); font-size: .85rem; }
  #log { border-top: 1px solid var(--line); margin-top: 1rem; max-height: 60vh; overflow-y: auto; }
  #log > div { padding: .4rem 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
  .who { font-weight: 600; margin-right: .5rem; }
  form { display: grid; grid-template-columns: 1fr auto; gap: .5rem; margin-top: 1rem; }
  input, button { font: inherit; padding: .35rem .5rem; }
  #status.bad { color: var(--bad); }
</style>
</head>
<body>
<h1>Chat</h1>
<p class="muted"><span id="status">Connecting…</span> <span id="online"></span></p>
<div id="log" aria-live="polite"></div>
<form id="say">
  <input id="text" required maxlength="2000" placeholder="Say something" aria-label="Message" autocomplete="off">
  <button>Send</button>
</form>
<script>
const $ = (id) => document.getElementById(id);
const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
let ws, you = "", retry = 1000, pinger;
const seen = new Set();
function status(text, bad) { $("status").textContent = text; $("status").className = bad ? "bad" : ""; }
function add(line) {
  if (seen.has(line.id)) return;
  seen.add(line.id);
  const log = $("log");
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  const div = document.createElement("div");
  div.append(
    Object.assign(document.createElement("span"), { className: "who", textContent: line.email === you ? "you" : line.email }),
    document.createTextNode(line.text + " "),
    Object.assign(document.createElement("span"), { className: "muted", textContent: time(line.at) }),
  );
  log.append(div);
  if (atEnd) log.scrollTop = log.scrollHeight;
}
function connect() {
  ws = new WebSocket("wss://" + location.host + "/");
  // An upgrade that is never answered is given up and tried again.
  const opening = setTimeout(() => ws.readyState === 0 && ws.close(), 10000);
  ws.onopen = () => {
    clearTimeout(opening);
    retry = 1000;
    status("Connected.");
    // Keeps the socket open through proxies that close quiet connections.
    pinger = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
  };
  ws.onmessage = (event) => {
    if (event.data === "pong") return;
    const m = JSON.parse(event.data);
    if (m.type === "hello") { you = m.you; m.lines.forEach(add); }
    if (m.type === "line") add(m.line);
    if (m.online) $("online").textContent = "Here: " + m.online.map((e) => e === you ? "you" : e).join(", ");
    if (m.type === "error") status(m.error, true);
  };
  ws.onclose = () => {
    clearInterval(pinger);
    status("Disconnected; reconnecting…", true);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  };
}
$("say").onsubmit = (event) => {
  event.preventDefault();
  if (ws.readyState !== 1) return status("Not connected yet.", true);
  ws.send(JSON.stringify({ text: $("text").value }));
  $("text").value = "";
};
connect();
</script>
</body>
</html>
`;
