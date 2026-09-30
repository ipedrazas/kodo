import { Gadget } from "kodo";

// Sample gadget that uses the whole gadget API: HTTP, its own SQLite
// database, WebSocket messages, and alarms. See GADGETS.md.
//
//   GET  /              the notes, newest first
//   POST /              add the request body as a note
//   POST /remind?in=MS  fire a reminder in MS milliseconds
//   GET  /status        notes, reminders fired, sockets closed
//   WebSocket message   add the message as a note; the reply is the count
export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)",
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/") {
      this.add(await request.text());
      return new Response(null, { status: 201 });
    }
    if (request.method === "POST" && url.pathname === "/remind") {
      const delay = Number(url.searchParams.get("in") ?? 1000);
      await this.setAlarm(Date.now() + delay);
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/status") {
      return Response.json({
        cell: this.cellId,
        notes: this.count(),
        reminders: this.ctx.storage.kv.get("reminders") ?? 0,
        closed: this.ctx.storage.kv.get("closed") ?? 0,
      });
    }
    const notes = this.ctx.storage.sql.exec("SELECT body FROM notes ORDER BY id DESC").toArray();
    return Response.json(notes.map((n) => n.body));
  }

  onMessage(socket, message) {
    this.add(String(message));
    return JSON.stringify({ notes: this.count() });
  }

  onClose() {
    this.ctx.storage.kv.put("closed", (this.ctx.storage.kv.get("closed") ?? 0) + 1);
  }

  onAlarm() {
    this.ctx.storage.kv.put("reminders", (this.ctx.storage.kv.get("reminders") ?? 0) + 1);
  }

  add(body) {
    this.ctx.storage.sql.exec("INSERT INTO notes (body, at) VALUES (?, ?)", body, Date.now());
  }

  count() {
    return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM notes").one().n;
  }
}
