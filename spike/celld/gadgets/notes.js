import { DurableObject } from "cloudflare:workers";

// Sample gadget: counts visits in its own SQLite database and reports what
// authority it can see, so the spike can check it has none.
export class App extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);

    let outbound = "not attempted";
    if (url.searchParams.has("probe")) {
      try {
        const res = await fetch("https://example.com/");
        outbound = `reached example.com: ${res.status}`;
      } catch (err) {
        outbound = `blocked: ${err.message}`;
      }
    }
    return Response.json({ gadget: "notes", n, bindings: Object.keys(this.env), outbound });
  }
}
