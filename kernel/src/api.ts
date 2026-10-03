import { AdminError, adminApi, adminEvent } from "./admin";
import { KERNEL_BUILD } from "./build";
import type { Env } from "./env";
import { sha256Hex } from "./http";
import { type Caller, isAdmin } from "./identity";
import { isCellId } from "./hostname";
import { covers, isCapability, isDigest, isGrant, isName, isVersion } from "./names";
import type { Viewer } from "./catalog";
import { defaultSessionGrants, modelGrant, platform } from "./platform";
import { type Message, type SessionInfo, type SessionResult, audit } from "./session";
import { signTurn } from "./turn";
import { type CellRecord, MAX_DOC_BYTES, MEMBER_ROLES, type MemberRole, type ShareRole } from "./workspace";

// The kernel API, served under /api/ on any host that is not a cell host.
// Every call carries a verified caller: a user, a turn, or the operator's
// admin token. Platform admins (and the admin token) publish, create
// workspaces and change the platform's settings; a workspace's admins manage
// its members, quota and docs; its members create cells and chats in it.
// A user sees and manages only their own cells and those shared with them.
//
//   GET    /api/version                               {build}
//   POST   /api/bundles                               body: gadget source
//   GET    /api/blueprints
//   GET    /api/blueprints/:name
//   PUT    /api/blueprints/:name/:version             {bundle, capabilities?, tier?}
//   POST   /api/blueprints/:name/:version/publish     publishes a draft
//   POST   /api/blueprints/:name/:version/withdraw    no new cell may use it
//   POST   /api/blueprints/:name/:version/restore
//   GET    /api/blueprints?author=me                  {versions}: the caller's agent's
//   GET    /api/workspaces                            {workspaces: [name], memberships}
//   PUT    /api/workspaces/:ws                        {quota?, members?}
//   GET    /api/workspaces/:ws                        {name, quota, cells, members, role}
//   GET    /api/workspaces/:ws/members
//   PUT    /api/workspaces/:ws/members/:email         {role: viewer|member|admin}
//   DELETE /api/workspaces/:ws/members/:email
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
//   GET    /api/workspaces/:ws/docs
//   GET    /api/workspaces/:ws/docs/:path              markdown
//   PUT    /api/workspaces/:ws/docs/:path              body: markdown
//   DELETE /api/workspaces/:ws/docs/:path
//   GET    /api/workspaces/:ws/sessions
//   POST   /api/workspaces/:ws/sessions                {title?, grants?}
//   GET    /api/workspaces/:ws/sessions/:id?after=N
//   DELETE /api/workspaces/:ws/sessions/:id
//   PUT    /api/workspaces/:ws/sessions/:id/grants     {grants: [capability]}
//   POST   /api/workspaces/:ws/sessions/:id/turns      {content}
//   DELETE /api/workspaces/:ws/sessions/:id/turns/:turn
//   POST   /api/workspaces/:ws/sessions/:id/messages   {role, content, ...}
//   POST   /api/workspaces/:ws/sessions/:id/complete   {model, request}
//   POST   /api/workspaces/:ws/sessions/:id/runs       {code, input?}
//   POST   /api/workspaces/:ws/sessions/:id/drafts     {name, source, capabilities?, checks?}
//   GET    /api/runs/:id                               {bound, keys}
//   GET    /api/platform/agent                         {model, maxTokens, maxSteps, grant}
//   *      /api/admin/...                              see admin.ts

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const DEFAULT_QUOTA = 100;
const DEFAULT_SESSION_TITLE = "New chat";
// Docs paths: lowercase segments ending in .md, e.g. skills/email.md.
const DOC_PATH = /^(?:[a-z0-9][a-z0-9._-]*\/){0,7}[a-z0-9][a-z0-9._-]*\.md$/;

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
    if (path[0] === "admin") return await adminApi(request, env, path.slice(1), caller);
    return await route(request, env, path, caller);
  } catch (err) {
    if (err instanceof ApiError || err instanceof AdminError) return json(err.status, { error: err.message });
    throw err;
  }
}

