// Gadgets that send on their cell's sockets unprompted: from any handler,
// to one socket, a list or all of them, within limits, and only their own.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { startKernel } from "./dev.mjs";

const IDLE_EVICT_S = 2;
const CAPABILITY = "web:example.com:read";

let kernel;

before(async () => {
  kernel = await startKernel({ env: { CELLD_IDLE_EVICT_S: String(IDLE_EVICT_S) } });
  await kernel.workspace("push", { quota: 100 });
  const digest = (await kernel.api("POST", "/bundles", await readFile(new URL("./gadgets/push.js", import.meta.url)))).body.digest;
  assert.equal((await kernel.api("PUT", "/blueprints/push/1", { bundle: digest, capabilities: [CAPABILITY] })).status, 201);
  await kernel.publish("test/gadgets/fixture.js", "fixture", "1");
});

after(async () => {
  await kernel?.stop();
});

const newCell = async () => (await kernel.createCell("push", "push", "1")).id;
const share = (cell, who, role = "editor") =>
  kernel.api("PUT", `/workspaces/push/cells/${cell}/shares/${who}@test`, { role }, { as: "alice" });

const call = async (cell, path, { method = "POST", body, as } = {}) => {
  const res = await kernel.request(`${cell}.g.test`, path, { method, body, as, headers: { origin: `http://${cell}.g.test` } });
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
};

// Opens a socket and reads the greeting onOpen sends: {opened, user, email, role}.
async function open(cell, as = "alice") {
  const ws = kernel.socket(`${cell}.g.test`, { as });
  await ws.opened;
  const hello = JSON.parse(await ws.next());
  return { ...ws, id: hello.opened, hello, json: async () => JSON.parse(await ws.next()) };
}

// A message that a socket was not sent: a marker pushed after it arrives first.
async function nothingFor(cell, ws) {
  await call(cell, `/push?to=${ws.id}`, { body: "marker" });
  assert.equal(await ws.next(), "marker");
}

