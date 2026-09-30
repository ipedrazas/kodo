import { DurableObject } from "cloudflare:workers";

// Baseline: a plain Durable Object, used for the durability and failover runs.
export class Counter extends DurableObject {
  async fetch() {
    let n = (await this.ctx.storage.get("n")) ?? 0;
    n++;
    await this.ctx.storage.put("n", n);
    return Response.json({ n });
  }
}

// A gadget cell. The gadget code is not part of this deployment: the cell
// fetches the bundle from object storage by digest and runs its App class as a
// facet with its own SQLite database, no bindings and no outbound network.
export class Cell extends DurableObject {
  async fetch(request) {
    // TRACE lines let a hung request be traced to the step it stopped at.
    const url = new URL(request.url);
    const trace = (step) => console.log(`TRACE ${url.pathname} ${step}`);
    trace("start");
    const digest = url.searchParams.get("bundle") ?? (await this.ctx.storage.get("bundle"));
    if (!digest) return new Response("no bundle bound to this cell\n", { status: 404 });
    await this.ctx.storage.put("bundle", digest);
    trace("stored");

    const code = async () => {
      trace("load");
      const object = await this.env.BUNDLES.get(`sha256/${digest}.js`);
      if (!object) throw new Error(`bundle ${digest} not found`);
      const source = await object.text();
      trace("loaded");
      return {
        compatibilityDate: "2026-01-01",
        mainModule: "gadget.js",
        modules: { "gadget.js": source },
        env: {},
        globalOutbound: null,
      };
    };

    // Workaround under test for the Phase 0 hang: a facet call that has not
    // answered in HANG_MS is aborted and retried, first with the memoized
    // loader, then with a freshly loaded Worker.
    // LOADER.get() keeps every distinct bundle loaded for the life of the host
    // isolate, which exhausted a node after about 100 bundles; KERNEL_LOAD=load
    // uses LOADER.load(), whose Worker can be collected once the facet stops.
    // With load(), one Worker is kept per resident cell and dropped with it.
    const fresh = async () => this.env.LOADER.load(await code());
    const attempts = this.env.KERNEL_LOAD === "load"
      ? [async () => (this.worker ??= await fresh()), fresh]
      : [() => this.env.LOADER.get(digest, code), fresh];
    for (let i = 0; ; i++) {
      const worker = await attempts[Math.min(i, attempts.length - 1)]();
      const facet = this.ctx.facets.get("gadget", () => ({
        class: worker.getDurableObjectClass("App"),
      }));
      trace(i === 0 ? "facet" : `facet-retry-${i}`);
      const response = await withTimeout(facet.fetch(request.clone()), HANG_MS);
      if (response) {
        trace(i === 0 ? "done" : `done-retry-${i}`);
        return response;
      }
      trace(`hung-${i}`);
      this.ctx.facets.abort("gadget", new Error("gadget call hung"));
      if (i === attempts.length) return new Response("gadget unavailable\n", { status: 503 });
    }
  }
}

const HANG_MS = 10_000;

// Resolves to the promise's value, or to undefined if it takes longer than ms.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Control for the hang: the same gadget code, compiled into this deployment
// instead of loaded at runtime, run as a facet of an XCell.
export class LocalApp extends DurableObject {
  async fetch() {
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return Response.json({ gadget: "local", n });
  }
}

export class LocalWs extends DurableObject {
  fetch(request) {
    return WsEcho.prototype.fetch.call(this, request);
  }

  webSocketMessage(ws, message) {
    return WsEcho.prototype.webSocketMessage.call(this, ws, message);
  }
}

export class XCell extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    console.log(`TRACE ${url.pathname} facet`);
    const ws = request.headers.get("Upgrade") === "websocket";
    const facet = ws
      ? this.ctx.facets.get("ws", () => ({ class: this.ctx.exports.LocalWs }))
      : this.ctx.facets.get("gadget", () => ({ class: this.ctx.exports.LocalApp }));
    const response = await facet.fetch(request);
    console.log(`TRACE ${url.pathname} done`);
    return response;
  }
}

// Control for WebSockets: the echo gadget's logic as a plain Durable Object.
export class WsEcho extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade\n", { status: 426 });
    }
    const [server, client] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    ws.send(JSON.stringify({ n, echo: String(message) }));
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const [, kind, name] = url.pathname.split("/");
    if (kind === "counter" && name) return env.COUNTER.getByName(name).fetch(request);
    if (kind === "cell" && name) return env.CELL.getByName(name).fetch(request);
    if (kind === "xcell" && name) return env.XCELL.getByName(name).fetch(request);
    if (kind === "wsecho" && name) return env.WSECHO.getByName(name).fetch(request);
    return new Response("not found\n", { status: 404 });
  },
};
