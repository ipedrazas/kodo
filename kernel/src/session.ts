import { DurableObject } from "cloudflare:workers";
import type { BlueprintVersion } from "./catalog";
import type { CheckRequest, CheckResult, MonthUsage, RunResult } from "./cell";
import { AGENT_BLUEPRINT } from "./cell";
import type { Env } from "./env";
import { type ApprovalStatus, GatekeeperError, SETTLED, type TokenUsage, fromApprovals, gatekeeper } from "./host";
import { sha256Hex } from "./http";
import { isCapability, isName, newId } from "./names";
import { RUNNER_SOURCE, runnerDigest } from "./runner";
import type { Owner } from "./workspace";

// One chat with the agent. The agent service is stateless: what the user
// and the agent said, the code the agent ran and what came of it all live
// here, so a restart of the agent loses at most the turn in progress. A
// session also holds the capabilities its owner granted it. The agent's own
// model calls use them (inference:model/<name>:invoke), and every run of the
// agent's code gets exactly them: never more than the owner granted, and
// nothing of the owner's other cells.

export interface SessionInfo {
  id: string;
  workspace: string;
  title: string;
  owner: Owner;
  createdAt: number;
}

// A tool call, as OpenAI's chat completions API writes it.
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// One entry of the transcript. user, assistant and tool messages are the
// agent's, in the chat completions shape so it can send them back to its
// model; events are the kernel's: an approval settled, a turn interrupted.
export interface Message {
  seq: number;
  role: "user" | "assistant" | "tool" | "event";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  // tool: the tool's name, and the run's id if it ran code.
  name?: string;
  run?: string;
  // event: the approval that settled.
  approval?: ApprovalEvent;
  at: number;
}

export interface ApprovalEvent {
  id: string;
  cell: string;
  capability?: string;
  state: string;
  reason?: string;
  // The provider's answer, for a call that was made.
  status?: number;
  body?: string;
}

export interface Turn {
  id: string;
  startedAt: number;
  expiresAt: number;
}

export interface SessionView extends SessionInfo {
  grants: string[];
  turn: Turn | null;
  // Approvals the session's runs are waiting on.
  pending: { id: string; cell: string; capability: string }[];
  messages: Message[];
}

export type SessionResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;

// A model call's answer, as the Gatekeeper gave it.
export interface ModelAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// How long a turn may run. The turn token expires then, and a turn the
// agent never ended is reported as interrupted.
export const TURN_MS = 5 * 60_000;
const MAX_MESSAGES = 5000;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_CODE_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_LISTED_MESSAGES = 1000;
const APPROVAL_POLL_FIRST_MS = 2_000;
const APPROVAL_POLL_MAX_MS = 60_000;
const MAX_WATCHED_APPROVALS = 100;
const APPROVAL_BODY_BYTES = 2048;
// Gadgets the agent writes. Each draft is a new bundle, and celld 0.6.0
// keeps every bundle it loads in memory, so a session may write only so
// many.
const MAX_DRAFTS = 20;
const MAX_GADGET_BYTES = 96 * 1024;
const MAX_DECLARED = 20;

// A draft the agent wrote: its Blueprint version, and what its page
// answered when the kernel loaded it.
export interface DraftResult {
  blueprint: BlueprintVersion;
  check: CheckResult;
}

interface Watched {
  id: string;
  cell: string;
  capability: string;
}

interface ApprovalWatch {
  items: Watched[];
  at: number;
  delay: number;
}

// The model a capability names: "agent" for inference:model/agent:invoke.
const MODEL = /^inference:model\/([^:/]+):invoke$/;

