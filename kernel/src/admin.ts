import { KERNEL_BUILD } from "./build";
import type { Env } from "./env";
import { GatekeeperError, gatekeeper } from "./host";
import { type Caller, isAdmin } from "./identity";
import { isGrant, isName } from "./names";
import { type Budgets, type Settings, forgetPlatformView, platform } from "./platform";

// The platform admin's API, under /api/admin/. Only a platform admin, or the
// operator's admin token, may use it; the operator also reports the
// cluster's configuration here.
//
//   GET  /api/admin/overview                  {build, cluster, settings, workspaces, blueprints, users}
//   GET  /api/admin/settings                  {agent: {model, maxTokens, maxSteps}, sessionGrants}
//   PUT  /api/admin/settings                  the same
//   GET  /api/admin/budgets                   {user, workspace, users, workspaces}
//   PUT  /api/admin/budgets                   the same
//   GET  /api/admin/usage?month=YYYY-MM       {month, budgets, users, workspaces}
//   GET  /api/admin/workspaces                {workspaces: [{name, quota, cells, members, admins}]}
//   GET  /api/admin/blueprints                {versions}: every version of every name
//   GET  /api/admin/users                     {users}: who has signed in, this month's spend
//   PUT  /api/admin/users/:user               {suspended, email?}
//   GET  /api/admin/audit?user=&workspace=&cell=&blueprint=&decision=&days=&limit=
//   PUT  /api/admin/cluster                   the cluster's configuration (admin token)

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const MODEL = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MAX_CLUSTER_BYTES = 256 * 1024;
const MAX_AUDIT_DAYS = 31;

export async function adminApi(request: Request, env: Env, path: string[], caller: Caller): Promise<Response> {
  if (!isAdmin(caller)) throw new AdminError(403, "needs a platform admin");
  const method = request.method;
  const [what, id, ...rest] = path;
  if (rest.length) throw new AdminError(404, "not found");
  const catalog = env.CATALOG.getByName("catalog");

  if (what === "overview" && id === undefined && method === "GET") {
    const [cluster, settings, workspaces, versions, users] = await Promise.all([
      platform(env).cluster(),
      platform(env).settings(),
      catalog.workspaces(),
      catalog.all(),
      platform(env).users(),
    ]);
    return json(200, {
      build: KERNEL_BUILD,
      caller,
      cluster,
      settings,
      workspaces: workspaces.length,
      blueprints: new Set(versions.map((v) => v.name)).size,
      versions: versions.length,
      users: users.length,
      suspended: users.filter((u) => u.suspended).length,
    });
  }

  if (what === "settings" && id === undefined) {
    if (method === "GET") return json(200, await platform(env).settings());
    if (method === "PUT") {
      const settings = checkSettings(await readJson(request));
      await adminEvent(env, caller, "settings.update", { detail: settings });
      forgetPlatformView();
      return json(200, await platform(env).setSettings(settings));
    }
  }

  if (what === "budgets" && id === undefined) {
    if (method === "GET") return json(200, await platform(env).budgets());
    if (method === "PUT") {
      const budgets = checkBudgets(await readJson(request));
      await adminEvent(env, caller, "budgets.update", { detail: budgets });
      forgetPlatformView();
      return json(200, await platform(env).setBudgets(budgets));
    }
  }

  if (what === "usage" && id === undefined && method === "GET") {
    return json(200, await platform(env).usage(month(request), await catalog.workspaces()));
  }

  if (what === "workspaces" && id === undefined && method === "GET") {
    const names = await catalog.workspaces();
    const workspaces = await Promise.all(
      names.map(async (name) => {
        const ws = env.WORKSPACE.getByName(name);
        const [info, members] = await Promise.all([ws.info(), ws.members()]);
        return {
          name,
          quota: info?.quota ?? 0,
          cells: info?.cells ?? 0,
          members: members.length,
          admins: members.filter((m) => m.role === "admin").map((m) => m.email),
        };
      }),
    );
    return json(200, { workspaces });
  }

  if (what === "blueprints" && id === undefined && method === "GET") {
    return json(200, { versions: await catalog.all() });
  }

  if (what === "users" && id === undefined && method === "GET") {
    const usage = await platform(env).usage(month(request), []);
    const users = (await platform(env).users()).map((u) => {
      const spent = usage.users.find((s) => s.user === u.user);
      return { ...u, tokens: spent?.tokens ?? 0, calls: spent?.calls ?? 0, budget: spent?.budget ?? usage.budgets.user };
    });
    return json(200, { month: usage.month, users });
  }

  if (what === "users" && id !== undefined && method === "PUT") {
    const body = await readJson(request);
    if (typeof body.suspended !== "boolean") throw new AdminError(400, "suspended must be true or false");
    if (caller.kind === "user" && caller.user === id && body.suspended) {
      throw new AdminError(400, "you cannot suspend yourself");
    }
    const known = (await platform(env).users()).find((u) => u.user === id);
    const email = typeof body.email === "string" ? body.email.toLowerCase() : (known?.email ?? "");
    await adminEvent(env, caller, body.suspended ? "user.suspend" : "user.unsuspend", { target: id, detail: { email } });
    const user = await platform(env).setSuspended(id, email, body.suspended, actor(caller).email || actor(caller).user);
    forgetPlatformView();
    return json(200, user);
  }

  if (what === "audit" && id === undefined && method === "GET") return audit(request, env);

  if (what === "cluster" && id === undefined && method === "PUT") {
    if (caller.kind !== "admin") throw new AdminError(403, "only the operator reports the cluster");
    const body = await request.text();
    if (body.length > MAX_CLUSTER_BYTES) throw new AdminError(413, "cluster report larger than 256 KiB");
    let cluster: unknown;
    try {
      cluster = JSON.parse(body);
    } catch {
      throw new AdminError(400, "body must be a JSON object");
    }
    if (!cluster || typeof cluster !== "object" || Array.isArray(cluster)) throw new AdminError(400, "body must be a JSON object");
    await platform(env).setCluster(cluster);
    return new Response(null, { status: 204 });
  }

  throw new AdminError(404, "not found");
}