async function route(request: Request, env: Env, path: string[], caller: Caller): Promise<Response> {
  const method = request.method;
  const [collection, a, b, c, d, e, ...rest] = path;
  // Only a document's path may be longer.
  if (rest.length && !(collection === "workspaces" && b === "docs")) throw new ApiError(404, "not found");
  const admin = () => {
    if (!isAdmin(caller)) throw new ApiError(403, "needs a platform admin");
  };

  // A turn may use only its own session, and read its workspace's docs.
  if (caller.kind === "turn") {
    const own = collection === "workspaces" && a === caller.workspace;
    const docs = own && b === "docs" && method === "GET";
    const session = own && b === "sessions" && c === caller.session && d !== "grants" && !(d === "turns" && method === "POST");
    if (!docs && !session) throw new ApiError(403, "a turn token may use only its own session");
  }

  if (collection === "version" && a === undefined && method === "GET") return json(200, { build: KERNEL_BUILD });
  if (collection === "whoami" && a === undefined && method === "GET") return json(200, caller);
  if (collection === "platform" && a === "agent" && b === undefined && method === "GET") {
    const { agent } = await platform(env).settings();
    return json(200, { ...agent, grant: modelGrant(agent.model) });
  }
  if (collection === "bundles" && a === undefined && method === "POST") {
    admin();
    return uploadBundle(request, env);
  }

  if (collection === "blueprints") {
    // A user sees published versions and their own drafts.
    const viewer = viewerOf(caller);
    if (a === undefined && method === "GET" && new URL(request.url).searchParams.get("author") === "me") {
      if (caller.kind !== "user") throw new ApiError(400, "author=me needs a user");
      return json(200, { versions: await catalog(env).authoredBy(caller.user) });
    }
    if (a === undefined && method === "GET") {
      const names = await catalog(env).names(viewer);
      return json(200, { blueprints: names });
    }
    name(a);
    if (b === undefined && method === "GET") {
      const versions = await catalog(env).versions(a, viewer);
      if (!versions.length) throw new ApiError(404, `blueprint ${a} does not exist`);
      return json(200, { name: a, versions });
    }
    if (b !== undefined && c === undefined && method === "PUT") {
      admin();
      return publish(request, env, a, b, caller);
    }
    if (b !== undefined && c === "publish" && d === undefined && method === "POST") {
      return publishDraft(env, a, b, caller);
    }
    if (b !== undefined && (c === "withdraw" || c === "restore") && d === undefined && method === "POST") {
      admin();
      if (!isVersion(b)) throw new ApiError(400, "invalid version");
      const withdraw = c === "withdraw";
      const version = await catalog(env).get(a, b);
      if (!version) throw new ApiError(404, "blueprint version does not exist");
      if (version.status === "draft") throw new ApiError(409, `${a} ${b} is a draft; only its author can use it`);
      if (withdraw === (version.status === "withdrawn")) throw new ApiError(409, `${a} ${b} is ${withdraw ? "already withdrawn" : "not withdrawn"}`);
      await adminEvent(env, caller, withdraw ? "blueprint.withdraw" : "blueprint.restore", { target: `${a}@${b}` });
      return result(await catalog(env).setWithdrawn(a, b, withdraw, actorOf(caller)));
    }
  }

  if (collection === "runs" && a !== undefined && b === undefined && method === "GET") {
    // Whether anything is left of a run's ephemeral cell.
    admin();
    if (!isCellId(a) || !a.startsWith("r")) throw new ApiError(400, "not a run id");
    return json(200, await env.CELL.getByName(a).residue());
  }

  if (collection === "workspaces" && a !== undefined && b === "docs") {
    name(a);
    const ws = env.WORKSPACE.getByName(a);
    if (!(await ws.info())) throw new ApiError(404, `workspace ${a} does not exist`);
    // Members read the docs, as does the agent in their turns; the
    // workspace's admins write them.
    const role = await roleIn(env, a, caller);
    if (!role) throw new ApiError(403, `you are not a member of ${a}`);
    if (c === undefined && method === "GET") return json(200, { docs: await ws.listDocs() });
    const doc_ = docPath(path.slice(3));
    if (method !== "GET" && role !== "admin") throw new ApiError(403, `only an admin of ${a} changes its docs`);
    if (method === "GET") {
      const doc = await ws.getDoc(doc_);
      if (doc === null) throw new ApiError(404, "document does not exist");
      return new Response(doc, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    if (method === "PUT") {
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_DOC_BYTES) throw new ApiError(413, "document larger than 256 KiB");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
      } catch {
        throw new ApiError(400, "a document is UTF-8 text");
      }
      await adminEvent(env, caller, "doc.put", { workspace: a, target: doc_, detail: { bytes: body.byteLength } });
      return result(await ws.putDoc(doc_, content));
    }
    if (method === "DELETE") {
      if ((await ws.getDoc(doc_)) === null) throw new ApiError(404, "document does not exist");
      await adminEvent(env, caller, "doc.delete", { workspace: a, target: doc_ });
      const r = await ws.deleteDoc(doc_);
      if (!r.ok) throw new ApiError(r.status, r.error);
      return new Response(null, { status: 204 });
    }
    throw new ApiError(404, "not found");
  }

  if (collection === "workspaces" && a === undefined && method === "GET") {
    // Platform admins see every workspace; a user the ones they belong to.
    if (isAdmin(caller)) return json(200, { workspaces: await catalog(env).workspaces() });
    const memberships = caller.kind === "user" ? await catalog(env).membershipsOf(caller.email) : [];
    return json(200, { workspaces: memberships.map((m) => m.workspace), memberships });
  }

  if (collection === "workspaces" && a !== undefined) {
    name(a);
    const ws = env.WORKSPACE.getByName(a);
    if (b === undefined && method === "PUT") return configureWorkspace(request, env, a, caller);
    const info = await ws.info();
    if (!info) throw new ApiError(404, `workspace ${a} does not exist`);
    const role = await roleIn(env, a, caller);
    if (b === undefined && method === "GET") {
      // Workspaces configured before the catalog listed them are listed
      // once someone opens them.
      await catalog(env).rememberWorkspace(a);
      return json(200, { ...info, role });
    }
    if (b === "members") return members(request, env, a, caller, role, c, d);
    if (b === "usage" && c === undefined && method === "GET") {
      // Admins see every cell; a user sees the cells they own.
      const month = new URL(request.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, "month must be YYYY-MM");
      const everyone = isAdmin(caller) || (role === "admin" && caller.kind === "user");
      return json(200, await ws.usage(month, everyone || caller.kind === "admin" ? undefined : caller.user));
    }
    if (b === "cells" && c === undefined && method === "GET") {
      const cells = (await ws.listCells()).filter((cell) => canSee(caller, cell));
      return json(200, { cells });
    }
    if (b === "cells" && c === undefined && method === "POST") {
      if (caller.kind === "user" && !creates(role)) throw new ApiError(403, `only members of ${a} create cells in it`);
      return createCell(request, env, a, caller);
    }
    if (b === "sessions") return sessions(request, env, a, caller, c, d, e);
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
        // A platform admin may delete any cell, though not open it.
        if (!owns(caller, cell) && !isAdmin(caller)) throw new ApiError(403, "only the cell's owner can do this");
        if (!owns(caller, cell)) await adminEvent(env, caller, "cell.delete", { workspace: a, target: c, detail: { owner: cell.owner } });
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

async function publish(request: Request, env: Env, blueprint: string, version: string, caller: Caller): Promise<Response> {
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
  if (await catalog(env).get(blueprint, version)) throw new ApiError(409, `${blueprint} ${version} is already published`);
  await adminEvent(env, caller, "blueprint.publish", { target: `${blueprint}@${version}`, detail: { bundle: body.bundle, capabilities } });
  const result = await catalog(env).publish({ name: blueprint, version, bundle: body.bundle, capabilities, tier });
  if (!result.ok) throw new ApiError(409, `${blueprint} ${version} is already published`);
  return json(201, result.blueprint);
}

async function createCell(request: Request, env: Env, workspace: string, caller: Caller): Promise<Response> {
  const body = await readJson(request);
  // A user owns the cells they create; the admin token names the owner.
  const owner = ownerOf(caller, body);
  name(body.blueprint);
  if (body.version !== undefined && !isVersion(body.version)) throw new ApiError(400, "invalid version");
  // A draft is for its author alone until they publish it. The admin token
  // creating a cell for someone acts as that owner.
  const viewer: Viewer = { admin: false, user: owner.user };
  const blueprint =
    body.version === undefined
      ? await catalog(env).latest(body.blueprint, viewer)
      : await catalog(env).get(body.blueprint, body.version);
  if (blueprint?.status === "withdrawn") throw new ApiError(410, `${blueprint.name} ${blueprint.version} has been withdrawn`);
  if (!blueprint || !usable(blueprint, viewer)) throw new ApiError(404, "blueprint version does not exist");
  return result(await env.WORKSPACE.getByName(workspace).createCell(blueprint, owner), 201);
}

async function moveCell(request: Request, env: Env, workspace: string, cell: CellRecord): Promise<Response> {
  const body = await readJson(request);
  if (!isVersion(body.version)) throw new ApiError(400, "version is required");
  const blueprint = await catalog(env).get(cell.blueprint, body.version);
  if (blueprint?.status === "withdrawn") throw new ApiError(410, `${blueprint.name} ${blueprint.version} has been withdrawn`);
  if (!blueprint || !usable(blueprint, { admin: false, user: cell.owner.user })) {
    throw new ApiError(404, "blueprint version does not exist");
  }
  return result(await env.WORKSPACE.getByName(workspace).moveCell(cell.id, blueprint));
}

// Publishes a draft the agent wrote: its author's decision, never the
// agent's (a turn token cannot reach this). Recorded in the Gatekeeper's
// audit log first; a draft that cannot be audited stays a draft.
async function publishDraft(env: Env, blueprint: string, version: string, caller: Caller): Promise<Response> {
  if (caller.kind === "turn") throw new ApiError(403, "only the author can publish a draft");
  if (!isVersion(version)) throw new ApiError(400, "invalid version");
  const draft = await catalog(env).get(blueprint, version);
  const viewer = viewerOf(caller);
  if (!draft || !usable(draft, viewer)) throw new ApiError(404, "blueprint version does not exist");
  if (draft.status !== "draft") throw new ApiError(409, `${blueprint} ${version} is already published`);
  if (caller.kind === "user" && draft.author?.user !== caller.user) throw new ApiError(403, "only its author can publish a draft");
  const publisher = caller.kind === "user" ? { user: caller.user, email: caller.email } : null;
  try {
    await audit(env, "published", draft, publisher ?? draft.author ?? { user: "admin", email: "" });
  } catch (err) {
    throw new ApiError(503, `not published, because it could not be audited: ${err instanceof Error ? err.message : err}`);
  }
  const published = await catalog(env).publishDraft(blueprint, version, publisher);
  if (!published.ok) throw new ApiError(published.status, published.error);
  return json(200, published.value);
}

function viewerOf(caller: Caller): Viewer {
  return isAdmin(caller) || caller.kind === "admin" ? { admin: true } : { admin: false, user: caller.user };
}

function actorOf(caller: Caller): { user: string; email: string } {
  return caller.kind === "admin" ? { user: "admin-token", email: "" } : { user: caller.user, email: caller.email };
}

// The caller's role in a workspace: a member's own; admin for a platform
// admin or the admin token; a turn's owner's (and the turn is checked to
// be in that workspace already); null for anyone else.
async function roleIn(env: Env, workspace: string, caller: Caller): Promise<MemberRole | null> {
  if (isAdmin(caller) || caller.kind === "admin") return "admin";
  return env.WORKSPACE.getByName(workspace).role(caller.email);
}

// Whether a role may create cells and chats.
const creates = (role: MemberRole | null) => role === "member" || role === "admin";

// Creates a workspace (platform admins only) or changes its quota and
// members (its admins too). The operator's admin token sets the quota on
// every reconcile, so only a person's change is audited.
async function configureWorkspace(request: Request, env: Env, workspace: string, caller: Caller): Promise<Response> {
  const ws = env.WORKSPACE.getByName(workspace);
  const info = await ws.info();
  const role = info ? await roleIn(env, workspace, caller) : null;
  if (!isAdmin(caller) && !(role === "admin" && caller.kind === "user")) {
    throw new ApiError(403, info ? `only an admin of ${workspace} changes it` : "only a platform admin creates workspaces");
  }
  const body = await readJson(request);
  const quota = body.quota;
  if (quota !== undefined && (!Number.isInteger(quota) || quota < 0)) throw new ApiError(400, "quota must be a whole number");
  const members = body.members === undefined ? {} : checkMembers(body.members);
  if (caller.kind === "user" && !caller.platformAdmin && Object.hasOwn(members, caller.email) && members[caller.email] !== "admin") {
    throw new ApiError(400, "you cannot take away your own admin role");
  }
  const changed = !info || (quota !== undefined && quota !== info.quota) || Object.keys(members).length > 0;
  if (changed) {
    await adminEvent(env, caller, info ? "workspace.update" : "workspace.create", {
      workspace,
      detail: { ...(quota !== undefined ? { quota } : {}), ...(Object.keys(members).length ? { members } : {}) },
    });
  }
  let configured = await ws.configure(workspace, quota, DEFAULT_QUOTA);
  await catalog(env).rememberWorkspace(workspace);
  if (Object.keys(members).length) {
    const r = await ws.setMembers(members, actorOf(caller).email || actorOf(caller).user);
    if (!r.ok) throw new ApiError(r.status, r.error);
    configured = (await ws.info())!;
  }
  return json(200, configured);
}

// A workspace's members: its members see who they are; its admins add,
// change and remove them.
async function members(
  request: Request,
  env: Env,
  workspace: string,
  caller: Caller,
  role: MemberRole | null,
  email: string | undefined,
  rest: string | undefined,
): Promise<Response> {
  const method = request.method;
  const ws = env.WORKSPACE.getByName(workspace);
  if (rest !== undefined) throw new ApiError(404, "not found");
  if (email === undefined && method === "GET") {
    if (!role) throw new ApiError(403, `you are not a member of ${workspace}`);
    return json(200, { members: await ws.members() });
  }
  if (email === undefined) throw new ApiError(404, "not found");
  if (role !== "admin" || caller.kind === "turn") throw new ApiError(403, `only an admin of ${workspace} manages its members`);
  const who = email.toLowerCase();
  if (!who.includes("@")) throw new ApiError(400, "a member is an email address");
  const self = caller.kind === "user" && !caller.platformAdmin && caller.email === who;
  if (method === "PUT") {
    const r = (await readJson(request)).role;
    if (!MEMBER_ROLES.includes(r)) throw new ApiError(400, "role must be viewer, member or admin");
    if (self && r !== "admin") throw new ApiError(400, "you cannot take away your own admin role");
    await adminEvent(env, caller, "member.set", { workspace, target: who, detail: { role: r } });
    const set = await ws.setMembers({ [who]: r }, actorOf(caller).email || actorOf(caller).user);
    if (!set.ok) throw new ApiError(set.status, set.error);
    return json(200, set.value.find((m) => m.email === who));
  }
  if (method === "DELETE") {
    if (self) throw new ApiError(400, "you cannot remove yourself");
    if ((await ws.role(who)) === null) throw new ApiError(404, `${who} is not a member`);
    await adminEvent(env, caller, "member.remove", { workspace, target: who });
    const r = await ws.removeMember(who);
    if (!r.ok) throw new ApiError(r.status, r.error);
    return new Response(null, { status: 204 });
  }
  throw new ApiError(404, "not found");
}

function checkMembers(value: unknown): Record<string, MemberRole> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "members must be {email: role}");
  const entries = Object.entries(value);
  if (entries.length > 1000) throw new ApiError(400, "at most 1000 members at once");
  return Object.fromEntries(
    entries.map(([email, role]) => {
      if (!email.includes("@") || email.length > 254) throw new ApiError(400, "a member is an email address");
      if (!MEMBER_ROLES.includes(role as MemberRole)) throw new ApiError(400, "role must be viewer, member or admin");
      return [email.toLowerCase(), role as MemberRole];
    }),
  );
}