export class Session extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL
    )`);
  }

  // Called by the workspace when it registers the session.
  async create(info: SessionInfo, grants: string[]): Promise<void> {
    this.ctx.storage.kv.put("info", info);
    this.ctx.storage.kv.put("grants", grants);
  }

  info(): SessionInfo | null {
    return this.ctx.storage.kv.get<SessionInfo>("info") ?? null;
  }

  // The session as the API returns it, with the messages after `after`.
  view(after = 0): SessionView | null {
    const info = this.info();
    if (!info) return null;
    const messages = this.ctx.storage.sql
      .exec<{ seq: number; body: string }>(
        "SELECT seq, body FROM messages WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        MAX_LISTED_MESSAGES,
      )
      .toArray()
      .map((r) => ({ ...JSON.parse(r.body), seq: r.seq }) as Message);
    return {
      ...info,
      grants: this.grants(),
      turn: this.currentTurn(),
      pending: this.ctx.storage.kv.get<ApprovalWatch>("approvals")?.items ?? [],
      messages,
    };
  }

  async rename(title: string): Promise<void> {
    const info = this.info();
    if (info) this.ctx.storage.kv.put("info", { ...info, title });
  }

  // Replaces the session's grants. The caller has checked them. A turn in
  // progress uses the new grants from its next call.
  async setGrants(grants: string[]): Promise<SessionResult<string[]>> {
    if (!this.info()) return fail(404, "session does not exist");
    this.ctx.storage.kv.put("grants", [...new Set(grants)].sort());
    return { ok: true, value: this.grants() };
  }

  // Starts a turn with the owner's message. One turn at a time: a second is
  // refused until the first ends or runs out of time.
  async startTurn(content: string): Promise<SessionResult<{ turn: Turn; view: SessionView }>> {
    if (!this.info()) return fail(404, "session does not exist");
    if (this.currentTurn()) return fail(409, "the agent is still answering");
    this.expireTurn();
    const now = Date.now();
    const turn: Turn = { id: crypto.randomUUID(), startedAt: now, expiresAt: now + TURN_MS };
    const appended = this.append({ role: "user", content });
    if (!appended.ok) return appended;
    this.ctx.storage.kv.put("turn", turn);
    this.count((m) => m.requests++);
    await this.schedule();
    return { ok: true, value: { turn, view: this.view()! } };
  }

  // Ends a turn. The agent ends its own; the owner may end one that is stuck.
  async endTurn(id: string): Promise<SessionResult<null>> {
    const turn = this.ctx.storage.kv.get<Turn>("turn");
    if (!turn || turn.id !== id) return fail(404, "no such turn");
    this.ctx.storage.kv.delete("turn");
    await this.schedule();
    return { ok: true, value: null };
  }

  // Whether `id` is the turn in progress.
  isCurrentTurn(id: string): boolean {
    return this.currentTurn()?.id === id;
  }

  // Appends one of the agent's messages, during a turn.
  async addMessage(message: Omit<Message, "seq" | "at">): Promise<SessionResult<Message>> {
    if (!this.info()) return fail(404, "session does not exist");
    return this.append(message);
  }

  // Calls one of the session's models through the Gatekeeper, as the
  // session: the owner's budgets pay for it and the audit log records it.
  async complete(model: string, request: unknown): Promise<SessionResult<ModelAnswer>> {
    const info = this.info();
    if (!info) return fail(404, "session does not exist");
    const capability = `inference:model/${model}:invoke`;
    if (!this.grants().includes(capability)) return fail(403, `the session has no grant for ${capability}`);
    let res: Response;
    try {
      res = await gatekeeper(this.env, "/v1/calls", {
        workspace: info.workspace,
        cell: info.id,
        blueprint: AGENT_BLUEPRINT,
        version: info.id,
        owner: info.owner,
        grants: this.grants(),
        capability,
        request: {
          method: "POST",
          path: "/chat/completions",
          headers: { "content-type": "application/json" },
          body: toBase64(new TextEncoder().encode(JSON.stringify(request))),
        },
      });
    } catch (err) {
      if (err instanceof GatekeeperError) return fail(err.status, err.message);
      throw err;
    }
    const answer = (await res.json()) as { status: number; headers?: Record<string, string>; body?: string; usage?: TokenUsage };
    if (answer.usage) await this.recordUsage(capability, answer.usage);
    return {
      ok: true,
      value: {
        status: answer.status,
        headers: answer.headers ?? {},
        body: answer.body ? new TextDecoder().decode(fromBase64(answer.body)) : "",
      },
    };
  }

  // Runs the agent's code in a new ephemeral cell with the session's grants.
  // The cell is deleted when the run ends; approvals its calls wait on are
  // followed here, and reported in the transcript when they settle.
  async run(code: string, input: unknown): Promise<SessionResult<RunResult>> {
    const info = this.info();
    if (!info) return fail(404, "session does not exist");
    if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) return fail(413, "code larger than 64 KiB");
    if (JSON.stringify(input ?? null).length > MAX_INPUT_BYTES) return fail(413, "input larger than 64 KiB of JSON");
    const bundle = await storeRunner(this.env);
    const id = newId("r");
    this.count((m) => m.requests++);
    const result = await this.env.CELL.getByName(id).run({
      id,
      workspace: info.workspace,
      session: info.id,
      owner: info.owner,
      grants: this.grants(),
      bundle,
      code,
      input: input ?? null,
      timeoutMs: Number(this.env.AGENT_RUN_TIMEOUT_MS) || 60_000,
      callLimit: Number(this.env.AGENT_RUN_CALLS) || 20,
    });
    return { ok: true, value: result };
  }

  // Stores a gadget the agent wrote as a draft Blueprint version for the
  // session's owner, records in the Gatekeeper's audit log that they
  // authored it, and loads it once to see that it serves. Only the owner
  // can use the draft until they publish it, and publishing is theirs alone.
  async draft(
    name: string,
    source: string,
    capabilities: string[],
    requests: CheckRequest[] = [],
  ): Promise<SessionResult<DraftResult>> {
    const info = this.info();
    if (!info) return fail(404, "session does not exist");
    if (!isName(name)) return fail(400, "a gadget's name is lowercase letters, digits and hyphens");
    const bytes = new TextEncoder().encode(source);
    if (!bytes.byteLength) return fail(400, "the gadget's source is empty");
    if (bytes.byteLength > MAX_GADGET_BYTES) return fail(413, "a gadget the agent writes is at most 96 KiB");
    if (!Array.isArray(capabilities) || capabilities.length > MAX_DECLARED || !capabilities.every(isCapability)) {
      return fail(400, "capabilities must be a list of <provider>:<resource>:<verb>");
    }
    const drafts = this.ctx.storage.kv.get<number>("drafts") ?? 0;
    if (drafts >= MAX_DRAFTS) return fail(429, `this session has written ${MAX_DRAFTS} drafts; start a new one`);

    const bundle = await sha256Hex(bytes);
    await this.env.BUNDLES.put(`sha256/${bundle}.js`, bytes, { httpMetadata: { contentType: "text/javascript" } });
    const catalog = this.env.CATALOG.getByName("catalog");
    const drafted = await catalog.draft({
      name,
      bundle,
      capabilities: [...new Set(capabilities)],
      author: info.owner,
      session: info.id,
      workspace: info.workspace,
    });
    if (!drafted.ok) return drafted;
    const blueprint = drafted.value;
    try {
      await audit(this.env, "authored", blueprint, info.owner, info.id);
    } catch (err) {
      await catalog.discard(blueprint.name, blueprint.version);
      return fail(503, `the draft was not kept, because it could not be audited: ${err instanceof Error ? err.message : err}`);
    }
    this.ctx.storage.kv.put("drafts", drafts + 1);
    this.count((m) => m.requests++);
    const checkCell = newId("r");
    const check = await this.env.CELL.getByName(checkCell).check({
      id: checkCell,
      workspace: info.workspace,
      session: info.id,
      owner: info.owner,
      blueprint,
      requests,
    });
    return { ok: true, value: { blueprint, check } };
  }

  // Called by an ephemeral cell, which is about to be deleted, when one of
  // its calls is queued for approval.
  async trackApproval(id: string, cell: string, capability: string): Promise<void> {
    if (!this.info()) return;
    const watch = this.ctx.storage.kv.get<ApprovalWatch>("approvals") ?? { items: [], at: 0, delay: 0 };
    if (!watch.items.some((w) => w.id === id)) {
      watch.items = [...watch.items, { id, cell, capability }].slice(-MAX_WATCHED_APPROVALS);
    }
    const at = Date.now() + APPROVAL_POLL_FIRST_MS;
    this.ctx.storage.kv.put("approvals", {
      items: watch.items,
      at: watch.at && watch.at < at ? watch.at : at,
      delay: APPROVAL_POLL_FIRST_MS,
    });
    await this.schedule();
  }

  // What a model call used: the session's own, or one of its runs'.
  async recordUsage(capability: string, usage: TokenUsage): Promise<void> {
    const model = MODEL.exec(capability)?.[1];
    if (!model || !this.info()) return;
    this.count((month) => {
      const m = (month.inference[model] ??= { calls: 0, input: 0, output: 0, total: 0 });
      m.calls++;
      m.input += count(usage?.input);
      m.output += count(usage?.output);
      m.total += count(usage?.total) || count(usage?.input) + count(usage?.output);
    });
  }

  // What the session did in a month: turns and runs as requests, the
  // tokens of its model calls and its runs', and its transcript's size.
  async usage(month: string): Promise<MonthUsage & { month: string; storageBytes: number }> {
    const stored = this.ctx.storage.kv.get<MonthUsage>(`usage:${month}`);
    return {
      month,
      requests: stored?.requests ?? 0,
      lastActive: stored?.lastActive ?? null,
      inference: stored?.inference ?? {},
      storageBytes: this.ctx.storage.sql.databaseSize,
    };
  }

  // Called by the workspace to delete the session and its transcript.
  // Approvals it was following stay in the owner's queue.
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // The session's alarm ends a turn the agent did not, and asks about the
  // approvals its runs are waiting on.
  async alarm(): Promise<void> {
    if (!this.info()) return;
    this.expireTurn();
    const watch = this.ctx.storage.kv.get<ApprovalWatch>("approvals");
    if (watch && watch.at <= Date.now()) await this.pollApprovals(watch);
    await this.schedule();
  }

  private grants(): string[] {
    return this.ctx.storage.kv.get<string[]>("grants") ?? [];
  }

  private currentTurn(): Turn | null {
    const turn = this.ctx.storage.kv.get<Turn>("turn");
    return turn && turn.expiresAt > Date.now() ? turn : null;
  }

  // Ends a turn that ran out of time, and says so in the transcript.
  private expireTurn(): void {
    const turn = this.ctx.storage.kv.get<Turn>("turn");
    if (!turn || turn.expiresAt > Date.now()) return;
    this.ctx.storage.kv.delete("turn");
    this.append({ role: "event", content: "The agent stopped before it finished answering." });
  }

  private append(message: Omit<Message, "seq" | "at">): SessionResult<Message> {
    const n = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages").one().n;
    if (n >= MAX_MESSAGES) return fail(409, `the session has ${MAX_MESSAGES} messages; start a new one`);
    const body = JSON.stringify({ ...message, at: Date.now() });
    if (body.length > MAX_MESSAGE_BYTES) return fail(413, "message larger than 128 KiB");
    const seq = this.ctx.storage.sql
      .exec<{ seq: number }>("INSERT INTO messages (body) VALUES (?) RETURNING seq", body)
      .one().seq;
    return { ok: true, value: { ...JSON.parse(body), seq } };
  }

  private async pollApprovals(watch: ApprovalWatch): Promise<void> {
    const kv = this.ctx.storage.kv;
    const info = this.info()!;
    const settled: ApprovalStatus[] = [];
    // The Gatekeeper answers about one cell's approvals at a time; each run
    // is its own cell.
    const byCell = new Map<string, string[]>();
    for (const w of watch.items) byCell.set(w.cell, [...(byCell.get(w.cell) ?? []), w.id]);
    const watched = new Map(watch.items.map((w) => [w.id, w]));
    for (const [cell, ids] of byCell) {
      try {
        const res = await gatekeeper(this.env, "/v1/approvals/query", { cell, owner: info.owner, ids });
        const statuses = fromApprovals(((await res.json()) as { approvals: Parameters<typeof fromApprovals>[0] }).approvals);
        for (const s of statuses) {
          if (SETTLED.has(s.state)) settled.push(s);
        }
      } catch (err) {
        console.log(`session ${info.id}: asking about approvals failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const s of settled) {
      const w = watched.get(s.id);
      const event: ApprovalEvent = { id: s.id, cell: w?.cell ?? "", capability: s.capability || w?.capability, state: s.state };
      if (s.reason) event.reason = s.reason;
      if (s.result) {
        event.status = s.result.status;
        event.body = new TextDecoder().decode(s.result.body).slice(0, APPROVAL_BODY_BYTES);
      }
      this.append({ role: "event", content: describeApproval(event), approval: event });
    }
    const current = kv.get<ApprovalWatch>("approvals") ?? watch;
    const done = new Set(settled.map((s) => s.id));
    const items = current.items.filter((w) => !done.has(w.id));
    if (!items.length) {
      kv.delete("approvals");
    } else if (current.at !== watch.at) {
      kv.put("approvals", { ...current, items });
    } else {
      const delay = Math.min(watch.delay * 2, APPROVAL_POLL_MAX_MS);
      kv.put("approvals", { items, at: Date.now() + delay, delay });
    }
  }

  // Sets the alarm to the earliest of the turn's end and the next time to
  // ask about approvals.
  private async schedule(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const times = [kv.get<Turn>("turn")?.expiresAt, kv.get<ApprovalWatch>("approvals")?.at].filter(
      (t): t is number => typeof t === "number",
    );
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  // Adds to this month's usage.
  private count(add: (month: MonthUsage) => void): void {
    const now = Date.now();
    const key = `usage:${new Date(now).toISOString().slice(0, 7)}`;
    const month = this.ctx.storage.kv.get<MonthUsage>(key) ?? { requests: 0, lastActive: null, inference: {} };
    add(month);
    month.lastActive = now;
    this.ctx.storage.kv.put(key, month);
  }
}

