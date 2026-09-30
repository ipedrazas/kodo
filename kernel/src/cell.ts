import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { CELL_HEADER, sha256Hex, text } from "./http";

// What a gadget may implement. `fetch` serves HTTP; the WebSocket handlers
// are optional and receive the sockets the cell holds on the gadget's behalf.
interface Gadget {
  fetch(request: Request): Promise<Response>;
  onMessage(socket: string, message: string | ArrayBuffer): Promise<string | ArrayBuffer | undefined>;
  onClose(socket: string, code: number, reason: string): Promise<void>;
}

interface SocketAttachment {
  cell: string;
  socket: string;
}

// A failed gadget call, with the HTTP status that reports it.
class GadgetError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const TIMED_OUT = Symbol("timed out");
// Close code for a socket whose message the gadget failed to handle. 1011
// would be the standard code, but celld 0.6.0 delivers it to the client as
// 1006, so the kernel uses one from the application range.
export const CLOSE_GADGET_FAILED = 4011;

// One cell per gadget instance. The cell reads its manifest, loads the
// gadget's bundle by digest, and runs the gadget as a facet with its own
// SQLite database, no bindings and no network. Every call into the gadget is
// bounded in time. The cell holds WebSockets itself, because a facet cannot,
// and passes their messages to the gadget as calls.
export class Cell extends DurableObject<Env> {
  private gadget?: Gadget;

  async fetch(request: Request): Promise<Response> {
    const cell = request.headers.get(CELL_HEADER);
    if (!cell) return text(400, "request did not come through the kernel router");
    try {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        await this.load(cell);
        return this.acceptSocket(cell);
      }
      const forwarded = new Request(request);
      forwarded.headers.delete(CELL_HEADER);
      return await this.call(cell, (gadget) => gadget.fetch(forwarded));
    } catch (err) {
      if (err instanceof GadgetError) return text(err.status, err.message);
      throw err;
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { cell, socket } = ws.deserializeAttachment() as SocketAttachment;
    try {
      const reply = await this.call(cell, (gadget) => gadget.onMessage(socket, message));
      if (typeof reply === "string" || reply instanceof ArrayBuffer) ws.send(reply);
    } catch (err) {
      ws.close(CLOSE_GADGET_FAILED, err instanceof GadgetError ? err.message.slice(0, 120) : "gadget failed");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const { cell, socket } = ws.deserializeAttachment() as SocketAttachment;
    try {
      await this.call(cell, (gadget) => gadget.onClose(socket, code, reason));
    } catch {
      // A gadget without onClose, or one that fails in it, changes nothing.
    }
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private acceptSocket(cell: string): Response {
    const [server, client] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cell, socket: crypto.randomUUID() } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Loads the gadget once per activation of this cell.
  private async load(cell: string): Promise<Gadget> {
    if (this.gadget) return this.gadget;

    const manifest = await this.env.CELLS.get(`${cell}.json`);
    if (!manifest) throw new GadgetError(404, `cell ${cell} does not exist`);
    let digest: unknown;
    try {
      digest = ((await manifest.json()) as { bundle?: unknown }).bundle;
    } catch {
      throw new GadgetError(500, `cell ${cell} has an unreadable manifest`);
    }
    if (typeof digest !== "string" || !DIGEST.test(digest)) {
      throw new GadgetError(500, `cell ${cell} manifest has no valid bundle digest`);
    }

    const bundle = await this.env.BUNDLES.get(`sha256/${digest}.js`);
    if (!bundle) throw new GadgetError(502, `bundle ${digest} not found`);
    const bytes = await bundle.arrayBuffer();
    if ((await sha256Hex(bytes)) !== digest) {
      throw new GadgetError(502, `bundle ${digest} does not match its digest`);
    }
    const source = new TextDecoder().decode(bytes);

    const worker = this.env.LOADER.get(digest, () => ({
      compatibilityDate: "2026-09-01",
      mainModule: "gadget.js",
      modules: { "gadget.js": source },
      env: {},
      globalOutbound: null,
      limits: { cpuMs: Number(this.env.GADGET_CPU_MS) || 5000 },
    }));
    const facet = this.ctx.facets.get("gadget", () => ({
      class: worker.getDurableObjectClass("App"),
    }));
    this.gadget = facet as unknown as Gadget;
    return this.gadget;
  }

  // Runs one call into the gadget. A call that throws becomes a 502; a call
  // that has not answered in time aborts the facet, so the next call starts
  // it afresh, and becomes a 504.
  private async call<T>(cell: string, fn: (gadget: Gadget) => Promise<T>): Promise<T> {
    const gadget = await this.load(cell);
    const limit = Number(this.env.GADGET_CALL_TIMEOUT_MS) || 30_000;
    let timer: number | null = null;
    const pending = Promise.resolve().then(() => fn(gadget));
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), limit);
    });
    try {
      const result = await Promise.race([pending, timeout]);
      if (result === TIMED_OUT) {
        pending.catch(() => {});
        this.ctx.facets.abort("gadget", new Error("gadget call timed out"));
        this.gadget = undefined;
        throw new GadgetError(504, `gadget did not answer within ${limit} ms`);
      }
      return result;
    } catch (err) {
      if (err instanceof GadgetError) throw err;
      throw new GadgetError(502, `gadget failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
