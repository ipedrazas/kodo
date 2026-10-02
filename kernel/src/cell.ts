import { DurableObject } from "cloudflare:workers";
import type { BlueprintVersion } from "./catalog";
import type { Env } from "./env";
import {
  type ApprovalStatus,
  GADGET_RUNTIME,
  SETTLED,
  type TokenUsage,
  cellProps,
  fromApprovals,
  gatekeeper,
} from "./host";
import { CALLER_HEADER, CELL_HEADER, sha256Hex, text } from "./http";
import type { Caller } from "./identity";
import type { Owner, ShareRole } from "./workspace";

// What a gadget may implement. `fetch` serves HTTP; the other handlers are
// optional and are called by the cell on the gadget's behalf.
interface Gadget {
  fetch(request: Request): Promise<Response>;
  onMessage(socket: string, message: string | ArrayBuffer, caller: GadgetCaller): Promise<string | ArrayBuffer | undefined>;
  onClose(socket: string, code: number, reason: string): Promise<void>;
  onAlarm(): Promise<void>;
  // Defined by the gadget runtime; calls the gadget's onApproval.
  __kodoApprovalSettled(status: ApprovalStatus): Promise<void>;
  // Defined by the gadget runtime: the size of the gadget's database.
  __kodoStorageBytes(): Promise<number>;
}

// Tokens used through one granted model.
export interface ModelUsage {
  calls: number;
  input: number;
  output: number;
  total: number;
}

// What a cell did in one calendar month (UTC).
export interface MonthUsage {
  // HTTP requests and WebSocket messages that reached the gadget.
  requests: number;
  // When the last of them arrived, in epoch milliseconds.
  lastActive: number | null;
  // Model calls by the granted model's name, e.g. "fast" for
  // inference:model/fast:invoke.
  inference: Record<string, ModelUsage>;
}

export interface CellUsage extends MonthUsage {
  month: string;
  // The gadget's database when last measured, or null if it never was (a
  // gadget that does not extend Gadget cannot be measured).
  storageBytes: number | null;
}

// What a cell runs and who may use it, set by its workspace.
export interface CellBinding {
  workspace: string;
  blueprint: BlueprintVersion;
  owner: Owner;
  shares: Record<string, ShareRole>;
  // Capabilities granted to this cell; missing on cells bound before Phase 7.
  grants?: string[];
}

// What the kernel asserts to the Gatekeeper about the cell making a call.
export interface CallContext {
  workspace: string;
  blueprint: string;
  version: string;
  owner: Owner;
  grants: string[];
}

type Role = "owner" | ShareRole;

// Who is calling, as the gadget sees it: no credential, just identity.
interface GadgetCaller {
  user: string;
  email: string;
  role: Role;
}

interface SocketAttachment {
  cell: string;
  socket: string;
  caller: GadgetCaller;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

// The approvals the cell is waiting on for its gadget, and when it next asks
// the Gatekeeper about them. It asks soon after a call is queued, then less
// and less often.
interface ApprovalWatch {
  ids: string[];
  at: number;
  delay: number;
}
// Requests are counted in memory and written a few seconds later, so that a
// request does not wait for a write of its own; a cell that stops in that
// time loses them. Model calls are written at once.
const USAGE_FLUSH_MS = 5_000;
const STORAGE_MEASURE_MS = 2_000;
const APPROVAL_POLL_FIRST_MS = 2_000;
const APPROVAL_POLL_MAX_MS = 60_000;
const MAX_WATCHED_APPROVALS = 100;

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
// and one binding, env.KODO, that acts only for this cell. The gadget's
// props list the capabilities its owner granted; the gadget runtime turns
// each into a binding whose calls go through the kernel to the Gatekeeper.
// Every call into the gadget is bounded in time. The cell holds WebSockets
// and alarms itself, because a facet can hold neither, and passes their
// events to the gadget as calls.
export class Cell extends DurableObject<Env> {
  private gadget?: Gadget;
  // Usage not yet written, by month.
  private pending = new Map<string, MonthUsage>();
  private flushing: number | null = null;

