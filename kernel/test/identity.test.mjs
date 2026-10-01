// Identity, ownership and sharing: who may reach a cell or the API, what a
// gadget learns about its caller, and what a browser on another origin may do.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startKernel, user } from "./dev.mjs";

let kernel;

before(async () => {
  kernel = await startKernel();
  await kernel.api("PUT", "/workspaces/team", { quota: 100 });
  await kernel.publish("test/gadgets/fixture.js", "fixture", "1");
});

after(async () => {
  await kernel?.stop();
});

const get = (cell, query = "", options) => kernel.request(`${cell}.g.test`, `/${query}`, options);
const post = (cell, options) => kernel.request(`${cell}.g.test`, "/", { method: "POST", ...options });
const share = (cell, email, role, as = "alice") =>
  kernel.api("PUT", `/workspaces/team/cells/${cell}/shares/${email}`, { role }, { as });
const unshare = (cell, email, as = "alice") =>
  kernel.api("DELETE", `/workspaces/team/cells/${cell}/shares/${email}`, undefined, { as });

describe("identity", () => {
  let cell;
  before(async () => {
    cell = (await kernel.createCell("team", "fixture")).id;
  });

  const token = (claims, options) => ({ token: kernel.idp.token({ ...user("alice"), ...claims }, options) });

  test("a request without identity is refused", async () => {
    assert.equal((await get(cell, "", { as: null })).status, 401);
    assert.equal((await kernel.api("GET", "/version", undefined, { as: null })).status, 401);
  });

  test("an unsigned, wrongly signed or expired token is refused", async () => {
    const cases = {
      unsigned: token({}, { alg: "none" }),
      "signed by another key": token({}, { signWith: "other" }),
      expired: token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      "another issuer": token({ iss: "https://evil.test" }),
      "another audience": token({ aud: "someone-else" }),
      garbage: { token: "not.a.jwt" },
    };
    for (const [name, as] of Object.entries(cases)) {
      const res = await get(cell, "", { as });
      assert.equal(res.status, 401, `${name}: ${res.status} ${res.body}`);
    }
  });

  test("a valid token is accepted", async () => {
    assert.equal((await get(cell, "", { as: token({}) })).status, 200);
  });

  test("a wrong admin token is refused", async () => {
    const res = await kernel.api("GET", "/version", undefined, { as: null, headers: { "x-kodo-admin-token": "guess" } });
    assert.equal(res.status, 401);
  });

  test("a client cannot claim to be the admin through internal headers", async () => {
    const res = await kernel.api("PUT", "/workspaces/team", { quota: 1 }, {
      as: "bob",
      headers: { "x-kodo-caller": JSON.stringify({ kind: "admin" }) },
    });
    assert.equal(res.status, 403);
  });

  test("only the admin token publishes and configures", async () => {
    assert.equal((await kernel.api("POST", "/bundles", "export class App {}", { as: "alice" })).status, 403);
    assert.equal((await kernel.api("PUT", "/workspaces/team", { quota: 5 }, { as: "alice" })).status, 403);
  });

  test("whoami reports the verified caller", async () => {
    assert.deepEqual((await kernel.api("GET", "/whoami", undefined, { as: "alice" })).body, {
      kind: "user",
      ...{ user: "sub-alice", email: "alice@test" },
    });
  });
});