function describeApproval(e: ApprovalEvent): string {
  const what = e.capability ? `${e.capability} (approval ${e.id})` : `Approval ${e.id}`;
  switch (e.state) {
    case "done":
      return `${what} was approved and made; the provider answered ${e.status}.`;
    case "rejected":
      return `${what} was rejected by the owner; the call was not made.`;
    case "expired":
      return `${what} expired before anyone decided; the call was not made.`;
    case "failed":
      return `${what} was approved but failed: ${e.reason ?? "unknown reason"}. It will not be retried.`;
    default:
      return `${what} is ${e.state}.`;
  }
}

let stored: Promise<string> | undefined;

// Stores the runner's bundle by digest, once per isolate.
function storeRunner(env: Env): Promise<string> {
  stored ??= (async () => {
    const digest = await runnerDigest();
    const key = `sha256/${digest}.js`;
    if (!(await env.BUNDLES.head(key))) {
      await env.BUNDLES.put(key, RUNNER_SOURCE, { httpMetadata: { contentType: "text/javascript" } });
    }
    return digest;
  })().catch((err) => {
    stored = undefined;
    throw err;
  });
  return stored;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Records in the Gatekeeper's audit log that a user authored or published a
// Blueprint version. Throws if it could not be recorded.
export async function audit(
  env: Env,
  kind: "authored" | "published",
  b: BlueprintVersion,
  user: Owner,
  session?: string,
): Promise<void> {
  await gatekeeper(env, "/v1/events", {
    kind,
    workspace: b.workspace ?? "",
    user,
    blueprint: b.name,
    version: b.version,
    bundle: b.bundle,
    capabilities: b.capabilities,
    ...(session ? { session } : {}),
  });
}