  // Called by the workspace to create the cell or move it to another version.
  async bind(binding: CellBinding): Promise<void> {
    this.ctx.storage.kv.put("binding", binding);
    this.restart();
  }

  // Called by the workspace when the cell's shares change.
  async setShares(shares: Record<string, ShareRole>): Promise<void> {
    const binding = this.binding();
    if (binding) this.ctx.storage.kv.put("binding", { ...binding, shares });
  }

  // Called by the workspace when the cell's grants change. The gadget restarts
  // so its bindings match the new grants.
  async setGrants(grants: string[]): Promise<void> {
    const binding = this.binding();
    if (!binding) return;
    this.ctx.storage.kv.put("binding", { ...binding, grants });
    this.restart();
  }

  // Called by the kernel's host binding before it makes a capability call
  // for this cell.
  async callContext(): Promise<CallContext | null> {
    const binding = this.binding();
    if (!binding) return null;
    return {
      workspace: binding.workspace,
      blueprint: binding.blueprint.name,
      version: binding.blueprint.version,
      owner: binding.owner,
      grants: binding.grants ?? [],
    };
  }

  // Called by the kernel's host binding with what one of this cell's model
  // calls used. Written at once, with any requests not yet written: a model
  // call takes far longer than the write, and its tokens are what budgets
  // and costs are about.
  async recordUsage(capability: string, usage: TokenUsage): Promise<void> {
    const model = modelName(capability);
    if (!model) return;
    const month = this.counting();
    const m = (month.inference[model] ??= { calls: 0, input: 0, output: 0, total: 0 });
    m.calls++;
    m.input += count(usage?.input);
    m.output += count(usage?.output);
    m.total += count(usage?.total) || count(usage?.input) + count(usage?.output);
    this.writeUsage();
  }

  // What the cell did in a month (YYYY-MM, UTC), for the workspace's usage
  // report.
  async usage(month: string): Promise<CellUsage> {
    this.writeUsage();
    const stored = this.ctx.storage.kv.get<MonthUsage>(`usage:${month}`);
    return {
      month,
      requests: stored?.requests ?? 0,
      lastActive: stored?.lastActive ?? null,
      inference: stored?.inference ?? {},
      storageBytes: this.ctx.storage.kv.get<number>("storage-bytes") ?? null,
    };
  }

  // Called by the workspace to delete the cell and its gadget's storage.
  async unbind(): Promise<void> {
    this.pending.clear();
    clearTimeout(this.flushing);
    this.flushing = null;
    this.restart();
    this.ctx.facets.delete("gadget");
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "cell deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async setGadgetAlarm(when: number): Promise<void> {
    await this.adoptAlarm();
    this.ctx.storage.kv.put("gadget-alarm", when);
    await this.schedule();
  }

  async deleteGadgetAlarm(): Promise<void> {
    await this.adoptAlarm();
    this.ctx.storage.kv.delete("gadget-alarm");
    await this.schedule();
  }

  // Called by the kernel's host binding when one of this cell's calls is
  // queued for approval. The cell asks the Gatekeeper about it until it
  // settles, then tells the gadget.
  async trackApproval(id: string): Promise<void> {
    await this.adoptAlarm();
    const watch = this.ctx.storage.kv.get<ApprovalWatch>("approvals") ?? { ids: [], at: 0, delay: 0 };
    if (!watch.ids.includes(id)) watch.ids = [...watch.ids, id].slice(-MAX_WATCHED_APPROVALS);
    const at = Date.now() + APPROVAL_POLL_FIRST_MS;
    this.ctx.storage.kv.put("approvals", { ids: watch.ids, at: watch.at && watch.at < at ? watch.at : at, delay: APPROVAL_POLL_FIRST_MS });
    await this.schedule();
  }

  // The state of some of this cell's approvals, from the Gatekeeper.
  async queryApprovals(ids: string[]): Promise<ApprovalStatus[]> {
    const binding = this.binding();
    const cell = this.ctx.storage.kv.get<string>("cell");
    if (!binding || !cell) return ids.map((id) => ({ id, state: "unknown" }));
    const res = await gatekeeper(this.env, "/v1/approvals/query", { cell, owner: binding.owner, ids });
    return fromApprovals(((await res.json()) as { approvals: Parameters<typeof fromApprovals>[0] }).approvals);
  }

