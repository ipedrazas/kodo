// How the kernel runs gadgets: routing, state, isolation, failures and
// WebSockets. The registry and API are covered in api.test.mjs.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startKernel } from "./dev.mjs";

const TIMEOUT_MS = 2000;
const CPU_MS = 500;
const IDLE_EVICT_S = 2;

let kernel;

before(async () => {
  kernel = await startKernel({
    vars: { GADGET_CALL_TIMEOUT_MS: String(TIMEOUT_MS), GADGET_CPU_MS: String(CPU_MS) },
    env: { CELLD_IDLE_EVICT_S: String(IDLE_EVICT_S) },
  });
  await kernel.api("PUT", "/workspaces/test", { quota: 1000 });
  await kernel.publish("test/gadgets/fixture.js", "fixture", "1");
  await kernel.publish("test/gadgets/no-app.js", "no-app", "1");
  await kernel.publish("test/gadgets/http-only.js", "http-only", "1");
});

after(async () => {
  await kernel?.stop();
});

const newCell = async (blueprint = "fixture") => (await kernel.createCell("test", blueprint)).id;
const get = async (cell, query = "") => kernel.request(`${cell}.g.test`, `/${query}`);
const json = async (cell, query) => {
  const res = await get(cell, query);
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
};

describe("routing", () => {
  test("serves a cell at its hostname", async () => {
    assert.deepEqual(await json(await newCell()), { n: 1, cell: null });
  });

  test("answers 404 for a host that is neither a cell nor the API", async () => {
    assert.equal((await kernel.request("app.example.test", "/")).status, 404);
  });

  test("uses the hostname, not a client-supplied cell header", async () => {
    const [a, b] = [await newCell(), await newCell()];
    await json(b);
    const res = await kernel.request(`${a}.g.test`, "/", { headers: { "x-kodo-cell": b } });
    assert.equal(JSON.parse(res.body).n, 1, "a answered with b's state");
  });
});

describe("state", () => {
  test("two cells of one blueprint keep separate state", async () => {
    const [a, b] = [await newCell(), await newCell()];
    await json(a);
    assert.equal((await json(a)).n, 2);
    assert.equal((await json(b)).n, 1);
  });

  test("an idle cell keeps its state across hibernation", async () => {
    const cell = await newCell();
    await json(cell);
    const logged = kernel.logs().length;
    await new Promise((r) => setTimeout(r, (IDLE_EVICT_S + 4) * 1000));
    // celld logs this event when it snapshots a cell to evict it.
    assert.match(kernel.logs().slice(logged), /event="eviction_durability_barrier"/);
    assert.equal((await json(cell)).n, 2);
  });
});

describe("isolation", () => {
  test("the gadget sees only the host binding and cannot reach the network", async () => {
    assert.deepEqual(await json(await newCell(), "?probe"), { bindings: ["KODO"], outbound: "blocked" });
  });
});

describe("failures", () => {
  test("a cell that no workspace has created is a 404", async () => {
    const res = await get("cnobodyhere");
    assert.equal(res.status, 404);
    assert.match(res.body, /cell cnobodyhere does not exist/);
  });

  test("a bundle without an App class is a 502", async () => {
    assert.equal((await get(await newCell("no-app"))).status, 502);
  });

  test("a gadget that throws is a 502 and other cells keep working", async () => {
    const [thrower, bystander] = [await newCell(), await newCell()];
    const res = await get(thrower, "?throw");
    assert.equal(res.status, 502);
    assert.match(res.body, /fixture failure/);
    assert.equal((await json(bystander)).n, 1);
    assert.equal((await json(thrower)).n, 1);
  });

  test("a gadget that exceeds its CPU limit is stopped, and the cell recovers", async () => {
    const cell = await newCell();
    await json(cell);
    const started = Date.now();
    const res = await get(cell, "?spin");
    assert.ok([502, 504].includes(res.status), `${res.status} ${res.body}`);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.equal((await json(cell)).n, 2);
  });

  test("a gadget that hangs is a 504 within the limit, and the cell recovers", async () => {
    const cell = await newCell();
    await json(cell);
    const started = Date.now();
    const res = await get(cell, "?hang");
    assert.equal(res.status, 504);
    assert.ok(Date.now() - started < TIMEOUT_MS + 3000, `took ${Date.now() - started} ms`);
    assert.equal((await json(cell)).n, 2);
  });
});

describe("websockets", () => {
  test("messages reach the gadget through the cell", async () => {
    const ws = kernel.socket(`${await newCell()}.g.test`);
    await ws.opened;
    ws.send("hello");
    assert.deepEqual(JSON.parse(await ws.next()), { n: 1, echo: "hello", role: "owner" });
    ws.send("again");
    assert.deepEqual(JSON.parse(await ws.next()), { n: 2, echo: "again", role: "owner" });
    ws.close();
  });

  test("a gadget without onMessage closes the socket with 4011", async () => {
    const ws = kernel.socket(`${await newCell("http-only")}.g.test`);
    await ws.opened;
    ws.send("hello");
    assert.equal((await ws.closed).code, 4011);
  });
});
