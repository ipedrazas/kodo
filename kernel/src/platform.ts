import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { TokenUsage } from "./host";

// The fleet's own settings, one instance for the fleet: how the agent works,
// what new chats are granted, the monthly token budgets and what has been
// spent against them, the users who have signed in and which of them are
// suspended, and the cluster's configuration as the operator last reported
// it. Platform admins change it through the API; the agent reads it at the
// start of every turn.

export interface AgentSettings {
  // The model the agent thinks with, inference:model/<model>:invoke.
  model: string;
  // max_tokens of each model call; a gadget is written in one answer.
  maxTokens: number;
  // Model calls per turn, at most.
  maxSteps: number;
}

export interface Settings {
  agent: AgentSettings;
  // What a new chat is granted when its creator names nothing; null for
  // just the agent's model.
  sessionGrants: string[] | null;
}

// Monthly token budgets: a default for each user and each workspace, and
// overrides for some, which may raise or lower it. null is no limit.
export interface Budgets {
  user: number | null;
  workspace: number | null;
  users: Record<string, number | null>;
  workspaces: Record<string, number | null>;
}

export interface UserRecord {
  user: string;
  email: string;
  firstSeen: number;
  lastSeen: number;
  suspended: { at: number; by: string } | null;
}

// What a user or a workspace spent on models in a month, and its budget.
export interface Spend {
  calls: number;
  input: number;
  output: number;
  tokens: number;
  budget: number | null;
}

export type BudgetCheck = { ok: true } | { ok: false; scope: "user" | "workspace"; budget: number; spent: number };

export const DEFAULT_SETTINGS: Settings = {
  agent: { model: "agent", maxTokens: 16384, maxSteps: 10 },
  sessionGrants: null,
};

// What the inference gateway enforced before budgets moved into the kernel.
export const DEFAULT_BUDGETS: Budgets = { user: 1_000_000, workspace: 5_000_000, users: {}, workspaces: {} };

// What every request needs to know, cached for this long in each isolate:
// a suspension takes effect within it.
const VIEW_TTL_MS = 5_000;