// Whether a new cell may use a version, or a cell move to it: a published
// one by anyone, a draft by its author, a withdrawn one by no one.
function usable(b: { status?: string; author?: { user: string } }, viewer: Viewer): boolean {
  if (b.status === "withdrawn") return false;
  return viewer.admin || b.status !== "draft" || b.author?.user === viewer.user;
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

// The agent's sessions. Their owner may do anything with them except write
// the transcript, which is the agent's, during a turn; the turn's token may
// read the session, write its transcript, call its models, run code and end
// the turn, but not change its grants or start another turn.
async function sessions(
  request: Request,
  env: Env,
  workspace: string,
  caller: Caller,
  id: string | undefined,
  sub: string | undefined,
  arg: string | undefined,
): Promise<Response> {
  const method = request.method;
  const ws = env.WORKSPACE.getByName(workspace);
  if (id === undefined) {
    if (method === "GET") {
      const mine = (await ws.listSessions()).filter((s) => ownsSession(caller, s));
      return json(200, { sessions: mine });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const owner = ownerOf(caller, body);
      if (caller.kind === "user" && !creates(await roleIn(env, workspace, caller))) {
        throw new ApiError(403, `only members of ${workspace} start chats in it`);
      }
      const title = body.title === undefined ? DEFAULT_SESSION_TITLE : sessionTitle(body.title);
      // Named grants, or what the platform gives new chats.
      const grants = body.grants ?? defaultSessionGrants(await platform(env).settings());
      checkGrants(grants);
      const created = await ws.createSession(owner, title, grants);
      if (!created.ok) throw new ApiError(created.status, created.error);
      return json(201, await env.SESSION.getByName(created.value.id).view());
    }
    throw new ApiError(404, "not found");
  }
  const info = await ws.getSession(id);
  if (!info || !ownsSession(caller, info)) throw new ApiError(404, "session does not exist in this workspace");
  const session = env.SESSION.getByName(id);
  // A turn's token works only while its turn is the session's current one.
  if (caller.kind === "turn" && !(await session.isCurrentTurn(caller.turn))) {
    throw new ApiError(401, "the turn is over");
  }
  const notTurn = () => {
    if (caller.kind === "turn") throw new ApiError(403, "a turn token cannot do this");
  };
  const onlyTurn = () => {
    if (caller.kind !== "turn" && caller.kind !== "admin") throw new ApiError(403, "only the agent, during a turn, writes the transcript");
  };

  if (sub === undefined && method === "GET") {
    const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new ApiError(400, "after must be a message number");
    return json(200, await session.view(after));
  }
  if (sub === undefined && method === "DELETE") {
    notTurn();
    const r = await ws.deleteSession(id);
    if (!r.ok) throw new ApiError(r.status, r.error);
    return new Response(null, { status: 204 });
  }
  if (sub === "grants" && arg === undefined && method === "PUT") {
    const grants = (await readJson(request)).grants;
    checkGrants(grants);
    return result(await session.setGrants(grants));
  }
  if (sub === "turns" && arg === undefined && method === "POST") {
    const content = (await readJson(request)).content;
    if (typeof content !== "string" || !content.trim()) throw new ApiError(400, "content is required");
    // A chat works in its workspace for as long as its owner belongs to it.
    if (caller.kind === "user" && !creates(await ws.role(info.owner.email)) && !isAdmin(caller)) {
      throw new ApiError(403, `you are no longer a member of ${workspace}`);
    }
    // The agent thinks with the platform's model: the owner who starts a
    // turn lets the chat use it.
    const { agent } = await platform(env).settings();
    await session.addGrant(modelGrant(agent.model));
    const started = sessionResult(await session.startTurn(content));
    if (info.title === DEFAULT_SESSION_TITLE) {
      const title = content.trim().replace(/\s+/g, " ").slice(0, 60);
      await ws.renameSession(id, title);
      started.view.title = title;
    }
    const owner = info.owner;
    const token = await signTurn(env, {
      workspace,
      session: id,
      turn: started.turn.id,
      user: owner.user,
      email: owner.email,
      expiresAt: started.turn.expiresAt,
    });
    return json(201, { turn: { ...started.turn, token }, session: started.view, agent });
  }
  if (sub === "turns" && arg !== undefined && method === "DELETE") {
    if (caller.kind === "turn" && caller.turn !== arg) throw new ApiError(403, "a turn token can end only its own turn");
    sessionResult(await session.endTurn(arg));
    return new Response(null, { status: 204 });
  }
  if (sub === "messages" && arg === undefined && method === "POST") {
    onlyTurn();
    return json(201, sessionResult(await session.addMessage(agentMessage(await readJson(request)))));
  }
  if (sub === "complete" && arg === undefined && method === "POST") {
    const body = await readJson(request);
    if (typeof body.model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(body.model)) {
      throw new ApiError(400, "model must be a model name, e.g. agent");
    }
    if (!body.request || typeof body.request !== "object") throw new ApiError(400, "request must be a chat completion");
    const answer = sessionResult(await session.complete(body.model, body.request));
    return new Response(answer.body, {
      status: answer.status,
      headers: {
        "content-type": answer.headers["content-type"] ?? "application/json",
        ...pick(answer.headers, ["x-kodo-decision", "x-ratelimit-reset", "x-ratelimit-limit", "x-ratelimit-remaining"]),
      },
    });
  }
  if (sub === "drafts" && arg === undefined && method === "POST") {
    const body = await readJson(request);
    if (typeof body.source !== "string") throw new ApiError(400, "source must be the gadget's JavaScript");
    const capabilities = body.capabilities ?? [];
    return json(201, sessionResult(await session.draft(body.name, body.source, capabilities, checkRequests(body.checks))));
  }
  if (sub === "runs" && arg === undefined && method === "POST") {
    const body = await readJson(request);
    if (typeof body.code !== "string" || !body.code.trim()) throw new ApiError(400, "code is required");
    return json(200, sessionResult(await session.run(body.code, body.input ?? null)));
  }
  throw new ApiError(404, "not found");
}

// What the agent may write to the transcript: its own messages, in the chat
// completions shape. Events are the kernel's.
function agentMessage(body: Record<string, any>): Omit<Message, "seq" | "at"> {
  const { role, content } = body;
  if (typeof content !== "string") throw new ApiError(400, "content must be a string");
  if (role === "user") return { role, content };
  if (role === "assistant") {
    const calls = body.tool_calls;
    if (calls === undefined) return { role, content };
    const valid =
      Array.isArray(calls) &&
      calls.length <= 16 &&
      calls.every(
        (c) =>
          c &&
          typeof c.id === "string" &&
          c.type === "function" &&
          typeof c.function?.name === "string" &&
          typeof c.function?.arguments === "string",
      );
    if (!valid) throw new ApiError(400, "tool_calls must be chat completion tool calls");
    const tool_calls = calls.map((c: any) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.function.name, arguments: c.function.arguments },
    }));
    return { role, content, tool_calls };
  }
  if (role === "tool") {
    if (typeof body.tool_call_id !== "string" || !body.tool_call_id) throw new ApiError(400, "tool_call_id is required");
    const message: Omit<Message, "seq" | "at"> = { role, content, tool_call_id: body.tool_call_id };
    if (typeof body.name === "string") message.name = body.name.slice(0, 64);
    if (typeof body.run === "string" && isCellId(body.run)) message.run = body.run;
    return message;
  }
  throw new ApiError(400, "role must be user, assistant or tool");
}