describe("ownership and sharing", () => {
  test("each user runs their own instance and cannot open the other's", async () => {
    const alices = (await kernel.createCell("team", "fixture", undefined, "alice")).id;
    const bobs = (await kernel.createCell("team", "fixture", undefined, "bob")).id;
    assert.equal((await get(alices, "", { as: "alice" })).status, 200);
    assert.equal((await get(bobs, "", { as: "bob" })).status, 200);
    assert.equal((await get(alices, "", { as: "bob" })).status, 403);
    assert.equal((await get(bobs, "", { as: "alice" })).status, 403);
  });

  test("a user lists only their own and shared cells", async () => {
    const mine = (await kernel.createCell("team", "fixture", undefined, "carol")).id;
    const { cells } = (await kernel.api("GET", "/workspaces/team/cells", undefined, { as: "carol" })).body;
    assert.deepEqual(cells.map((c) => c.id), [mine]);
    assert.equal((await kernel.api("GET", `/workspaces/team/cells/${mine}`, undefined, { as: "dave" })).status, 404);
  });

  test("a viewer can read but not write or open a socket", async () => {
    const cell = (await kernel.createCell("team", "fixture")).id;
    assert.equal((await share(cell, "bob@test", "viewer")).status, 200);
    assert.equal((await get(cell, "", { as: "bob" })).status, 200);
    assert.equal((await post(cell, { as: "bob" })).status, 403);
    await assert.rejects(kernel.socket(`${cell}.g.test`, { as: "bob" }).opened, /403/);
  });

  test("an editor can write, and revoking removes access", async () => {
    const cell = (await kernel.createCell("team", "fixture")).id;
    await share(cell, "bob@test", "editor");
    assert.equal((await post(cell, { as: "bob" })).status, 200);
    const listed = (await kernel.api("GET", "/workspaces/team/cells", undefined, { as: "bob" })).body.cells;
    assert.ok(listed.some((c) => c.id === cell));

    assert.equal((await unshare(cell, "bob@test")).status, 200);
    assert.equal((await get(cell, "", { as: "bob" })).status, 403);
    const after = (await kernel.api("GET", "/workspaces/team/cells", undefined, { as: "bob" })).body.cells;
    assert.ok(!after.some((c) => c.id === cell));
  });

  test("only the owner shares, moves or deletes a cell", async () => {
    const cell = (await kernel.createCell("team", "fixture")).id;
    await share(cell, "bob@test", "editor");
    assert.equal((await share(cell, "eve@test", "editor", "bob")).status, 403);
    assert.equal((await kernel.api("DELETE", `/workspaces/team/cells/${cell}`, undefined, { as: "bob" })).status, 403);
    assert.equal((await kernel.api("PATCH", `/workspaces/team/cells/${cell}`, { version: "1" }, { as: "bob" })).status, 403);
    assert.equal((await get(cell)).status, 200);
  });
});

describe("what the gadget sees", () => {
  test("the caller's identity, and no credential", async () => {
    const cell = (await kernel.createCell("team", "fixture")).id;
    await share(cell, "bob@test", "editor");
    const headers = JSON.parse(
      (
        await get(cell, "?whoami", {
          as: "bob",
          headers: { cookie: "kodo-id=secret; OauthHMAC-abc=secret; theme=dark" },
        })
      ).body,
    );
    assert.equal(headers["x-kodo-user"], "sub-bob");
    assert.equal(headers["x-kodo-email"], "bob@test");
    assert.equal(headers["x-kodo-role"], "editor");
    assert.equal(headers["x-kodo-identity"], undefined);
    assert.equal(headers["x-kodo-caller"], undefined);
    assert.equal(headers.cookie, "theme=dark");
  });
});

describe("origins", () => {
  let cell;
  before(async () => {
    cell = (await kernel.createCell("team", "fixture")).id;
  });

  test("a write from another origin is refused", async () => {
    const res = await post(cell, { headers: { origin: "https://someoneelse.g.test" } });
    assert.equal(res.status, 403);
  });

  test("a write from the cell's own origin, or with no origin, is allowed", async () => {
    assert.equal((await post(cell, { headers: { origin: `https://${cell}.g.test` } })).status, 200);
    assert.equal((await post(cell)).status, 200);
  });

  test("a read from another origin is allowed", async () => {
    assert.equal((await get(cell, "", { headers: { origin: "https://someoneelse.g.test" } })).status, 200);
  });

  test("a socket from another origin is refused", async () => {
    const ws = kernel.socket(`${cell}.g.test`, { headers: { origin: "https://someoneelse.g.test" } });
    await assert.rejects(ws.opened, /403/);
  });

  test("an API write from a cell's origin is refused", async () => {
    const res = await kernel.api("POST", "/workspaces/team/cells", { blueprint: "fixture" }, {
      as: "alice",
      headers: { origin: `https://${cell}.g.test` },
    });
    assert.equal(res.status, 403);
  });
});

describe("the app page", () => {
  test("is served to a logged-in user at the root of the app host", async () => {
    const res = await kernel.request("app.test", "/", { as: "alice" });
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>kodo<\/title>/);
  });

  test("needs an identity", async () => {
    assert.equal((await kernel.request("app.test", "/", { as: null })).status, 401);
  });
});