export class Platform extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      user TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      suspended_at INTEGER,
      suspended_by TEXT
    )`);
    // Model spend by month, per user (key: subject) and per workspace (key:
    // name).
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS spend (
      month TEXT NOT NULL,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      calls INTEGER NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      PRIMARY KEY (month, scope, key)
    )`);
  }

  // What the router and the API read on every request; see platformView.
  view(): { settings: Settings; budgets: Budgets; suspended: string[] } {
    return {
      settings: this.settings(),
      budgets: this.budgets(),
      suspended: this.ctx.storage.sql
        .exec<{ user: string }>("SELECT user FROM users WHERE suspended_at IS NOT NULL")
        .toArray()
        .map((r) => r.user),
    };
  }

  settings(): Settings {
    const s = this.ctx.storage.kv.get<Partial<Settings>>("settings") ?? {};
    return { agent: { ...DEFAULT_SETTINGS.agent, ...s.agent }, sessionGrants: s.sessionGrants ?? null };
  }

  setSettings(settings: Settings): Settings {
    this.ctx.storage.kv.put("settings", settings);
    return this.settings();
  }

  budgets(): Budgets {
    return { ...DEFAULT_BUDGETS, ...this.ctx.storage.kv.get<Partial<Budgets>>("budgets") };
  }

  setBudgets(budgets: Budgets): Budgets {
    this.ctx.storage.kv.put("budgets", budgets);
    return this.budgets();
  }

  // Remembers that a user signed in. The router calls it now and then, not
  // on every request.
  seen(user: string, email: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO users (user, email, first_seen, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (user) DO UPDATE SET email = excluded.email, last_seen = excluded.last_seen`,
      user,
      email,
      now,
      now,
    );
  }

  users(): UserRecord[] {
    return this.ctx.storage.sql
      .exec<{
        user: string;
        email: string;
        first_seen: number;
        last_seen: number;
        suspended_at: number | null;
        suspended_by: string | null;
      }>("SELECT * FROM users ORDER BY last_seen DESC")
      .toArray()
      .map((r) => ({
        user: r.user,
        email: r.email,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        suspended: r.suspended_at ? { at: r.suspended_at, by: r.suspended_by ?? "" } : null,
      }));
  }

  // Suspends a user, or lifts it. A user never seen is remembered.
  setSuspended(user: string, email: string, suspended: boolean, by: string): UserRecord {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO users (user, email, first_seen, last_seen) VALUES (?, ?, ?, ?)",
      user,
      email,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE users SET suspended_at = ?, suspended_by = ? WHERE user = ?",
      suspended ? now : null,
      suspended ? by : null,
      user,
    );
    return this.users().find((u) => u.user === user)!;
  }

  // Whether a model call may be made: the owner and the workspace each have
  // budget left this month. As at the gateway before, the call that crosses
  // a budget is answered and the next is refused.
  checkBudget(user: string, workspace: string): BudgetCheck {
    const month = thisMonth();
    const budgets = this.budgets();
    for (const [scope, key, budget] of [
      ["user", user, budgetFor(budgets.users, user, budgets.user)],
      ["workspace", workspace, budgetFor(budgets.workspaces, workspace, budgets.workspace)],
    ] as const) {
      if (budget === null) continue;
      const spent = this.spent(month, scope, key).tokens;
      if (spent >= budget) return { ok: false, scope, budget, spent };
    }
    return { ok: true };
  }

  // Counts what a model call used against its owner and workspace.
  spend(user: string, workspace: string, usage: TokenUsage): void {
    const input = count(usage?.input);
    const output = count(usage?.output);
    const tokens = count(usage?.total) || input + output;
    const month = thisMonth();
    for (const [scope, key] of [
      ["user", user],
      ["workspace", workspace],
    ]) {
      this.ctx.storage.sql.exec(
        `INSERT INTO spend VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (month, scope, key) DO UPDATE SET calls = calls + 1, input = input + excluded.input,
           output = output + excluded.output, tokens = tokens + excluded.tokens`,
        month,
        scope,
        key,
        input,
        output,
        tokens,
      );
    }
  }

  // Every user's and workspace's spend in a month, with their budgets. Users
  // who signed in but spent nothing, and workspaces with an override, are
  // listed too.
  usage(month: string, workspaces: string[]): {
    month: string;
    budgets: Budgets;
    users: (Spend & { user: string; email: string })[];
    workspaces: (Spend & { workspace: string })[];
  } {
    const budgets = this.budgets();
    const rows = this.ctx.storage.sql
      .exec<{ scope: string; key: string; calls: number; input: number; output: number; tokens: number }>(
        "SELECT scope, key, calls, input, output, tokens FROM spend WHERE month = ?",
        month,
      )
      .toArray();
    const spent = (scope: string, key: string) => {
      const r = rows.find((r) => r.scope === scope && r.key === key);
      return { calls: r?.calls ?? 0, input: r?.input ?? 0, output: r?.output ?? 0, tokens: r?.tokens ?? 0 };
    };
    const known = this.users();
    const userKeys = new Set([...known.map((u) => u.user), ...rows.filter((r) => r.scope === "user").map((r) => r.key)]);
    const wsKeys = new Set([
      ...workspaces,
      ...Object.keys(budgets.workspaces),
      ...rows.filter((r) => r.scope === "workspace").map((r) => r.key),
    ]);
    return {
      month,
      budgets,
      users: [...userKeys]
        .map((user) => ({
          user,
          email: known.find((u) => u.user === user)?.email ?? "",
          ...spent("user", user),
          budget: budgetFor(budgets.users, user, budgets.user),
        }))
        .sort((a, b) => b.tokens - a.tokens || a.email.localeCompare(b.email)),
      workspaces: [...wsKeys]
        .map((workspace) => ({
          workspace,
          ...spent("workspace", workspace),
          budget: budgetFor(budgets.workspaces, workspace, budgets.workspace),
        }))
        .sort((a, b) => b.tokens - a.tokens || a.workspace.localeCompare(b.workspace)),
    };
  }

  // The cluster's configuration, as the operator reports it: models and
  // their backends, the gateway's rate limits, the fleet's nodes.
  setCluster(cluster: unknown): void {
    this.ctx.storage.kv.put("cluster", { reportedAt: Date.now(), ...(cluster as object) });
  }

  cluster(): Record<string, unknown> | null {
    return this.ctx.storage.kv.get<Record<string, unknown>>("cluster") ?? null;
  }

  private spent(month: string, scope: string, key: string): { tokens: number } {
    return (
      this.ctx.storage.sql
        .exec<{ tokens: number }>("SELECT tokens FROM spend WHERE month = ? AND scope = ? AND key = ?", month, scope, key)
        .toArray()[0] ?? { tokens: 0 }
    );
  }
}

const budgetFor = (overrides: Record<string, number | null>, key: string, fallback: number | null) =>
  Object.hasOwn(overrides, key) ? overrides[key] : fallback;

const thisMonth = () => new Date().toISOString().slice(0, 7);

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export const platform = (env: Env) => env.PLATFORM.getByName("platform");

let cached: { at: number; view: Promise<{ settings: Settings; budgets: Budgets; suspended: Set<string> }> } | undefined;

// The platform's settings and suspended users, read at most every few
// seconds per isolate.
export function platformView(env: Env): Promise<{ settings: Settings; budgets: Budgets; suspended: Set<string> }> {
  if (!cached || Date.now() - cached.at > VIEW_TTL_MS) {
    const view = platform(env)
      .view()
      .then((v) => ({ settings: v.settings, budgets: v.budgets, suspended: new Set(v.suspended) }));
    cached = { at: Date.now(), view };
    view.catch(() => {
      if (cached?.view === view) cached = undefined;
    });
  }
  return cached.view;
}

// Forgets the cached view, after this isolate changed it.
export function forgetPlatformView(): void {
  cached = undefined;
}

// When each user was last reported as seen by this isolate.
const reported = new Map<string, number>();
const SEEN_EVERY_MS = 10 * 60_000;

// Records now and then that a user signed in, for the admin's list of users.
export async function noteUser(env: Env, user: string, email: string): Promise<void> {
  const last = reported.get(user);
  if (last && Date.now() - last < SEEN_EVERY_MS) return;
  reported.set(user, Date.now());
  if (reported.size > 10_000) reported.clear();
  try {
    await platform(env).seen(user, email);
  } catch (err) {
    reported.delete(user);
    console.log(`recording a sign-in failed: ${err instanceof Error ? err.message : err}`);
  }
}

// The grants a new chat gets when its creator names none.
export function defaultSessionGrants(settings: Settings): string[] {
  return settings.sessionGrants ?? [modelGrant(settings.agent.model)];
}

export const modelGrant = (model: string) => `inference:model/${model}:invoke`;
