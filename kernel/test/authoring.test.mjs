// Gadgets the agent writes: drafts for the session's owner, checked when
// they are stored, usable only by their author until the author (never the
// agent) publishes them, revised as new versions, and audited.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startKernel, user } from "./dev.mjs";

const MODEL = "inference:model/agent:invoke";
const WEB = "web:example.test:read";

// An echo gadget; `version` marks which one answered.
const echo = (version) => `import { Gadget } from "kodo";
export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS messages (text TEXT)");
  }
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response("<h1>Echo ${version}</h1>", { headers: { "content-type": "text/html" } });
    if (pathname === "/api/version") return Response.json({ version: "${version}" });
    if (pathname === "/api/messages" && request.method === "POST") {
      const { text } = await request.json();
      this.ctx.storage.sql.exec("INSERT INTO messages VALUES (?)", text);
      return Response.json({ from: "This Gadget", text });
    }
    if (pathname === "/api/messages") return Response.json(this.ctx.storage.sql.exec("SELECT text FROM messages").toArray().map((r) => r.text));
    if (pathname === "/api/web") {
      const grant = this.grants["${WEB}"];
      if (!grant) return Response.json({ error: "not granted" }, { status: 403 });
      return Response.json({ status: (await grant.fetch("/")).status });
    }
    return new Response("not found", { status: 404 });
  }
}
`;

let kernel;

before(async () => {
  kernel = await startKernel({ gatekeeper: true });
  await kernel.workspace("team", { quota: 100 });
  await kernel.publish("examples/notes.js", "notes", "1.0.0");
});

after(async () => {
  await kernel?.stop();
});

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};

// A session of `as` with a turn in progress, and calls with its token.
async function turn(as = "alice") {
  const s = ok(await kernel.api("POST", "/workspaces/team/sessions", { grants: [MODEL] }, { as }), 201);
  const t = ok(await kernel.api("POST", `/workspaces/team/sessions/${s.id}/turns`, { content: "write a gadget" }, { as }), 201).turn;
  const call = (method, path, body) => kernel.api(method, path, body, { as: null, headers: { "x-kodo-turn": t.token } });
  const draft = (name, source, capabilities = []) =>
    call("POST", `/workspaces/team/sessions/${s.id}/drafts`, { name, source, capabilities });
  return { session: s, call, draft };
}

const cellPage = async (cell, path = "/", options = {}) => {
  const res = await kernel.request(`${cell}.g.test`, path, options);
  assert.equal(res.status, 200, res.body);
  return res.body;
};

