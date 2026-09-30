import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startKernel } from "./dev.mjs";

const TIMEOUT_MS = 2000;
const CPU_MS = 500;
const IDLE_EVICT_S = 2;

let kernel;
let fixture;

before(async () => {
  kernel = await startKernel({
    vars: { GADGET_CALL_TIMEOUT_MS: String(TIMEOUT_MS), GADGET_CPU_MS: String(CPU_MS) },
    env: { CELLD_IDLE_EVICT_S: String(IDLE_EVICT_S) },
  });
  fixture = await kernel.putBundle("fixture.js");
});

after(async () => {
  await kernel?.stop();
});

const get = async (cell, query = "") => kernel.request(`${cell}.g.test`, `/${query}`);
const json = async (cell, query) => {
  const res = await get(cell, query);
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
};

describe("routing", () => {
  test("serves a bundle at its cell hostname", async () => {
    await kernel.bindCell("route-a", fixture);
    assert.deepEqual(await json("route-a"), { n: 1, cell: null });
  });

  test("answers 404 for a host that is not a cell", async () => {
    assert.equal((await kernel.request("app.example.test", "/")).status, 404);
  });

  test("uses the hostname, not a client-supplied cell header", async () => {
    await kernel.bindCell("route-b", fixture);
    await kernel.bindCell("route-c", fixture);
    await json("route-c");
    const res = await kernel.request("route-b.g.test", "/", { headers: { "x-kodo-cell": "route-c" } });
    assert.equal(JSON.parse(res.body).n, 1, "route-b answered with route-c's state");
  });
});

describe("state", () => {
  test("two cells of one bundle keep separate state", async () => {
    await kernel.bindCell("state-a", fixture);
    await kernel.bindCell("state-b", fixture);
    await json("state-a");
    assert.equal((await json("state-a")).n, 2);
    assert.equal((await json("state-b")).n, 1);
  });

  test("an idle cell keeps its state across hibernation", async () => {
    await kernel.bindCell("idle", fixture);
    await json("idle");
    const logged = kernel.logs().length;
    await new Promise((r) => setTimeout(r, (IDLE_EVICT_S + 4) * 1000));
    // celld logs this event when it snapshots a cell to evict it.
    assert.match(kernel.logs().slice(logged), /event="eviction_durability_barrier"/);
    assert.equal((await json("idle")).n, 2);
  });
});

describe("isolation", () => {
  test("the gadget sees no bindings and cannot reach the network", async () => {
    await kernel.bindCell("probe", fixture);
    assert.deepEqual(await json("probe", "?probe"), { bindings: [], outbound: "blocked" });
  });
});

describe("failures", () => {
  test("an unknown cell is a 404", async () => {
    const res = await get("nobody");
    assert.equal(res.status, 404);
    assert.match(res.body, /cell nobody does not exist/);
  });

  test("a missing bundle is a 502 naming the digest", async () => {
    const digest = "0".repeat(64);
    await kernel.bindCell("missing", digest);
    const res = await get("missing");
    assert.equal(res.status, 502);
    assert.match(res.body, new RegExp(`bundle ${digest} not found`));
  });

  test("a bundle without an App class is a 502", async () => {
    await kernel.bindCell("no-app", await kernel.putBundle("no-app.js"));
    assert.equal((await get("no-app")).status, 502);
  });

  test("a gadget that throws is a 502 and other cells keep working", async () => {
    await kernel.bindCell("thrower", fixture);
    await kernel.bindCell("bystander", fixture);
    const res = await get("thrower", "?throw");
    assert.equal(res.status, 502);
    assert.match(res.body, /fixture failure/);
    assert.equal((await json("bystander")).n, 1);
    assert.equal((await json("thrower")).n, 1);
  });

  test("a gadget that exceeds its CPU limit is stopped, and the cell recovers", async () => {
    await kernel.bindCell("spinner", fixture);
    await json("spinner");
    const started = Date.now();
    const res = await get("spinner", "?spin");
    assert.ok([502, 504].includes(res.status), `${res.status} ${res.body}`);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.equal((await json("spinner")).n, 2);
  });

  test("a gadget that hangs is a 504 within the limit, and the cell recovers", async () => {
    await kernel.bindCell("hanger", fixture);
    await json("hanger");
    const started = Date.now();
    const res = await get("hanger", "?hang");
    assert.equal(res.status, 504);
    assert.ok(Date.now() - started < TIMEOUT_MS + 3000, `took ${Date.now() - started} ms`);
    assert.equal((await json("hanger")).n, 2);
  });
});

describe("websockets", () => {
  test("messages reach the gadget through the cell", async () => {
    await kernel.bindCell("socket", fixture);
    const ws = kernel.socket("socket.g.test");
    await ws.opened;
    ws.send("hello");
    assert.deepEqual(JSON.parse(await ws.next()), { n: 1, echo: "hello" });
    ws.send("again");
    assert.deepEqual(JSON.parse(await ws.next()), { n: 2, echo: "again" });
    ws.close();
  });

  test("a gadget without onMessage closes the socket with 4011", async () => {
    await kernel.bindCell("http-only", await kernel.putBundle("http-only.js"));
    const ws = kernel.socket("http-only.g.test");
    await ws.opened;
    ws.send("hello");
    assert.equal((await ws.closed).code, 4011);
  });
});
