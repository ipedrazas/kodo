// The settings page and what it needs from the API: the fleet's workspaces
// and the versions a user's agent wrote.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startKernel } from "./dev.mjs";

let kernel;

before(async () => {
  kernel = await startKernel({ gatekeeper: true });
  await kernel.workspace("team", { quota: 10 });
  await kernel.workspace("lab", { quota: 10 });
});

after(async () => {
  await kernel?.stop();
});

test("the settings page is served on the app host to a user", async () => {
  const page = await kernel.request("app.test", "/settings/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Settings · kodo<\/title>/);
  const bare = await kernel.request("app.test", "/settings?workspace=team");
  assert.equal(bare.status, 301);
  assert.equal((await kernel.request("app.test", "/settings/", { as: null })).status, 401);
  // Not on a cell's host.
  assert.notEqual((await kernel.request("c123456789012.g.test", "/settings/")).body, page.body);
});

test("lists the workspaces the fleet knows", async () => {
  const res = await kernel.api("GET", "/workspaces", undefined, { as: "alice" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.workspaces.filter((w) => ["lab", "team"].includes(w)), ["lab", "team"]);
});

test("lists the versions the caller's agent wrote, and only theirs", async () => {
  const s = (await kernel.api("POST", "/workspaces/team/sessions", { grants: [] }, { as: "alice" })).body;
  const source = `import { Gadget } from "kodo";
export class App extends Gadget { async fetch() { return new Response("hi"); } }`;
  for (const name of ["alpha", "alpha", "beta"]) {
    const res = await kernel.api("POST", `/workspaces/team/sessions/${s.id}/drafts`, { name, source }, { as: "alice" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  await kernel.api("POST", "/blueprints/alpha/1/publish", undefined, { as: "alice" });
  const mine = await kernel.api("GET", "/blueprints?author=me", undefined, { as: "alice" });
  assert.deepEqual(
    mine.body.versions.map((v) => [v.name, v.version, v.status]),
    [["beta", "1", "draft"], ["alpha", "2", "draft"], ["alpha", "1", "published"]],
  );
  const bobs = await kernel.api("GET", "/blueprints?author=me", undefined, { as: "bob" });
  assert.deepEqual(bobs.body.versions, []);
});
