// The repo viewer example (examples/repo-viewer) against a stand-in
// Gatekeeper that answers like GitHub.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startKernel } from "./dev.mjs";

const GRANT = "github:repo/acme/api:read";
let kernel;

const github = (call) => {
  const json = (body, status = 200) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (call.capability !== GRANT) return json({ error: "denied" }, 403);
  switch (call.request.path) {
    case "":
      return json({ full_name: "acme/api", description: "The API", private: true, stargazers_count: 3, open_issues_count: 1, default_branch: "main" });
    case "/readme":
      return { status: 200, headers: { "content-type": "text/plain" }, body: "# acme/api\n" };
    case "/commits?per_page=5":
      return json([{ sha: "0123456789", commit: { message: "First\n\nbody", author: { name: "Ada", date: "2026-09-30T00:00:00Z" } } }]);
    default:
      return json({ message: "Not Found" }, 404);
  }
};

before(async () => {
  kernel = await startKernel({ gatekeeper: github });
  await kernel.api("PUT", "/workspaces/examples", {});
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../../examples/repo-viewer/gadget.js", import.meta.url));
  const digest = (await kernel.api("POST", "/bundles", source)).body.digest;
  const res = await kernel.api("PUT", "/blueprints/repo-viewer/1.0.0", { bundle: digest, capabilities: ["github:repo/*/*:read"] });
  assert.equal(res.status, 201);
});

after(async () => {
  await kernel?.stop();
});

test("the repo viewer reads the repositories it is granted, and no others", async () => {
  const cell = (await kernel.createCell("examples", "repo-viewer")).id;
  const get = async (path) => {
    const res = await kernel.request(`${cell}.g.test`, path);
    return { status: res.status, body: res.body.startsWith("{") ? JSON.parse(res.body) : res.body };
  };
  assert.deepEqual((await get("/api/repos")).body.repos, []);
  assert.equal((await get("/api/repos/acme/api")).status, 403);

  const granted = await kernel.api("PUT", `/workspaces/examples/cells/${cell}/grants`, { grants: [GRANT] }, { as: "alice" });
  assert.equal(granted.status, 200);
  assert.deepEqual((await get("/api/repos")).body.repos, [{ owner: "acme", repo: "api", capability: GRANT }]);

  const repo = await get("/api/repos/acme/api");
  assert.equal(repo.status, 200);
  assert.equal(repo.body.name, "acme/api");
  assert.equal(repo.body.readme, "# acme/api\n");
  assert.deepEqual(repo.body.commits, [{ sha: "0123456", message: "First", author: "Ada", date: "2026-09-30T00:00:00Z" }]);
  const calls = kernel.gatekeeper.calls.length;
  assert.equal((await get("/api/repos/acme/api")).body.name, "acme/api");
  assert.equal(kernel.gatekeeper.calls.length, calls, "the second read was not served from the cache");

  assert.equal((await get("/api/repos/acme/other")).status, 403);
  assert.match((await get("/")).body, /<title>Repo viewer<\/title>/);
});