// Requests to make to a draft after GET /, to check it: at most five.
function checkRequests(value: unknown): { method: string; path: string; body?: unknown }[] {
  if (value === undefined) return [];
  const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
  if (!Array.isArray(value) || value.length > 5) throw new ApiError(400, "checks must be a list of at most 5 requests");
  return value.map((r) => {
    const method = String(r?.method ?? "GET").toUpperCase();
    if (!methods.has(method) || typeof r?.path !== "string" || !r.path.startsWith("/") || r.path.length > 512) {
      throw new ApiError(400, "each check is {method, path, body?}, with a path starting with /");
    }
    return r.body === undefined ? { method, path: r.path } : { method, path: r.path, body: r.body };
  });
}

function sessionResult<T>(r: SessionResult<T>): T {
  if (!r.ok) throw new ApiError(r.status, r.error);
  return r.value;
}

// The owner of something a caller creates: the user, or whoever the admin
// token names.
function ownerOf(caller: Caller, body: Record<string, any>): { user: string; email: string } {
  if (caller.kind === "user") return { user: caller.user, email: caller.email };
  if (caller.kind === "turn") throw new ApiError(403, "a turn token cannot do this");
  const owner = body.owner;
  if (!owner || typeof owner.user !== "string" || !owner.user || typeof owner.email !== "string") {
    throw new ApiError(400, "the admin token must name the owner as {user, email}");
  }
  return { user: owner.user, email: owner.email.toLowerCase() };
}