// Searches the Gatekeeper's audit log for this fleet's records, newest
// first.
async function audit(request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const days = Number(q.get("days") ?? 1);
  if (!Number.isInteger(days) || days < 1 || days > MAX_AUDIT_DAYS) throw new AdminError(400, `days must be 1 to ${MAX_AUDIT_DAYS}`);
  const limit = Number(q.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AdminError(400, "limit must be 1 to 500");
  const filter: Record<string, string> = {};
  for (const key of ["user", "workspace", "cell", "blueprint", "decision"]) {
    const v = q.get(key)?.trim();
    if (v) filter[key] = v.slice(0, 256);
  }
  const before = q.get("before");
  try {
    const res = await gatekeeper(env, "/v1/audit/query", { ...filter, days, limit, ...(before ? { before } : {}) });
    return json(200, await res.json());
  } catch (err) {
    if (err instanceof GatekeeperError) throw new AdminError(err.status, err.message);
    throw err;
  }
}

// Records an administrator's action in the Gatekeeper's audit log. Throws if
// it cannot be recorded, so the action does not happen. The operator's own
// changes (the admin token) are its GitOps history's to record, not this.
export async function adminEvent(
  env: Env,
  caller: Caller,
  action: string,
  fields: { workspace?: string; target?: string; detail?: unknown } = {},
): Promise<void> {
  if (caller.kind !== "user") return;
  const detail = fields.detail === undefined ? undefined : JSON.stringify(fields.detail).slice(0, 4096);
  try {
    await gatekeeper(env, "/v1/events", {
      kind: "admin",
      action,
      user: actor(caller),
      workspace: fields.workspace ?? "",
      ...(fields.target ? { target: fields.target } : {}),
      ...(detail ? { detail } : {}),
    });
  } catch (err) {
    throw new AdminError(503, `not done, because it could not be audited: ${err instanceof Error ? err.message : err}`);
  }
}

function actor(caller: Caller): { user: string; email: string } {
  return caller.kind === "admin" ? { user: "admin-token", email: "" } : { user: caller.user, email: caller.email };
}

function checkSettings(body: Record<string, any>): Settings {
  const agent = body.agent;
  if (!agent || typeof agent !== "object") throw new AdminError(400, "agent is required");
  if (typeof agent.model !== "string" || !MODEL.test(agent.model)) throw new AdminError(400, "agent.model must be a model name, e.g. agent");
  if (!Number.isInteger(agent.maxTokens) || agent.maxTokens < 256 || agent.maxTokens > 200_000) {
    throw new AdminError(400, "agent.maxTokens must be 256 to 200000");
  }
  if (!Number.isInteger(agent.maxSteps) || agent.maxSteps < 1 || agent.maxSteps > 50) {
    throw new AdminError(400, "agent.maxSteps must be 1 to 50");
  }
  const grants = body.sessionGrants ?? null;
  if (grants !== null && (!Array.isArray(grants) || grants.length > 100 || !grants.every(isGrant))) {
    throw new AdminError(400, "sessionGrants must be null or a list of capabilities without wildcards");
  }
  return {
    agent: { model: agent.model, maxTokens: agent.maxTokens, maxSteps: agent.maxSteps },
    sessionGrants: grants === null ? null : [...new Set<string>(grants)].sort(),
  };
}

function checkBudgets(body: Record<string, any>): Budgets {
  const limit = (v: unknown, what: string): number | null => {
    if (v === null) return null;
    if (!Number.isInteger(v) || (v as number) < 0) throw new AdminError(400, `${what} must be a whole number of tokens, or null for no limit`);
    return v as number;
  };
  const overrides = (v: unknown, what: string, key: (k: string) => boolean): Record<string, number | null> => {
    if (v === undefined) return {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new AdminError(400, `${what} must be an object`);
    const entries = Object.entries(v);
    if (entries.length > 1000) throw new AdminError(400, `${what} has more than 1000 entries`);
    return Object.fromEntries(
      entries.map(([k, n]) => {
        if (!key(k)) throw new AdminError(400, `${what} has an invalid key ${JSON.stringify(k).slice(0, 80)}`);
        return [k, limit(n, `${what}.${k}`)];
      }),
    );
  };
  if (!("user" in body) || !("workspace" in body)) throw new AdminError(400, "user and workspace are required (null for no limit)");
  return {
    user: limit(body.user, "user"),
    workspace: limit(body.workspace, "workspace"),
    users: overrides(body.users, "users", (k) => k.length > 0 && k.length <= 256),
    workspaces: overrides(body.workspaces, "workspaces", isName),
  };
}

function month(request: Request): string {
  const m = new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new AdminError(400, "month must be YYYY-MM");
  return m;
}

async function readJson(request: Request): Promise<Record<string, any>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, any>;
  } catch {
    // Fall through.
  }
  throw new AdminError(400, "body must be a JSON object");
}
