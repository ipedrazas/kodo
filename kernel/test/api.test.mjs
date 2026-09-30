// The kernel API and the registries behind it: blueprints, workspaces and
// cells, and the sample gadget that uses the whole gadget API.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startKernel } from "./dev.mjs";

let kernel;

before(async () => {
  kernel = await startKernel();
});

after(async () => {
  await kernel?.stop();
});

const get = async (cell, path = "/") => kernel.request(`${cell}.g.test`, path);
const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 250));
  }
};

describe("blueprints", () => {
  test("a version is published once and listed", async () => {
    const upload = await kernel.api("POST", "/bundles", "export class App {}");
    assert.equal(upload.status, 201);
    const body = { bundle: upload.body.digest, capabilities: ["github:repo/acme/api:read"] };
    const first = await kernel.api("PUT", "/blueprints/listed/1.0.0", body);
    assert.equal(first.status, 201);
    assert.deepEqual(first.body.capabilities, ["github:repo/acme/api:read"]);
    assert.equal((await kernel.api("PUT", "/blueprints/listed/1.0.0", body)).status, 409);
    assert.ok((await kernel.api("GET", "/blueprints")).body.blueprints.includes("listed"));
    const versions = (await kernel.api("GET", "/blueprints/listed")).body.versions;
    assert.deepEqual(versions.map((v) => v.version), ["1.0.0"]);
  });

  test("publishing checks the bundle, version and capabilities", async () => {
    const digest = (await kernel.api("POST", "/bundles", "export class App {}")).body.digest;
    const put = (path, body) => kernel.api("PUT", path, body);
    assert.equal((await put("/blueprints/bad/1", { bundle: "0".repeat(64) })).status, 400);
    assert.equal((await put("/blueprints/bad/1", { bundle: "nope" })).status, 400);
    assert.equal((await put("/blueprints/bad/-1", { bundle: digest })).status, 400);
    assert.equal((await put("/blueprints/Bad/1", { bundle: digest })).status, 400);
    assert.equal((await put("/blueprints/bad/1", { bundle: digest, capabilities: ["everything"] })).status, 400);
    assert.equal((await kernel.api("GET", "/blueprints/bad")).status, 404);
  });
});