  async fetch(request: Request): Promise<Response> {
    const cell = request.headers.get(CELL_HEADER);
    const callerHeader = request.headers.get(CALLER_HEADER);
    if (!cell || !callerHeader) return text(400, "request did not come through the kernel router");
    const binding = this.binding();
    if (!binding) return text(404, `cell ${cell} does not exist`);
    const caller = gadgetCaller(JSON.parse(callerHeader) as Caller, binding);
    if (!caller) return text(403, `cell ${cell} is not shared with you`);
    const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (caller.role === "viewer" && (upgrade || !READ_METHODS.has(request.method))) {
      return text(403, "viewers can only read this cell");
    }
    this.counting().requests++;
    try {
      if (upgrade) {
        await this.load(cell);
        return this.acceptSocket(cell, caller);
      }
      const headers = new Headers(request.headers);
      headers.delete(CELL_HEADER);
      headers.delete(CALLER_HEADER);
      headers.set("x-kodo-user", caller.user);
      headers.set("x-kodo-email", caller.email);
      headers.set("x-kodo-role", caller.role);
      headers.set("x-kodo-workspace", binding.workspace);
      const forwarded = new Request(request, { headers });
      return await this.call(cell, (gadget) => gadget.fetch(forwarded));
    } catch (err) {
      if (err instanceof GadgetError) return text(err.status, err.message);
      throw err;
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { cell, socket, caller } = ws.deserializeAttachment() as SocketAttachment;
    this.counting().requests++;
    try {
      const reply = await this.call(cell, (gadget) => gadget.onMessage(socket, message, caller));
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

  // The cell's one alarm serves the gadget's alarm and the approvals it is
  // waiting on. A gadget alarm that fails is logged and not retried.
  async alarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const cell = kv.get<string>("cell");
    const now = Date.now();
    if (cell && this.binding()) {
      const gadgetAt = kv.get<number>("gadget-alarm");
      // Before the cell kept its own schedule, every alarm was the gadget's.
      const gadgetDue = kv.get("schedule") ? gadgetAt !== undefined && gadgetAt <= now : true;
      if (gadgetDue) {
        kv.delete("gadget-alarm");
        try {
          await this.call(cell, (gadget) => gadget.onAlarm());
        } catch (err) {
          console.log(`cell ${cell}: gadget alarm failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      const watch = kv.get<ApprovalWatch>("approvals");
      if (watch && watch.at <= now) await this.pollApprovals(cell, watch);
    }
    await this.schedule();
  }

  // Asks the Gatekeeper about the approvals the cell is waiting on and calls
  // the gadget's onApproval once for each that has settled. A gadget that
  // fails in onApproval is not called again for that approval.
  private async pollApprovals(cell: string, watch: ApprovalWatch): Promise<void> {
    const kv = this.ctx.storage.kv;
    let settled: ApprovalStatus[] = [];
    try {
      settled = (await this.queryApprovals(watch.ids)).filter((s) => SETTLED.has(s.state));
    } catch (err) {
      console.log(`cell ${cell}: asking about approvals failed: ${err instanceof Error ? err.message : err}`);
    }
    for (const status of settled) {
      if (status.state === "unknown") {
        console.log(`cell ${cell}: the Gatekeeper does not know approval ${status.id}`);
        continue;
      }
      try {
        await this.call(cell, (gadget) => gadget.__kodoApprovalSettled(status));
      } catch (err) {
        console.log(`cell ${cell}: gadget onApproval failed for ${status.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Calls queued while this ran are in the stored watch, and asked about soon.
    const current = kv.get<ApprovalWatch>("approvals") ?? watch;
    const done = new Set(settled.map((s) => s.id));
    const ids = current.ids.filter((id) => !done.has(id));
    if (!ids.length) {
      kv.delete("approvals");
    } else if (current.at !== watch.at) {
      kv.put("approvals", { ...current, ids });
    } else {
      const delay = Math.min(watch.delay * 2, APPROVAL_POLL_MAX_MS);
      kv.put("approvals", { ids, at: Date.now() + delay, delay });
    }
  }

  // Sets the cell's alarm to the earliest of the gadget's alarm and the next
  // time to ask about approvals.
  private async schedule(): Promise<void> {
    const kv = this.ctx.storage.kv;
    kv.put("schedule", 1);
    const times = [kv.get<number>("gadget-alarm"), kv.get<ApprovalWatch>("approvals")?.at].filter(
      (t): t is number => typeof t === "number",
    );
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  // A cell from before the cell kept its own schedule holds the gadget's
  // alarm only as the native alarm; keep it as the gadget's.
  private async adoptAlarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get("schedule")) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && kv.get("gadget-alarm") === undefined) kv.put("gadget-alarm", existing);
  }

  // This month's unwritten usage, which the caller adds to. The cell writes
  // it a few seconds later and measures the gadget's database then.
  private counting(): MonthUsage {
    const now = Date.now();
    const month = new Date(now).toISOString().slice(0, 7);
    let usage = this.pending.get(month);
    if (!usage) this.pending.set(month, (usage = { requests: 0, lastActive: null, inference: {} }));
    usage.lastActive = now;
    this.flushing ??= setTimeout(() => {
      this.flushing = null;
      this.writeUsage();
      this.measureStorage().catch(() => {});
    }, USAGE_FLUSH_MS);
    return usage;
  }

  // Adds the unwritten usage to what is stored.
  private writeUsage(): void {
    const kv = this.ctx.storage.kv;
    for (const [month, add] of this.pending) {
      const key = `usage:${month}`;
      const stored = kv.get<MonthUsage>(key) ?? { requests: 0, lastActive: null, inference: {} };
      stored.requests += add.requests;
      stored.lastActive = Math.max(stored.lastActive ?? 0, add.lastActive ?? 0) || null;
      for (const [model, u] of Object.entries(add.inference)) {
        const m = (stored.inference[model] ??= { calls: 0, input: 0, output: 0, total: 0 });
        m.calls += u.calls;
        m.input += u.input;
        m.output += u.output;
        m.total += u.total;
      }
      kv.put(key, stored);
    }
    this.pending.clear();
  }

  // Records the size of the gadget's database, if the gadget is running and
  // can say. Never loads the gadget.
  private async measureStorage(): Promise<void> {
    const gadget = this.gadget;
    if (!gadget) return;
    let timer: number | null = null;
    const bytes = await Promise.race([
      gadget.__kodoStorageBytes(),
      new Promise<undefined>((resolve) => (timer = setTimeout(resolve, STORAGE_MEASURE_MS))),
    ]).finally(() => clearTimeout(timer));
    if (typeof bytes === "number" && Number.isFinite(bytes) && this.binding()) {
      this.ctx.storage.kv.put("storage-bytes", bytes);
    }
  }

  private acceptSocket(cell: string, caller: GadgetCaller): Response {
    const [server, client] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cell, socket: crypto.randomUUID(), caller } satisfies SocketAttachment);
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
    const props = await cellProps(this.env, cell, binding.grants ?? []);
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

// The model a capability names: "fast" for inference:model/fast:invoke.
function modelName(capability: string): string | null {
  const m = /^inference:model\/([^:/]+):invoke$/.exec(capability);
  return m ? m[1] : null;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// The caller's role on the cell, or null if it is not theirs and not shared
// with them. The admin token acts as the owner.
function gadgetCaller(caller: Caller, binding: CellBinding): GadgetCaller | null {
  if (caller.kind === "admin") return { user: "admin", email: "", role: "owner" };
  if (caller.user === binding.owner.user) return { user: caller.user, email: caller.email, role: "owner" };
  const shared = Object.hasOwn(binding.shares, caller.email) ? binding.shares[caller.email] : undefined;
  return shared ? { user: caller.user, email: caller.email, role: shared } : null;
}