function ownsSession(caller: Caller, session: SessionInfo): boolean {
  return caller.kind === "admin" || caller.user === session.owner.user;
}

function sessionTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120) throw new ApiError(400, "title must be 1-120 characters");
  return value.trim();
}

function checkGrants(grants: unknown): asserts grants is string[] {
  if (!Array.isArray(grants) || grants.length > 100 || !grants.every(isGrant)) {
    throw new ApiError(400, "grants must be a list of <provider>:<resource>:<verb> without wildcards");
  }
}

function docPath(segments: string[]): string {
  const path = segments.join("/");
  if (!DOC_PATH.test(path) || path.length > 200) {
    throw new ApiError(400, "a document path is lowercase segments ending in .md, e.g. skills/email.md");
  }
  return path;
}

function pick(headers: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter((n) => headers[n] !== undefined).map((n) => [n, headers[n]]));
}

function result<T>(r: { ok: true; value: T } | { ok: false; status: number; error: string }, status = 200): Response {
  if (!r.ok) throw new ApiError(r.status, r.error);
  return json(status, r.value);
}

function owns(caller: Caller, cell: CellRecord): boolean {
  return caller.kind === "admin" || caller.user === cell.owner.user;
}

// Who sees a cell through the API: its owner, those it is shared with, and
// platform admins. Opening it is the cell's own check, which admins do not
// pass.
function canSee(caller: Caller, cell: CellRecord): boolean {
  return owns(caller, cell) || isAdmin(caller) || (caller.kind === "user" && Object.hasOwn(cell.shares, caller.email));
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