describe("workspaces and cells", () => {
  before(async () => {
    await kernel.api("PUT", "/workspaces/team", { quota: 100 });
    await kernel.publish("examples/notes.js", "notes", "1.0.0");
    await kernel.publish("test/gadgets/fixture.js", "multi", "1");
  });

  test("two cells from one blueprint are independent", async () => {
    const [a, b] = [await kernel.createCell("team", "notes"), await kernel.createCell("team", "notes")];
    assert.notEqual(a.id, b.id);
    assert.equal((await kernel.request(`${a.id}.g.test`, "/", { method: "POST", body: "only in a" })).status, 201);
    assert.deepEqual(JSON.parse((await get(a.id)).body), ["only in a"]);
    assert.deepEqual(JSON.parse((await get(b.id)).body), []);
  });

  test("a workspace lists its cells", async () => {
    const cell = await kernel.createCell("team", "notes", "1.0.0");
    const { cells } = (await kernel.api("GET", "/workspaces/team/cells")).body;
    assert.ok(cells.some((c) => c.id === cell.id && c.blueprint === "notes" && c.version === "1.0.0"));
    assert.deepEqual((await kernel.api("GET", `/workspaces/team/cells/${cell.id}`)).body, cell);
  });

  test("a new version does not change existing cells until they are moved", async () => {
    const old = await kernel.createCell("team", "multi");
    assert.equal(JSON.parse((await get(old.id)).body).n, 1);

    await kernel.publish("test/gadgets/http-only.js", "multi", "2");
    assert.equal(JSON.parse((await get(old.id)).body).n, 2, "the existing cell changed code");
    const fresh = await kernel.createCell("team", "multi");
    assert.equal(fresh.version, "2");
    assert.equal((await get(fresh.id)).body, "http only\n");

    const moved = await kernel.api("PATCH", `/workspaces/team/cells/${old.id}`, { version: "2" });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.version, "2");
    assert.equal((await get(old.id)).body, "http only\n");

    await kernel.api("PATCH", `/workspaces/team/cells/${old.id}`, { version: "1" });
    assert.equal(JSON.parse((await get(old.id)).body).n, 3, "the gadget lost its storage on the move");
  });

  test("moving to a version its blueprint does not have is a 404", async () => {
    const cell = await kernel.createCell("team", "notes");
    const res = await kernel.api("PATCH", `/workspaces/team/cells/${cell.id}`, { version: "2" });
    assert.equal(res.status, 404);
  });

  test("the quota caps a workspace's cells, and deleting frees room", async () => {
    await kernel.api("PUT", "/workspaces/small", { quota: 2 });
    const a = await kernel.createCell("small", "notes");
    await kernel.createCell("small", "notes");
    const over = await kernel.api("POST", "/workspaces/small/cells", { blueprint: "notes" });
    assert.equal(over.status, 409);
    assert.equal((await kernel.api("DELETE", `/workspaces/small/cells/${a.id}`)).status, 204);
    assert.equal((await kernel.api("POST", "/workspaces/small/cells", { blueprint: "notes" })).status, 201);
  });

  test("a deleted cell is no longer served", async () => {
    const cell = await kernel.createCell("team", "notes");
    assert.equal((await get(cell.id)).status, 200);
    assert.equal((await kernel.api("DELETE", `/workspaces/team/cells/${cell.id}`)).status, 204);
    assert.equal((await get(cell.id)).status, 404);
    assert.equal((await kernel.api("GET", `/workspaces/team/cells/${cell.id}`)).status, 404);
  });

  test("a workspace cannot see or delete another workspace's cells", async () => {
    await kernel.api("PUT", "/workspaces/other", {});
    const cell = await kernel.createCell("team", "notes");
    assert.equal((await kernel.api("GET", `/workspaces/other/cells/${cell.id}`)).status, 404);
    assert.equal((await kernel.api("DELETE", `/workspaces/other/cells/${cell.id}`)).status, 404);
    assert.equal((await get(cell.id)).status, 200);
  });

  test("cells need an existing workspace and blueprint", async () => {
    assert.equal((await kernel.api("POST", "/workspaces/nowhere/cells", { blueprint: "notes" })).status, 404);
    assert.equal((await kernel.api("POST", "/workspaces/team/cells", { blueprint: "nothing" })).status, 404);
    assert.equal(
      (await kernel.api("POST", "/workspaces/team/cells", { blueprint: "notes", version: "9.9.9" })).status,
      404,
    );
  });
});

describe("the gadget API", () => {
  let cell;

  before(async () => {
    await kernel.api("PUT", "/workspaces/sample", {});
    await kernel.publish("examples/notes.js", "sample-notes", "1.0.0");
    cell = (await kernel.createCell("sample", "sample-notes")).id;
  });

  test("HTTP and storage", async () => {
    await kernel.request(`${cell}.g.test`, "/", { method: "POST", body: "first" });
    await kernel.request(`${cell}.g.test`, "/", { method: "POST", body: "second" });
    assert.deepEqual(JSON.parse((await get(cell)).body), ["second", "first"]);
  });

  test("the gadget knows its cell id", async () => {
    assert.equal(JSON.parse((await get(cell, "/status")).body).cell, cell);
  });

  test("WebSocket messages and closes reach the gadget", async () => {
    const before = JSON.parse((await get(cell, "/status")).body);
    const ws = kernel.socket(`${cell}.g.test`);
    await ws.opened;
    ws.send("from a socket");
    assert.deepEqual(JSON.parse(await ws.next()), { notes: before.notes + 1 });
    ws.close();
    await until(async () => JSON.parse((await get(cell, "/status")).body).closed === before.closed + 1);
  });

  test("an alarm the gadget sets is delivered by the cell", async () => {
    assert.equal((await kernel.request(`${cell}.g.test`, "/remind?in=500", { method: "POST" })).status, 202);
    await until(async () => JSON.parse((await get(cell, "/status")).body).reminders === 1);
  });

  test("a gadget cannot act for another cell", async () => {
    await kernel.publish("test/gadgets/fixture.js", "forger", "1");
    const forger = (await kernel.createCell("sample", "forger")).id;
    const res = JSON.parse((await get(forger, `/?forge=${cell}`)).body);
    assert.equal(res.forged, "rejected");
  });
});