describe("drafts", () => {
  test("are stored for the session's owner, checked, and audited", async () => {
    const { session, draft } = await turn();
    const before = kernel.gatekeeper.events.length;
    const d = ok(await draft("echo", echo("v1"), [WEB]), 201);
    assert.equal(d.blueprint.name, "echo");
    assert.equal(d.blueprint.version, "1");
    assert.equal(d.blueprint.status, "draft");
    assert.equal(d.blueprint.publishedAt, 0);
    assert.deepEqual(d.blueprint.author, { user: user("alice").sub, email: "alice@test" });
    assert.equal(d.blueprint.session, session.id);
    assert.deepEqual(d.blueprint.capabilities, [WEB]);
    // The kernel loaded it and asked for its page.
    assert.equal(d.check.ok, true, JSON.stringify(d.check));
    assert.equal(d.check.status, 200);
    assert.match(d.check.body, /Echo v1/);
    const [event] = kernel.gatekeeper.events.slice(before);
    assert.deepEqual(event, {
      kind: "authored",
      workspace: "team",
      user: { user: user("alice").sub, email: "alice@test" },
      blueprint: "echo",
      version: "1",
      bundle: d.blueprint.bundle,
      capabilities: [WEB],
      session: session.id,
    });
  });

  test("that fail to load or serve say why", async () => {
    const { draft } = await turn();
    const syntax = ok(await draft("broken-syntax", "export class App {"), 201);
    assert.equal(syntax.check.ok, false);
    assert.match(syntax.check.error, /gadget failed/);
    const throws = ok(await draft("broken-fetch", `import { Gadget } from "kodo";
export class App extends Gadget { async fetch() { throw new Error("no page here"); } }`), 201);
    assert.equal(throws.check.ok, false);
    assert.match(throws.check.error, /no page here/);
  });

  test("are checked with the requests the agent gives, against one database", async () => {
    const { call, session } = await turn();
    const checks = [
      { method: "POST", path: "/api/messages", body: { text: "ping" } },
      { method: "GET", path: "/api/messages" },
    ];
    const good = ok(await call("POST", `/workspaces/team/sessions/${session.id}/drafts`, { name: "checked", source: echo("v1"), checks }), 201);
    assert.equal(good.check.ok, true, JSON.stringify(good.check));
    assert.deepEqual(good.check.requests.map((r) => [r.method, r.path, r.status]), [["POST", "/api/messages", 200], ["GET", "/api/messages", 200]]);
    assert.deepEqual(JSON.parse(good.check.requests[0].body), { from: "This Gadget", text: "ping" });
    assert.deepEqual(JSON.parse(good.check.requests[1].body), ["ping"]);

    // What the agent wrote on k3s: a page that serves, and an API that uses
    // the constructor's ctx where it meant this.ctx.
    const broken = echo("v2").replace('this.ctx.storage.sql.exec("INSERT', 'ctx.storage.sql.exec("INSERT');
    const bad = ok(await call("POST", `/workspaces/team/sessions/${session.id}/drafts`, { name: "checked", source: broken, checks }), 201);
    assert.equal(bad.check.status, 200);
    assert.equal(bad.check.ok, false);
    assert.match(bad.check.requests[0].error, /ctx is not defined/);
    assert.equal((await call("POST", `/workspaces/team/sessions/${session.id}/drafts`, { name: "checked", source: broken, checks: [{ path: "nope" }] })).status, 400);
  });

  test("are not kept if they cannot be audited", async () => {
    const { draft } = await turn();
    kernel.gatekeeper.refuseEvents = true;
    try {
      const res = await draft("unaudited", echo("x"));
      assert.equal(res.status, 503);
    } finally {
      kernel.gatekeeper.refuseEvents = false;
    }
    assert.equal((await kernel.api("GET", "/blueprints/unaudited")).status, 404);
  });

  test("cannot take a name that is someone else's", async () => {
    const alice = await turn("alice");
    ok(await alice.draft("mine", echo("a")), 201);
    const bob = await turn("bob");
    assert.equal((await bob.draft("mine", echo("b"))).status, 409);
    assert.equal((await bob.draft("notes", echo("b"))).status, 409);
    assert.equal((await alice.draft("Bad Name", echo("a"))).status, 400);
    assert.equal((await alice.draft("caps", echo("a"), ["github:repo/*:read:extra:"])).status, 400);
  });
});