const until = async (fn, what, ms = 15_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

describe("send", () => {
  test("a message on one socket reaches another, of another user", async () => {
    const cell = await newCell();
    await share(cell, "bob");
    const a = await open(cell);
    const b = await open(cell, "bob");
    a.send(JSON.stringify({ to: [b.id], text: "hi bob" }));
    assert.deepEqual(await b.json(), { from: a.id, text: "hi bob" });
    assert.deepEqual(await a.json(), { sent: 1 });
    a.close();
    b.close();
  });

  test("fetch sends on an open socket", async () => {
    const cell = await newCell();
    const a = await open(cell);
    assert.deepEqual(await call(cell, `/push?to=${a.id}`, { body: "from fetch" }), { sent: 1 });
    assert.equal(await a.next(), "from fetch");
    a.close();
  });

  test("sends during onMessage go out before its reply", async () => {
    const cell = await newCell();
    const a = await open(cell);
    a.send(JSON.stringify({ self: "first" }));
    assert.deepEqual(await a.json(), { self: "first" });
    assert.deepEqual(await a.json(), { answered: "first" });
    a.close();
  });

  test("an unknown id, or another cell's socket, is skipped", async () => {
    const [cell, other] = [await newCell(), await newCell()];
    const theirs = await open(other);
    assert.deepEqual(await call(cell, "/push?to=nope", { body: "x" }), { sent: 0 });
    assert.deepEqual(await call(cell, `/push?to=${theirs.id}`, { body: "x" }), { sent: 0 });
    assert.deepEqual(await call(cell, "/broadcast", { body: "x" }), { sent: 0 });
    await nothingFor(other, theirs);
    theirs.close();
  });

  test("a gadget cannot list, send on or close another cell's sockets", async () => {
    const [cell, victim] = [await newCell(), await newCell()];
    const theirs = await open(victim);
    assert.deepEqual(await call(cell, `/forge?cell=${victim}`, { method: "GET" }), {
      sockets: "rejected",
      send: "rejected",
      close: "rejected",
    });
    await nothingFor(victim, theirs);
    theirs.close();
  });

  test("a closed socket is skipped and no longer listed", async () => {
    const cell = await newCell();
    const [a, b] = [await open(cell), await open(cell)];
    a.close();
    await a.closed;
    const closed = await until(async () => (await call(cell, "/closed", { method: "GET" })).find((c) => c.socket === a.id), "onClose");
    assert.equal(closed.listed, false, "onClose still found the socket in sockets()");
    assert.deepEqual(await call(cell, `/push?to=${a.id}&to=${b.id}`, { body: "x" }), { sent: 1 });
    assert.deepEqual((await call(cell, "/sockets", { method: "GET" })).map((s) => s.socket), [b.id]);
    b.close();
  });

  test("sockets() lists each socket with who opened it and when", async () => {
    const cell = await newCell();
    await share(cell, "bob");
    const before = Date.now();
    const [a, b] = [await open(cell), await open(cell, "bob")];
    const list = await call(cell, "/sockets", { method: "GET" });
    const byId = Object.fromEntries(list.map((s) => [s.socket, s]));
    assert.equal(list.length, 2);
    assert.deepEqual({ ...byId[a.id], openedAt: 0 }, { socket: a.id, user: "sub-alice", email: "alice@test", role: "owner", openedAt: 0 });
    assert.deepEqual({ ...byId[b.id], openedAt: 0 }, { socket: b.id, user: "sub-bob", email: "bob@test", role: "editor", openedAt: 0 });
    assert.ok(byId[a.id].openedAt >= before - 1000 && byId[a.id].openedAt <= Date.now());
    a.close();
    b.close();
  });
});

describe("broadcast, onOpen and close", () => {
  test("broadcast reaches every socket but the excepted ones", async () => {
    const cell = await newCell();
    const [a, b, c] = [await open(cell), await open(cell), await open(cell)];
    assert.deepEqual(await call(cell, `/broadcast?except=${a.id}`, { body: "all but a" }), { sent: 2 });
    assert.equal(await b.next(), "all but a");
    assert.equal(await c.next(), "all but a");
    await nothingFor(cell, a);
    a.send(JSON.stringify({ broadcast: "from a" }));
    assert.deepEqual(await b.json(), { from: a.id, text: "from a" });
    assert.deepEqual(await c.json(), { from: a.id, text: "from a" });
    assert.deepEqual(await a.json(), { sent: 2 });
    for (const ws of [a, b, c]) ws.close();
  });

  test("onOpen gets the caller, and its send arrives", async () => {
    const cell = await newCell();
    await share(cell, "bob");
    const b = await open(cell, "bob");
    assert.deepEqual(b.hello, { opened: b.id, user: "sub-bob", email: "bob@test", role: "editor" });
    b.close();
  });

  test("an onOpen that throws closes the socket with 4011", async () => {
    const cell = await newCell();
    await call(cell, "/fail-open");
    const ws = kernel.socket(`${cell}.g.test`);
    await ws.opened;
    const closed = await ws.closed;
    assert.equal(closed.code, 4011);
    assert.match(closed.reason, /onOpen refused/);
  });

  test("a gadget that does not extend Gadget keeps its sockets", async () => {
    const ws = kernel.socket(`${(await kernel.createCell("push", "fixture", "1")).id}.g.test`);
    await ws.opened;
    ws.send("hello");
    assert.deepEqual(JSON.parse(await ws.next()), { n: 1, echo: "hello", role: "owner" });
    ws.close();
  });

  test("onAlarm broadcasts", async () => {
    const cell = await newCell();
    const [a, b] = [await open(cell), await open(cell)];
    await call(cell, "/alarm?in=300");
    assert.deepEqual(await a.json(), { alarm: true });
    assert.deepEqual(await b.json(), { alarm: true });
    a.close();
    b.close();
  });

  test("closeSocket closes with the code and reason, and onClose follows", async () => {
    const cell = await newCell();
    const a = await open(cell);
    assert.deepEqual(await call(cell, `/close?socket=${a.id}&code=4000&reason=bye`), { sent: true });
    assert.deepEqual(await a.closed, { code: 4000, reason: "bye" });
    await until(async () => (await call(cell, "/closed", { method: "GET" })).some((c) => c.socket === a.id), "onClose");
    assert.deepEqual(await call(cell, `/close?socket=${a.id}`), { sent: false });
    assert.match((await call(cell, `/close?socket=x&code=1006`)).error, /close code/);
  });
});

describe("limits", () => {
  test("a message over 1 MiB and a send to over 1000 sockets are refused", async () => {
    const cell = await newCell();
    const a = await open(cell);
    assert.match((await call(cell, "/big")).error, /larger than 1 MiB/);
    assert.match((await call(cell, "/many")).error, /more than 1000 sockets/);
    await nothingFor(cell, a);
    a.close();
  });

  test("pushed frames are counted in the cell's usage, replies are not", async () => {
    const cell = await newCell();
    const [a, b] = [await open(cell), await open(cell)];
    a.send(JSON.stringify({ to: [b.id], text: "one" }));
    await b.next();
    await a.next();
    await call(cell, "/broadcast", { body: "two" });
    await Promise.all([a.next(), b.next()]);
    const row = (await kernel.api("GET", "/workspaces/push/usage")).body.cells.find((c) => c.id === cell);
    // Two greetings from onOpen, one send and a broadcast to two.
    assert.equal(row.pushed, 5);
    a.close();
    b.close();
  });

  test("50 sockets broadcasting at once all hear each other", async () => {
    const cell = await newCell();
    const sockets = await Promise.all(Array.from({ length: 50 }, () => open(cell)));
    for (const ws of sockets) ws.send(JSON.stringify({ broadcast: ws.id }));
    await Promise.all(
      sockets.map(async (ws) => {
        const heard = new Set();
        let answered = false;
        while (heard.size < 49 || !answered) {
          const m = await ws.json();
          assert.equal(m.error, undefined);
          if ("sent" in m) {
            assert.equal(m.sent, 49);
            answered = true;
          } else {
            heard.add(m.from);
          }
        }
        assert.ok(!heard.has(ws.id));
      }),
    );
    for (const ws of sockets) ws.close();
  });

  test("a cell holds 1000 sockets, broadcasts to them in one call, and refuses the next", async () => {
    const cell = await newCell();
    const sockets = [];
    // celld refuses a cell more than 64 requests at once.
    for (let i = 0; i < 1000; i += 50) sockets.push(...(await Promise.all(Array.from({ length: 50 }, () => open(cell)))));
    const started = Date.now();
    assert.deepEqual(await call(cell, "/broadcast", { body: "to all" }), { sent: 1000 });
    const ms = Date.now() - started;
    await Promise.all(sockets.map(async (ws) => assert.equal(await ws.next(), "to all")));
    assert.ok(ms < 10_000, `broadcast took ${ms} ms`);
    const extra = kernel.socket(`${cell}.g.test`);
    await assert.rejects(extra.opened, /upgrade refused: 503/);
    for (const ws of sockets) ws.close();
  });
});

describe("socket ids last", () => {
  test("across a gadget restart for a grant change", async () => {
    const cell = await newCell();
    const a = await open(cell);
    const res = await kernel.api("PUT", `/workspaces/push/cells/${cell}/grants`, { grants: [CAPABILITY] }, { as: "alice" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await call(cell, `/push?to=${a.id}`, { body: "after restart" }), { sent: 1 });
    assert.equal(await a.next(), "after restart");
    a.close();
  });

  test("a ping is answered without reaching the gadget", async () => {
    const cell = await newCell();
    const a = await open(cell);
    // The fixture would fail on a message that is not JSON, closing the socket.
    a.send("ping");
    assert.equal(await a.next(), "pong");
    await nothingFor(cell, a);
    a.close();
  });

  test("across the cell's hibernation", async () => {
    const cell = await newCell();
    const a = await open(cell);
    const logged = kernel.logs().length;
    await new Promise((r) => setTimeout(r, (IDLE_EVICT_S + 4) * 1000));
    // celld logs this event when it snapshots a cell to evict it.
    assert.match(kernel.logs().slice(logged), /event="eviction_durability_barrier"/);
    assert.deepEqual(await call(cell, `/push?to=${a.id}`, { body: "after hibernation" }), { sent: 1 });
    assert.equal(await a.next(), "after hibernation");
    a.send(JSON.stringify({ self: "still here" }));
    assert.deepEqual(await a.json(), { self: "still here" });
    assert.deepEqual(await a.json(), { answered: "still here" });
    a.close();
  });
});
