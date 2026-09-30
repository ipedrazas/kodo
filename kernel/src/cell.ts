import { DurableObject } from "cloudflare:workers";
import type { BlueprintVersion } from "./catalog";
import type { Env } from "./env";
import { GADGET_RUNTIME, cellProps } from "./host";
import { CELL_HEADER, sha256Hex, text } from "./http";

// What a gadget may implement. `fetch` serves HTTP; the other handlers are
// optional and are called by the cell on the gadget's behalf.
interface Gadget {
  fetch(request: Request): Promise<Response>;
  onMessage(socket: string, message: string | ArrayBuffer): Promise<string | ArrayBuffer | undefined>;
  onClose(socket: string, code: number, reason: string): Promise<void>;
  onAlarm(): Promise<void>;
}

// What a cell runs, set by its workspace.
export interface CellBinding {
  workspace: string;
  blueprint: BlueprintVersion;
}

interface SocketAttachment {
  cell: string;
  socket: string;
}

// A failed gadget call, with the HTTP status that reports it.
class GadgetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The kernel's own entrypoints, as seen through ctx.exports.
interface KernelExports {
  GadgetHost(options: { props?: unknown }): Fetcher;
}

const TIMED_OUT = Symbol("timed out");
// Close code for a socket whose message the gadget failed to handle. 1011
// would be the standard code, but celld 0.6.0 delivers it to the client as
// 1006, so the kernel uses one from the application range.
export const CLOSE_GADGET_FAILED = 4011;

// One cell per gadget instance. The cell serves only while its workspace has
// bound it to a Blueprint version. It loads that version's bundle by digest
// and runs the gadget as a facet with its own SQLite database, no network,
// and one binding, env.KODO, that acts only for this cell. Every call into
// the gadget is bounded in time. The cell holds WebSockets and alarms itself,
// because a facet can hold neither, and passes their events to the gadget as
// calls.
export class Cell extends DurableObject<Env> {
  private gadget?: Gadget;

  // Called by the workspace to create the cell or move it to another version.
  async bind(binding: CellBinding): Promise<void> {
    this.ctx.storage.kv.put("binding", binding);
    this.restart();
  }

  // Called by the workspace to delete the cell and its gadget's storage.
  async unbind(): Promise<void> {
    this.restart();
    this.ctx.facets.delete("gadget");
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "cell deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async setGadgetAlarm(when: number): Promise<void> {
    await this.ctx.storage.setAlarm(when);
  }

  async deleteGadgetAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

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

  // A gadget alarm. One that fails is logged and not retried.
  async alarm(): Promise<void> {
    const cell = this.ctx.storage.kv.get<string>("cell");
    if (!cell || !this.binding()) return;
    try {
      await this.call(cell, (gadget) => gadget.onAlarm());
    } catch (err) {
      console.log(`cell ${cell}: gadget alarm failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private acceptSocket(cell: string): Response {
    const [server, client] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cell, socket: crypto.randomUUID() } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private binding(): CellBinding | undefined {
    return this.ctx.storage.kv.get<CellBinding>("binding");
  }

  // Stops the running gadget so the next call loads the current binding.
  private restart(): void {
    if (this.gadget) this.ctx.facets.abort("gadget", new Error("gadget restarted"));
    this.gadget = undefined;
  }

  // Loads the gadget once per activation of this cell.
  private async load(cell: string): Promise<Gadget> {
    if (this.gadget) return this.gadget;

    const binding = this.binding();
    if (!binding) throw new GadgetError(404, `cell ${cell} does not exist`);
    // Remembered so an alarm, which has no request, knows the cell id.
    if (this.ctx.storage.kv.get("cell") !== cell) this.ctx.storage.kv.put("cell", cell);
    const digest = binding.blueprint.bundle;

    const bundle = await this.env.BUNDLES.get(`sha256/${digest}.js`);
    if (!bundle) throw new GadgetError(502, `bundle ${digest} not found`);
    const bytes = await bundle.arrayBuffer();
    if ((await sha256Hex(bytes)) !== digest) {
      throw new GadgetError(502, `bundle ${digest} does not match its digest`);
    }
    const source = new TextDecoder().decode(bytes);

    // The loaded Worker is shared by every cell running this bundle on this
    // node, so its env holds only the host binding; the per-cell identity
    // travels in the facet's props.
    const worker = this.env.LOADER.get(digest, () => ({
      compatibilityDate: "2026-09-01",
      mainModule: "gadget.js",
      modules: { "gadget.js": source, kodo: GADGET_RUNTIME },
      env: { KODO: (this.ctx.exports as unknown as KernelExports).GadgetHost({}) },
      globalOutbound: null,
      limits: { cpuMs: Number(this.env.GADGET_CPU_MS) || 5000 },
    }));
    const props = await cellProps(this.env, cell);
    const facet = this.ctx.facets.get("gadget", () => ({
      class: worker.getDurableObjectClass("App", { props }),
    }));
    this.gadget = facet as unknown as Gadget;
    return this.gadget;
  }

  // Runs one call into the gadget. A call that throws becomes a 502; a call
  // that has not answered in time restarts the gadget, so the next call
  // starts it afresh, and becomes a 504.
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
        this.restart();
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
