import { KERNEL_BUILD } from "./build";
import type { Env } from "./env";
import { sha256Hex } from "./http";
import type { Caller } from "./identity";
import type { CellRecord, ShareRole } from "./workspace";
import { covers, isCapability, isDigest, isGrant, isName, isVersion } from "./names";

// The kernel API, served under /api/ on any host that is not a cell host.
// Every call carries a verified caller: a user, or the operator's admin
// token. Publishing and workspace settings need the admin token; any user may
// create cells, and sees and manages only their own and those shared with
// them.
//
//   GET    /api/version                               {build}
//   POST   /api/bundles                               body: gadget source
//   GET    /api/blueprints
//   GET    /api/blueprints/:name
//   PUT    /api/blueprints/:name/:version             {bundle, capabilities?, tier?}
//   PUT    /api/workspaces/:ws                        {quota}
//   GET    /api/workspaces/:ws
//   GET    /api/workspaces/:ws/usage?month=YYYY-MM
//   GET    /api/workspaces/:ws/cells
//   POST   /api/workspaces/:ws/cells                  {blueprint, version?}
//   GET    /api/workspaces/:ws/cells/:id
//   PATCH  /api/workspaces/:ws/cells/:id              {version}
//   DELETE /api/workspaces/:ws/cells/:id
//   GET    /api/workspaces/:ws/cells/:id/shares
//   PUT    /api/workspaces/:ws/cells/:id/shares/:email {role: viewer|editor}
//   DELETE /api/workspaces/:ws/cells/:id/shares/:email
//   GET    /api/workspaces/:ws/cells/:id/grants
//   PUT    /api/workspaces/:ws/cells/:id/grants        {grants: [capability]}

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const DEFAULT_QUOTA = 100;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const catalog = (env: Env) => env.CATALOG.getByName("catalog");

export async function api(request: Request, env: Env, path: string[], caller: Caller): Promise<Response> {
  try {
    return await route(request, env, path, caller);
  } catch (err) {
    if (err instanceof ApiError) return json(err.status, { error: err.message });
    throw err;
  }
}

async function route(request: Request, env: Env, path: string[], caller: Caller): Promise<Response> {
  const method = request.method;
  const [collection, a, b, c, d, e, ...rest] = path;
  if (rest.length) throw new ApiError(404, "not found");
  const admin = () => {
    if (caller.kind !== "admin") throw new ApiError(403, "needs the admin token");
  };

  if (collection === "version" && a === undefined && method === "GET") return json(200, { build: KERNEL_BUILD });
  if (collection === "whoami" && a === undefined && method === "GET") return json(200, caller);
  if (collection === "bundles" && a === undefined && method === "POST") {
    admin();
    return uploadBundle(request, env);
  }

  if (collection === "blueprints") {
    if (a === undefined && method === "GET") {
      const names = await catalog(env).names();
      return json(200, { blueprints: names });
    }
    name(a);
    if (b === undefined && method === "GET") {
      const versions = await catalog(env).versions(a);
      if (!versions.length) throw new ApiError(404, `blueprint ${a} does not exist`);
      return json(200, { name: a, versions });
    }
    if (c === undefined && method === "PUT") {
      admin();
      return publish(request, env, a, b);
    }
  }

  if (collection === "workspaces" && a !== undefined) {
    name(a);
    const ws = env.WORKSPACE.getByName(a);
    if (b === undefined && method === "PUT") {
      admin();
      const body = await readJson(request);
      const quota = body.quota ?? DEFAULT_QUOTA;
      if (!Number.isInteger(quota) || quota < 0) throw new ApiError(400, "quota must be a whole number");
      return json(200, await ws.configure(a, quota));
    }
    const info = await ws.info();
    if (!info) throw new ApiError(404, `workspace ${a} does not exist`);
    if (b === undefined && method === "GET") return json(200, info);
    if (b === "usage" && c === undefined && method === "GET") {
      // The admin token sees every cell; a user sees the cells they own.
      const month = new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, "month must be YYYY-MM");
      return json(200, await ws.usage(month, caller.kind === "admin" ? undefined : caller.user));
    }
    if (b === "cells" && c === undefined && method === "GET") {
      const cells = (await ws.listCells()).filter((cell) => canSee(caller, cell));
      return json(200, { cells });
    }
    if (b === "cells" && c === undefined && method === "POST") return createCell(request, env, a, caller);
    if (b === "cells" && c !== undefined) {
      const cell = await ws.getCell(c);
      if (!cell || !canSee(caller, cell)) throw new ApiError(404, "cell does not exist in this workspace");
      const owner = () => {
        if (!owns(caller, cell)) throw new ApiError(403, "only the cell's owner can do this");
      };
      if (d === undefined && method === "GET") return json(200, cell);
      if (d === undefined && method === "PATCH") {
        owner();
        return moveCell(request, env, a, cell);
      }
      if (d === undefined && method === "DELETE") {
        owner();
        const result = await ws.deleteCell(c);
        if (!result.ok) throw new ApiError(result.status, result.error);
        return new Response(null, { status: 204 });
      }
      if (d === "shares" && e === undefined && method === "GET") {
        owner();
        return json(200, { shares: cell.shares });
      }
      if (d === "shares" && e !== undefined) {
        owner();
        const email = e.toLowerCase();
        if (!email.includes("@")) throw new ApiError(400, "share with an email address");
        if (method === "PUT") {
          const role = (await readJson(request)).role;
          if (role !== "viewer" && role !== "editor") throw new ApiError(400, "role must be viewer or editor");
          return result(await ws.share(c, email, role as ShareRole));
        }
        if (method === "DELETE") return result(await ws.unshare(c, email));
      }
      if (d === "grants" && e === undefined && method === "GET") {
        owner();
        return json(200, { grants: cell.grants });
      }
      if (d === "grants" && e === undefined && method === "PUT") {
        owner();
        return setGrants(request, env, a, cell);
      }
    }
  }

  throw new ApiError(404, "not found");
}

