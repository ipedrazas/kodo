// Grants and capability bindings: what a gadget may call, and what the
// kernel asserts to the Gatekeeper when it does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { startKernel, user } from "./dev.mjs";

let kernel;
const REPO = "github:repo/acme/api:read";
const FIXTURE = new URL("./gadgets/capabilities.js", import.meta.url);

before(async () => {
  kernel = await startKernel({ gatekeeper: true });
  await kernel.api("PUT", "/workspaces/caps", { quota: 100 });
  const source = await kernel.api("POST", "/bundles", await readFile(FIXTURE));
  const declare = (version, capabilities) =>
    kernel.api("PUT", `/blueprints/caps/${version}`, { bundle: source.body.digest, capabilities });
  assert.equal((await declare("1", ["github:repo/acme/*:read", "github:repo/acme/api:write"])).status, 201);
  assert.equal((await declare("2", ["github:repo/other/*:read"])).status, 201);
});

after(async () => {
  await kernel?.stop();
});

const newCell = async (as = "alice") => (await kernel.createCell("caps", "caps", "1", as)).id;
const get = async (cell, path, as = "alice") => {
  const res = await kernel.request(`${cell}.g.test`, path, { as });
  return { status: res.status, body: res.status === 200 ? JSON.parse(res.body) : res.body };
};
const grant = (cell, grants, as = "alice") => kernel.api("PUT", `/workspaces/caps/cells/${cell}/grants`, { grants }, { as });
const q = encodeURIComponent;

describe("grants", () => {
  test("a cell starts with no grants and its gadget has no bindings", async () => {
    const cell = await newCell();
    assert.deepEqual((await kernel.api("GET", `/workspaces/caps/cells/${cell}/grants`, undefined, { as: "alice" })).body, {
      grants: [],
    });
    assert.deepEqual((await get(cell, "/grants")).body, []);
    assert.deepEqual((await get(cell, `/use?cap=${q(REPO)}`)).body, { binding: false });
  });

  test("the owner grants a subset of what the Blueprint declares, and the gadget gets one binding each", async () => {
    const cell = await newCell();
    const res = await grant(cell, [REPO, "github:repo/acme/web:read"]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.grants, ["github:repo/acme/api:read", "github:repo/acme/web:read"]);
    assert.deepEqual((await get(cell, "/grants")).body.sort(), [REPO, "github:repo/acme/web:read"]);
    const listed = (await kernel.api("GET", "/workspaces/caps/cells", undefined, { as: "alice" })).body.cells;
    assert.deepEqual(listed.find((c) => c.id === cell).grants.length, 2);
  });

  test("grants outside the declared capabilities, or with wildcards, are refused", async () => {
    const cell = await newCell();
    for (const bad of [
      ["github:repo/other/api:read"],
      ["github:repo/acme/api:admin"],
      ["github:repo/acme/api/x:read"],
      ["github:repo/acme/*:read"],
      ["nonsense"],
      "github:repo/acme/api:read",
    ]) {
      assert.equal((await grant(cell, bad)).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual((await get(cell, "/grants")).body, []);
  });

  test("only the owner sees and changes grants", async () => {
    const cell = await newCell();
    await kernel.api("PUT", `/workspaces/caps/cells/${cell}/shares/bob@test`, { role: "editor" }, { as: "alice" });
    assert.equal((await grant(cell, [REPO], "bob")).status, 403);
    assert.equal((await kernel.api("GET", `/workspaces/caps/cells/${cell}/grants`, undefined, { as: "bob" })).status, 403);
  });

  test("revoking removes the binding", async () => {
    const cell = await newCell();
    await grant(cell, [REPO]);
    assert.deepEqual((await get(cell, "/grants")).body, [REPO]);
    await grant(cell, []);
    assert.deepEqual((await get(cell, "/grants")).body, []);
  });

  test("moving to a version that does not declare a grant drops it", async () => {
    const cell = await newCell();
    await grant(cell, [REPO]);
    const moved = await kernel.api("PATCH", `/workspaces/caps/cells/${cell}`, { version: "2" }, { as: "alice" });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.grants, []);
    assert.deepEqual((await get(cell, "/grants")).body, []);
  });
});

describe("calls through a binding", () => {
  test("go to the Gatekeeper signed, with the cell, its owner and its grants", async () => {
    const cell = await newCell();
    await grant(cell, [REPO]);
    const res = await get(cell, `/use?cap=${q(REPO)}&path=${q("/readme?ref=main")}`);
    assert.equal(res.body.status, 200);
    const seen = JSON.parse(res.body.body);
    assert.equal(seen.cell, cell);
    assert.equal(seen.workspace, "caps");
    assert.equal(seen.blueprint, "caps");
    assert.equal(seen.version, "1");
    assert.deepEqual(seen.owner, { user: user("alice").sub, email: "alice@test" });
    assert.deepEqual(seen.grants, [REPO]);
    assert.equal(seen.capability, REPO);
    assert.deepEqual(seen.request, { method: "GET", path: "/readme?ref=main", headers: { accept: "application/json" } });
    assert.equal(kernel.gatekeeper.rejected(), 0);
  });

  test("use the owner's grants and identity whoever is calling", async () => {
    const cell = await newCell();
    await grant(cell, [REPO]);
    await kernel.api("PUT", `/workspaces/caps/cells/${cell}/shares/bob@test`, { role: "viewer" }, { as: "alice" });
    const seen = JSON.parse((await get(cell, `/use?cap=${q(REPO)}`, "bob")).body.body);
    assert.equal(seen.owner.email, "alice@test");
  });

  test("for a capability the cell was not granted, still carry only the actual grants", async () => {
    const cell = await newCell();
    await grant(cell, [REPO]);
    const other = "github:repo/other/x:read";
    const seen = JSON.parse((await get(cell, `/raw?cap=${q(other)}`)).body.body);
    assert.equal(seen.capability, other);
    assert.deepEqual(seen.grants, [REPO]);
  });

  test("can run concurrently, from the first call of a fresh gadget", async () => {
    const cell = await newCell();
    await grant(cell, [REPO]);
    assert.deepEqual((await get(cell, `/burst?cap=${q(REPO)}&n=4`)).body, [200, 200, 200, 200]);
  });

  test("cannot be made for another cell", async () => {
    const victim = await newCell();
    await grant(victim, [REPO]);
    const before = kernel.gatekeeper.calls.length;
    const res = (await get(await newCell(), `/forge?cell=${victim}&cap=${q(REPO)}`)).body;
    assert.equal(res.forged, "rejected");
    assert.equal(kernel.gatekeeper.calls.length, before);
  });
});

describe("without a Gatekeeper", () => {
  let bare;
  before(async () => {
    bare = await startKernel();
  });
  after(async () => {
    await bare?.stop();
  });

  test("a binding answers 503", async () => {
    await bare.api("PUT", "/workspaces/caps", {});
    const digest = (await bare.api("POST", "/bundles", await readFile(FIXTURE))).body.digest;
    await bare.api("PUT", "/blueprints/caps/1", { bundle: digest, capabilities: [REPO] });
    const cell = (await bare.createCell("caps", "caps", "1")).id;
    await bare.api("PUT", `/workspaces/caps/cells/${cell}/grants`, { grants: [REPO] }, { as: "alice" });
    const res = JSON.parse((await bare.request(`${cell}.g.test`, `/use?cap=${q(REPO)}`)).body);
    assert.equal(res.status, 503);
    assert.match(res.body, /no Gatekeeper/);
  });
});
