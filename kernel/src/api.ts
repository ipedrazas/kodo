import { KERNEL_BUILD } from "./build";
import type { Env } from "./env";
import { sha256Hex } from "./http";
import { isCapability, isDigest, isName, isVersion } from "./names";

// The kernel API, served under /api/ on any host that is not a cell host.
// Phase 5 puts identity in front of it; until then it has no authentication
// and must only be reachable from inside the cluster.
//
//   GET    /api/version                               {build}
//   POST   /api/bundles                               body: gadget source
//   GET    /api/blueprints
//   GET    /api/blueprints/:name
//   PUT    /api/blueprints/:name/:version             {bundle, capabilities?, tier?}
//   PUT    /api/workspaces/:ws                        {quota}
//   GET    /api/workspaces/:ws
//   GET    /api/workspaces/:ws/cells
//   POST   /api/workspaces/:ws/cells                  {blueprint, version?}
//   GET    /api/workspaces/:ws/cells/:id
//   PATCH  /api/workspaces/:ws/cells/:id              {version}
//   DELETE /api/workspaces/:ws/cells/:id

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

export async function api(request: Request, env: Env, path: string[]): Promise<Response> {
  try {
    return await route(request, env, path);
  } catch (err) {
    if (err instanceof ApiError) return json(err.status, { error: err.message });
    throw err;
  }
}

async function route(request: Request, env: Env, path: string[]): Promise<Response> {
  const method = request.method;
  const [collection, a, b, c, d, ...rest] = path;
  if (rest.length) throw new ApiError(404, "not found");

  if (collection === "version" && a === undefined && method === "GET") return json(200, { build: KERNEL_BUILD });
  if (collection === "bundles" && a === undefined && method === "POST") return uploadBundle(request, env);

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
    if (c === undefined && method === "PUT") return publish(request, env, a, b);
  }

  if (collection === "workspaces" && a !== undefined) {
    name(a);
    const ws = env.WORKSPACE.getByName(a);
    if (b === undefined && method === "PUT") {
      const body = await readJson(request);
      const quota = body.quota ?? DEFAULT_QUOTA;
      if (!Number.isInteger(quota) || quota < 0) throw new ApiError(400, "quota must be a whole number");
      return json(200, await ws.configure(a, quota));
    }
    const info = await ws.info();
    if (!info) throw new ApiError(404, `workspace ${a} does not exist`);
    if (b === undefined && method === "GET") return json(200, info);
    if (b === "cells" && c === undefined && method === "GET") return json(200, { cells: await ws.listCells() });
    if (b === "cells" && c === undefined && method === "POST") return createCell(request, env, a);
    if (b === "cells" && c !== undefined && d === undefined) {
      if (method === "GET") {
        const cell = await ws.getCell(c);
        if (!cell) throw new ApiError(404, "cell does not exist in this workspace");
        return json(200, cell);
      }
      if (method === "PATCH") return moveCell(request, env, a, c);
      if (method === "DELETE") {
        const result = await ws.deleteCell(c);
        if (!result.ok) throw new ApiError(result.status, result.error);
        return new Response(null, { status: 204 });
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

async function createCell(request: Request, env: Env, workspace: string): Promise<Response> {
  const body = await readJson(request);
  name(body.blueprint);
  if (body.version !== undefined && !isVersion(body.version)) throw new ApiError(400, "invalid version");
  const blueprint =
    body.version === undefined
      ? await catalog(env).latest(body.blueprint)
      : await catalog(env).get(body.blueprint, body.version);
  if (!blueprint) throw new ApiError(404, "blueprint version does not exist");
  const result = await env.WORKSPACE.getByName(workspace).createCell(blueprint);
  if (!result.ok) throw new ApiError(result.status, result.error);
  return json(201, result.value);
}

async function moveCell(request: Request, env: Env, workspace: string, id: string): Promise<Response> {
  const body = await readJson(request);
  if (!isVersion(body.version)) throw new ApiError(400, "version is required");
  const ws = env.WORKSPACE.getByName(workspace);
  const cell = await ws.getCell(id);
  if (!cell) throw new ApiError(404, "cell does not exist in this workspace");
  const blueprint = await catalog(env).get(cell.blueprint, body.version);
  if (!blueprint) throw new ApiError(404, "blueprint version does not exist");
  const result = await ws.moveCell(id, blueprint);
  if (!result.ok) throw new ApiError(result.status, result.error);
  return json(200, result.value);
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