async function uploadBundle(request: Request, env: Env): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) throw new ApiError(400, "empty bundle");
  if (body.byteLength > MAX_BUNDLE_BYTES) throw new ApiError(413, "bundle larger than 8 MiB");
  const digest = await sha256Hex(body);
  await env.BUNDLES.put(`sha256/${digest}.js`, body, { httpMetadata: { contentType: "text/javascript" } });
  return json(201, { digest });
}

async function publish(request: Request, env: Env, blueprint: string, version: string): Promise<Response> {
  if (!isVersion(version)) throw new ApiError(400, "invalid version");
  const body = await readJson(request);
  if (!isDigest(body.bundle)) throw new ApiError(400, "bundle must be a SHA-256 digest");
  const capabilities = body.capabilities ?? [];
  if (!Array.isArray(capabilities) || !capabilities.every(isCapability)) {
    throw new ApiError(400, "capabilities must be a list of <provider>:<resource>:<verb>");
  }
  const tier = body.tier ?? "shared";
  if (!isName(tier)) throw new ApiError(400, "invalid tier");
  if (!(await env.BUNDLES.head(`sha256/${body.bundle}.js`))) {
    throw new ApiError(400, `bundle ${body.bundle} has not been uploaded`);
  }
  const result = await catalog(env).publish({ name: blueprint, version, bundle: body.bundle, capabilities, tier });
  if (!result.ok) throw new ApiError(409, `${blueprint} ${version} is already published`);
  return json(201, result.blueprint);
}

async function createCell(request: Request, env: Env, workspace: string, caller: Caller): Promise<Response> {
  const body = await readJson(request);
  // A user owns the cells they create; the admin token names the owner.
  let owner = caller.kind === "user" ? { user: caller.user, email: caller.email } : body.owner;
  if (!owner || typeof owner.user !== "string" || !owner.user || typeof owner.email !== "string") {
    throw new ApiError(400, "the admin token must name the cell's owner as {user, email}");
  }
  owner = { user: owner.user, email: owner.email.toLowerCase() };
  name(body.blueprint);
  if (body.version !== undefined && !isVersion(body.version)) throw new ApiError(400, "invalid version");
  const blueprint =
    body.version === undefined
      ? await catalog(env).latest(body.blueprint)
      : await catalog(env).get(body.blueprint, body.version);
  if (!blueprint) throw new ApiError(404, "blueprint version does not exist");
  return result(await env.WORKSPACE.getByName(workspace).createCell(blueprint, owner), 201);
}

async function moveCell(request: Request, env: Env, workspace: string, cell: CellRecord): Promise<Response> {
  const body = await readJson(request);
  if (!isVersion(body.version)) throw new ApiError(400, "version is required");
  const blueprint = await catalog(env).get(cell.blueprint, body.version);
  if (!blueprint) throw new ApiError(404, "blueprint version does not exist");
  return result(await env.WORKSPACE.getByName(workspace).moveCell(cell.id, blueprint));
}

// Grants are concrete capabilities, each covered by one the cell's Blueprint
// version declares. The list replaces the cell's grants.
async function setGrants(request: Request, env: Env, workspace: string, cell: CellRecord): Promise<Response> {
  const grants = (await readJson(request)).grants;
  if (!Array.isArray(grants) || !grants.every(isGrant)) {
    throw new ApiError(400, "grants must be a list of <provider>:<resource>:<verb> without wildcards");
  }
  const blueprint = await catalog(env).get(cell.blueprint, cell.version);
  if (!blueprint) throw new ApiError(409, "the cell's blueprint version no longer exists");
  const undeclared = grants.filter((g) => !blueprint.capabilities.some((c) => covers(c, g)));
  if (undeclared.length) {
    throw new ApiError(400, `${cell.blueprint} ${cell.version} does not declare ${undeclared.join(", ")}`);
  }
  return result(await env.WORKSPACE.getByName(workspace).setGrants(cell.id, grants));
}

function result<T>(r: { ok: true; value: T } | { ok: false; status: number; error: string }, status = 200): Response {
  if (!r.ok) throw new ApiError(r.status, r.error);
  return json(status, r.value);
}

function owns(caller: Caller, cell: CellRecord): boolean {
  return caller.kind === "admin" || caller.user === cell.owner.user;
}

function canSee(caller: Caller, cell: CellRecord): boolean {
  return owns(caller, cell) || (caller.kind === "user" && Object.hasOwn(cell.shares, caller.email));
}

function name(value: unknown): asserts value is string {
  if (!isName(value)) throw new ApiError(400, "names are lowercase letters, digits and hyphens");
}

// Reads a JSON object body; any other body is a 400.
async function readJson(request: Request): Promise<Record<string, any>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, any>;
  } catch {
    // Fall through.
  }
  throw new ApiError(400, "body must be a JSON object");
}
