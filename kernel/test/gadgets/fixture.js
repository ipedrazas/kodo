import { DurableObject } from "cloudflare:workers";

// Test gadget. Counts requests in its own SQLite database and misbehaves on
// request:
//   ?hang    never answers
//   ?throw   throws
//   ?spin    busy-loops for 20 s of CPU
//   ?probe   reports its bindings and whether outbound fetch works
// WebSocket messages are echoed with a count of messages seen.
export class App extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.has("hang")) await new Promise(() => {});
    if (url.searchParams.has("throw")) throw new Error("fixture failure");
    if (url.searchParams.has("spin")) {
      const end = Date.now() + 20_000;
      while (Date.now() < end);
    }
    if (url.searchParams.has("probe")) {
      let outbound;
      try {
        await fetch("https://example.com/");
        outbound = "allowed";
      } catch {
        outbound = "blocked";
      }
      return Response.json({ bindings: Object.keys(this.env), outbound });
    }
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return Response.json({ n, cell: request.headers.get("x-kodo-cell") });
  }

  onMessage(socket, message) {
    const n = (this.ctx.storage.kv.get("messages") ?? 0) + 1;
    this.ctx.storage.kv.put("messages", n);
    return JSON.stringify({ n, echo: String(message) });
  }
}