describe("a draft", () => {
  test("is usable only by its author until they publish it", async () => {
    const { draft, call } = await turn();
    const d = ok(await draft("hello", echo("v1")), 201).blueprint;

    // Bob does not see it, cannot open it, and cannot publish it.
    assert.equal((await kernel.api("GET", "/blueprints/hello", undefined, { as: "bob" })).status, 404);
    assert.ok(!ok(await kernel.api("GET", "/blueprints", undefined, { as: "bob" })).blueprints.includes("hello"));
    assert.equal((await kernel.api("POST", "/workspaces/team/cells", { blueprint: "hello" }, { as: "bob" })).status, 404);
    assert.equal((await kernel.api("POST", "/workspaces/team/cells", { blueprint: "hello", version: "1" }, { as: "bob" })).status, 404);
    assert.equal((await kernel.api("POST", "/blueprints/hello/1/publish", undefined, { as: "bob" })).status, 404);

    // Alice can try it.
    assert.ok(ok(await kernel.api("GET", "/blueprints", undefined, { as: "alice" })).blueprints.includes("hello"));
    const tried = ok(await kernel.api("POST", "/workspaces/team/cells", { blueprint: "hello" }, { as: "alice" }), 201);
    assert.equal(tried.version, "1");
    assert.match(await cellPage(tried.id), /Echo v1/);

    // The agent cannot publish it, even during the turn that wrote it.
    assert.equal((await call("POST", "/blueprints/hello/1/publish")).status, 403);

    const before = kernel.gatekeeper.events.length;
    const published = ok(await kernel.api("POST", "/blueprints/hello/1/publish", undefined, { as: "alice" }));
    assert.equal(published.status, "published");
    assert.ok(published.publishedAt > 0);
    assert.deepEqual(published.publishedBy, { user: user("alice").sub, email: "alice@test" });
    assert.deepEqual(published.author, d.author);
    const [event] = kernel.gatekeeper.events.slice(before);
    assert.equal(event.kind, "published");
    assert.equal(event.version, "1");
    assert.deepEqual(event.user, { user: user("alice").sub, email: "alice@test" });
    assert.equal((await kernel.api("POST", "/blueprints/hello/1/publish", undefined, { as: "alice" })).status, 409);

    // Now Bob can open it.
    const bobs = ok(await kernel.api("POST", "/workspaces/team/cells", { blueprint: "hello" }, { as: "bob" }), 201);
    assert.match(await cellPage(bobs.id, "/", { as: "bob" }), /Echo v1/);
  });

  test("stays a draft if publishing cannot be audited", async () => {
    const { draft } = await turn();
    ok(await draft("pending-audit", echo("v1")), 201);
    kernel.gatekeeper.refuseEvents = true;
    try {
      assert.equal((await kernel.api("POST", "/blueprints/pending-audit/1/publish", undefined, { as: "alice" })).status, 503);
    } finally {
      kernel.gatekeeper.refuseEvents = false;
    }
    const versions = ok(await kernel.api("GET", "/blueprints/pending-audit", undefined, { as: "alice" })).versions;
    assert.equal(versions[0].status, "draft");
  });

  test("revised is a new version, and existing cells keep theirs", async () => {
    const { draft } = await turn();
    ok(await draft("revised", echo("v1")), 201);
    ok(await kernel.api("POST", "/blueprints/revised/1/publish", undefined, { as: "alice" }));
    const cell = ok(await kernel.api("POST", "/workspaces/team/cells", { blueprint: "revised" }, { as: "alice" }), 201);
    await cellPage(cell.id, "/api/messages", { method: "POST", body: JSON.stringify({ text: "hi" }), headers: { origin: `http://${cell.id}.g.test` } });

    const v2 = ok(await draft("revised", echo("v2")), 201).blueprint;
    assert.equal(v2.version, "2");
    assert.equal(v2.status, "draft");
    // The existing cell runs version 1 still, with its data.
    assert.deepEqual(JSON.parse(await cellPage(cell.id, "/api/version")), { version: "v1" });
    assert.deepEqual(JSON.parse(await cellPage(cell.id, "/api/messages")), ["hi"]);
    // A new cell gets the latest published version; Bob cannot reach the draft.
    const fresh = ok(await kernel.api("POST", "/workspaces/team/cells", { blueprint: "revised" }, { as: "bob" }), 201);
    assert.equal(fresh.version, "1");
    assert.equal((await kernel.api("PATCH", `/workspaces/team/cells/${fresh.id}`, { version: "2" }, { as: "bob" })).status, 404);

    // Its author can move the cell to the draft; it keeps its data.
    ok(await kernel.api("PATCH", `/workspaces/team/cells/${cell.id}`, { version: "2" }, { as: "alice" }));
    assert.deepEqual(JSON.parse(await cellPage(cell.id, "/api/version")), { version: "v2" });
    assert.deepEqual(JSON.parse(await cellPage(cell.id, "/api/messages")), ["hi"]);
  });

  test("gets no capability until its owner grants one it declares", async () => {
    const { draft } = await turn();
    ok(await draft("reader", echo("v1"), [WEB]), 201);
    const cell = ok(await kernel.api("POST", "/workspaces/team/cells", { blueprint: "reader", version: "1" }, { as: "alice" }), 201);
    assert.deepEqual(cell.grants, []);
    assert.equal((await kernel.request(`${cell.id}.g.test`, "/api/web")).status, 403);
    assert.equal((await kernel.api("PUT", `/workspaces/team/cells/${cell.id}/grants`, { grants: ["web:other.test:read"] }, { as: "alice" })).status, 400);
    ok(await kernel.api("PUT", `/workspaces/team/cells/${cell.id}/grants`, { grants: [WEB] }, { as: "alice" }));
    assert.deepEqual(JSON.parse(await cellPage(cell.id, "/api/web")), { status: 200 });
  });
});
