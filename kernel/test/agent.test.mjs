// The agent's side of the kernel: sessions, turns and their tokens, model
// calls as the session, runs of the agent's code in ephemeral cells with
// exactly the session's grants, their limits and cleanup, approvals that
// outlive a run, and the workspace's docs.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startKernel, user } from "./dev.mjs";

const MODEL = "inference:model/agent:invoke";
const WEB = "web:example.test:read";
const SEND = "email:outbox:send";
const RUN_TIMEOUT_MS = 4000;
const RUN_CPU_MS = 1000;
const RUN_CALLS = 3;
const NOTES = "examples/notes.js";

let kernel;
let queued = 0;

// Plays the Gatekeeper: a canned completion for the model, a parked
// approval for a send, and the call itself for anything else.
function answer(call) {
  if (call.capability === MODEL) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", choices: [{ message: { role: "assistant", content: "hello" } }] }),
      usage: { model: "test-model", input: 11, output: 7, total: 18 },
    };
  }
  if (call.capability === SEND) {
    const id = `20261002t000000-${String(++queued).padStart(12, "0")}`;
    kernel.gatekeeper.approvals.set(id, { cell: call.cell, state: "pending", capability: call.capability });
    return {
      status: 202,
      headers: { "content-type": "application/json", "x-kodo-decision": "pending", "x-kodo-approval": id },
      body: JSON.stringify({ approval: { id, state: "pending" } }),
    };
  }
  return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(call) };
}

before(async () => {
  kernel = await startKernel({
    gatekeeper: answer,
    vars: {
      AGENT_RUN_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
      AGENT_RUN_CPU_MS: String(RUN_CPU_MS),
      AGENT_RUN_CALLS: String(RUN_CALLS),
    },
  });
  await kernel.workspace("team", { quota: 100 });
  await kernel.workspace("other", { quota: 100 });
});

after(async () => {
  await kernel?.stop();
});

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};

const session = async (grants = [MODEL], as = "alice", ws = "team") =>
  ok(await kernel.api("POST", `/workspaces/${ws}/sessions`, { grants }, { as }), 201);

const turn = async (s, content = "hi", as = "alice") =>
  ok(await kernel.api("POST", `/workspaces/team/sessions/${s.id}/turns`, { content }, { as }), 201).turn;

// Calls the API with a turn token.
const withTurn = (t, method, path, body) => kernel.api(method, path, body, { as: null, headers: { "x-kodo-turn": t.token } });

const run = async (s, code, input) =>
  ok(await kernel.api("POST", `/workspaces/team/sessions/${s.id}/runs`, { code, input }, { as: "alice" }));

async function waitFor(fn, what, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("sessions", () => {
  test("belong to their owner", async () => {
    const s = await session();
    assert.match(s.id, /^s[a-z2-7]{12}$/);
    assert.deepEqual(s.owner, { user: user("alice").sub, email: "alice@test" });
    assert.deepEqual(s.grants, [MODEL]);
    assert.equal(s.turn, null);
    const mine = ok(await kernel.api("GET", "/workspaces/team/sessions", undefined, { as: "alice" })).sessions;
    assert.ok(mine.some((x) => x.id === s.id));
    const bobs = ok(await kernel.api("GET", "/workspaces/team/sessions", undefined, { as: "bob" })).sessions;
    assert.ok(!bobs.some((x) => x.id === s.id));
    assert.equal((await kernel.api("GET", `/workspaces/team/sessions/${s.id}`, undefined, { as: "bob" })).status, 404);
    assert.equal((await kernel.api("POST", `/workspaces/team/sessions/${s.id}/runs`, { code: "return 1" }, { as: "bob" })).status, 404);
  });

  test("refuse grants that are not concrete capabilities", async () => {
    const res = await kernel.api("POST", "/workspaces/team/sessions", { grants: ["github:repo/*/*:read"] }, { as: "alice" });
    assert.equal(res.status, 400);
  });

  test("are deleted with their transcript", async () => {
    const s = await session();
    await kernel.api("DELETE", `/workspaces/team/sessions/${s.id}`, undefined, { as: "alice" });
    assert.equal((await kernel.api("GET", `/workspaces/team/sessions/${s.id}`, undefined, { as: "alice" })).status, 404);
  });
});

describe("turns", () => {
  test("take the owner's message, name the session and hand out a token for it", async () => {
    const s = await session();
    const res = ok(await kernel.api("POST", `/workspaces/team/sessions/${s.id}/turns`, { content: "  Count   the stars  " }, { as: "alice" }), 201);
    assert.match(res.turn.token, /^v1\./);
    assert.equal(res.session.title, "Count the stars");
    assert.equal(res.session.messages.at(-1).role, "user");
    assert.equal(res.session.messages.at(-1).content, "  Count   the stars  ");
    // One at a time.
    assert.equal((await kernel.api("POST", `/workspaces/team/sessions/${s.id}/turns`, { content: "again" }, { as: "alice" })).status, 409);
  });

  test("let only the agent write the transcript, with its token", async () => {
    const s = await session();
    const t = await turn(s);
    assert.equal((await kernel.api("POST", `/workspaces/team/sessions/${s.id}/messages`, { role: "assistant", content: "x" }, { as: "alice" })).status, 403);
    ok(await withTurn(t, "POST", `/workspaces/team/sessions/${s.id}/messages`, {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "run_code", arguments: '{"code":"return 1"}' } }],
    }), 201);
    ok(await withTurn(t, "POST", `/workspaces/team/sessions/${s.id}/messages`, { role: "tool", tool_call_id: "call_1", name: "run_code", content: "1" }), 201);
    assert.equal((await withTurn(t, "POST", `/workspaces/team/sessions/${s.id}/messages`, { role: "event", content: "forged" })).status, 400);
    const view = ok(await withTurn(t, "GET", `/workspaces/team/sessions/${s.id}?after=1`));
    assert.deepEqual(view.messages.map((m) => m.role), ["assistant", "tool"]);
    assert.equal(view.messages[0].tool_calls[0].function.name, "run_code");
  });

  test("tokens reach only their own session, never grants, cells or other turns", async () => {
    const s = await session();
    const other = await session();
    const t = await turn(s);
    const refused = [
      ["PUT", `/workspaces/team/sessions/${s.id}/grants`, { grants: [MODEL, WEB] }],
      ["POST", `/workspaces/team/sessions/${s.id}/turns`, { content: "more" }],
      ["DELETE", `/workspaces/team/sessions/${s.id}`],
      ["GET", `/workspaces/team/sessions/${other.id}`],
      ["POST", `/workspaces/team/sessions/${other.id}/runs`, { code: "return 1" }],
      ["GET", "/workspaces/team/sessions"],
      ["GET", "/workspaces/team/cells"],
      ["POST", "/workspaces/team/cells", { blueprint: "notes" }],
      ["PUT", "/workspaces/team/docs/x.md", "x"],
      ["GET", "/workspaces/other/docs"],
      ["GET", "/whoami"],
    ];
    for (const [method, path, body] of refused) {
      assert.equal((await withTurn(t, method, path, body)).status, 403, `${method} ${path}`);
    }
    // Nor any cell's own pages.
    await kernel.publish(NOTES, "notes", "1.0.0");
    const cell = await kernel.createCell("team", "notes", "1.0.0");
    const res = await kernel.request(`${cell.id}.g.test`, "/api/notes", { as: null, headers: { "x-kodo-turn": t.token } });
    assert.equal(res.status, 403);
    // A forged or altered token is not a token.
    const [v, payload, mac] = t.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), s: other.id })).toString("base64url");
    const bad = await kernel.api("GET", `/workspaces/team/sessions/${other.id}`, undefined, { as: null, headers: { "x-kodo-turn": `${v}.${forged}.${mac}` } });
    assert.equal(bad.status, 401);
  });

  test("tokens stop working when the turn ends", async () => {
    const s = await session();
    const t = await turn(s);
    ok(await withTurn(t, "GET", `/workspaces/team/sessions/${s.id}`));
    assert.equal((await withTurn(t, "DELETE", `/workspaces/team/sessions/${s.id}/turns/${t.id}`)).status, 204);
    assert.equal((await withTurn(t, "GET", `/workspaces/team/sessions/${s.id}`)).status, 401);
    // The owner can start the next one.
    await turn(s, "next");
  });

  test("the owner can end a stuck turn", async () => {
    const s = await session();
    const t = await turn(s);
    assert.equal((await kernel.api("DELETE", `/workspaces/team/sessions/${s.id}/turns/${t.id}`, undefined, { as: "alice" })).status, 204);
    assert.equal((await withTurn(t, "POST", `/workspaces/team/sessions/${s.id}/runs`, { code: "return 1" })).status, 401);
  });
});

describe("model calls", () => {
  test("go to the Gatekeeper as the session, within its grants, and are counted", async () => {
    const s = await session([MODEL, WEB]);
    const t = await turn(s);
    const request = { messages: [{ role: "user", content: "hi" }], max_tokens: 16 };
    const before = kernel.gatekeeper.calls.length;
    const res = await withTurn(t, "POST", `/workspaces/team/sessions/${s.id}/complete`, { model: "agent", request });
    assert.equal(res.status, 200);
    assert.equal(res.body.choices[0].message.content, "hello");
    const call = kernel.gatekeeper.calls.slice(before).find((c) => c.capability === MODEL);
    assert.equal(call.cell, s.id);
    assert.equal(call.blueprint, "agent");
    assert.equal(call.version, s.id);
    assert.equal(call.workspace, "team");
    assert.deepEqual(call.owner, s.owner);
    assert.deepEqual(call.grants, [MODEL, WEB]);
    assert.deepEqual(JSON.parse(Buffer.from(call.request.body, "base64")), request);

    const usage = ok(await kernel.api("GET", "/workspaces/team/usage", undefined, { as: "alice" }));
    const row = usage.cells.find((r) => r.id === s.id);
    assert.equal(row.kind, "session");
    assert.equal(row.blueprint, "agent");
    assert.deepEqual(row.inference.agent, { calls: 1, input: 11, output: 7, total: 18 });
    assert.ok(usage.totals.sessions >= 1);
    assert.ok(usage.totals.inference.total >= 18);
  });

  test("need the model's grant", async () => {
    const s = await session([WEB]);
    const res = await kernel.api("POST", `/workspaces/team/sessions/${s.id}/complete`, { model: "agent", request: { messages: [] } }, { as: "alice" });
    assert.equal(res.status, 403);
  });
});

describe("runs", () => {
  test("return the code's value and logs", async () => {
    const s = await session();
    const r = await run(s, `console.log("adding", input.a, input.b); return { sum: input.a + input.b, now: typeof Date.now(), r: typeof Math.random() };`, { a: 2, b: 3 });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, { sum: 5, now: "number", r: "number" });
    assert.deepEqual(r.logs, ["adding 2 3"]);
    assert.match(r.id, /^r[a-z2-7]{12}$/);
  });

  test("get exactly the session's grants", async () => {
    const s = await session([MODEL, WEB]);
    const r = await run(s, `return Object.keys(grants).sort();`);
    assert.deepEqual(r.value, [MODEL, WEB].sort());
    // A capability the session does not hold has no binding at all.
    const missing = await run(s, `return grants["github:repo/acme/api:read"] === undefined;`);
    assert.equal(missing.value, true);

    // What the code calls is asserted as the run, with the session's grants.
    const before = kernel.gatekeeper.calls.length;
    const used = await run(s, `const res = await grants["${WEB}"].fetch("/data?x=1", { headers: { accept: "application/json" } }); const call = await res.json(); return { status: res.status, ok: res.ok, decision: res.headers["x-kodo-decision"], cell: call.cell };`);
    assert.equal(used.ok, true, used.error);
    assert.equal(used.value.status, 200);
    assert.equal(used.value.cell, used.id);
    assert.equal(used.calls, 1);
    const call = kernel.gatekeeper.calls.slice(before)[0];
    assert.equal(call.cell, used.id);
    assert.equal(call.blueprint, "agent");
    assert.equal(call.version, s.id);
    assert.deepEqual(call.grants, [MODEL, WEB].sort());
    assert.equal(call.request.path, "/data?x=1");

    // A grant the owner takes away is gone from the next run.
    ok(await kernel.api("PUT", `/workspaces/team/sessions/${s.id}/grants`, { grants: [MODEL] }, { as: "alice" }));
    assert.deepEqual((await run(s, `return Object.keys(grants);`)).value, [MODEL]);
  });

  test("cannot reach the network, the runner or each other", async () => {
    const s = await session();
    const reach = await run(s, `
      let relock;
      try { lockdown(); relock = "locked down again"; } catch (err) { relock = err.message; }
      return { fetch: typeof fetch, env: typeof env, setTimeout: typeof setTimeout, Response: typeof Response,
        process: typeof process, relock, globals: Object.keys(globalThis).filter((k) => globalThis[k] !== undefined).sort(),
        builtins: [typeof Date.now(), typeof Math.random(), typeof crypto.randomUUID(), atob(btoa("ok"))] };`);
    assert.equal(reach.ok, true, reach.error);
    const { globals, relock, builtins, ...types } = reach.value;
    assert.deepEqual(types, { fetch: "undefined", env: "undefined", setTimeout: "undefined", Response: "undefined", process: "undefined" });
    // SES gives each compartment lockdown, harden and Compartment; lockdown
    // only refuses to run twice, and the others confer nothing.
    assert.match(relock, /ALREADY_LOCKED_DOWN/);
    // Besides the standard built-ins (Date and Math with now() and random()
    // among them), only what the runner gives.
    assert.deepEqual(globals, ["URL", "URLSearchParams", "atob", "btoa", "console", "crypto", "grants", "input"]);
    assert.deepEqual(builtins, ["number", "number", "string", "ok"]);

    // One run cannot leave anything for the next, even in the same isolate.
    const plant = await run(s, `
      globalThis.leak = "from an earlier run";
      const tried = [];
      for (const [name, f] of [
        ["Array.prototype", () => { Array.prototype.evil = 1; }],
        ["JSON.parse", () => { JSON.parse = () => "evil"; }],
        ["Promise.prototype.then", () => { Promise.prototype.then = () => {}; }],
        ["grants", () => { grants.x = 1; }],
        ["console.log", () => { console.log = () => {}; }],
        ["URL.prototype", () => { URL.prototype.toString = () => "evil"; }],
      ]) {
        try { f(); tried.push(name + " changed"); } catch { tried.push(name + " frozen"); }
      }
      return tried;`);
    assert.ok(plant.value.every((t) => t.endsWith("frozen")), JSON.stringify(plant.value));
    const look = await run(s, `return { leak: globalThis.leak ?? null, evil: [].evil ?? null };`);
    assert.deepEqual(look.value, { leak: null, evil: null });

    // Nor can it climb out through a constructor.
    for (const escape of [
      `return (function () {}).constructor("return globalThis")().lockdown;`,
      `return (async function () {}).constructor("return globalThis")();`,
      `return Object.getPrototypeOf(grants["${MODEL}"].fetch).constructor("return 1")();`,
    ]) {
      const r = await run(s, escape);
      assert.equal(r.ok, false, `${escape} => ${JSON.stringify(r.value)}`);
    }
  });

  test("get no memory outside the heap", async () => {
    // celld limits each isolate's heap, not ArrayBuffers, so the code gets
    // nothing that allocates them, nor any object that leads to one.
    const s = await session([WEB]);
    const r = await run(s, `
      const names = ["ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly", "TextEncoder", "TextDecoder",
        "Uint8Array", "Float64Array", "BigUint64Array"];
      const res = await grants["${WEB}"].fetch("/");
      return { globals: names.filter((n) => globalThis[n] !== undefined), response: Object.keys(res).sort(), crypto: Object.keys(crypto) };`);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, { globals: [], response: ["headers", "json", "ok", "status", "text"], crypto: ["randomUUID"] });
    const bomb = await run(s, `const a = []; for (let i = 0; i < 768; i++) a.push(new Uint8Array(1 << 20).fill(7)); return a.length;`);
    assert.equal(bomb.ok, false);
    assert.match(bomb.error, /Uint8Array is not a constructor|Uint8Array is not defined/);
  });

  test("report what went wrong", async () => {
    const s = await session();
    const thrown = await run(s, `throw new Error("nope");`);
    assert.equal(thrown.ok, false);
    assert.match(thrown.error, /nope/);
    const syntax = await run(s, `return ((;`);
    assert.equal(syntax.ok, false);
    assert.match(syntax.error, /SyntaxError/);
    const notJson = await run(s, `return 10n;`);
    assert.equal(notJson.ok, false);
    assert.match(notJson.error, /not JSON/);
    const huge = await run(s, `return "x".repeat(100000);`);
    assert.equal(huge.ok, false);
    assert.match(huge.error, /larger than/);
  });

  test("are stopped by the CPU limit without holding up other cells", async () => {
    const s = await session();
    await kernel.publish(NOTES, "notes", "1.0.1");
    const cell = await kernel.createCell("team", "notes", "1.0.1");
    // Load the notes gadget first, so the timing below is not its cold start.
    assert.equal((await kernel.request(`${cell.id}.g.test`, "/api/notes")).status, 200);

    const started = Date.now();
    const runaway = run(s, `while (true) {}`);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const other = await kernel.request(`${cell.id}.g.test`, "/api/notes");
    const otherMs = Date.now() - t0;
    const r = await runaway;
    assert.equal(other.status, 200);
    assert.ok(otherMs < RUN_CPU_MS, `another cell waited ${otherMs} ms during the runaway run`);
    assert.equal(r.ok, false);
    assert.match(r.error, /CPU/);
    assert.ok(Date.now() - started < RUN_CPU_MS + 3000, `the runaway run took ${Date.now() - started} ms`);
    // The runner keeps serving runs.
    assert.equal((await run(s, `return "after";`)).value, "after");
  });

  test("are stopped by the time limit", async () => {
    const s = await session();
    const started = Date.now();
    const r = await run(s, `await new Promise(() => {});`);
    assert.equal(r.ok, false);
    assert.match(r.error, /did not answer within/);
    assert.ok(Date.now() - started < RUN_TIMEOUT_MS + 3000);
    assert.equal((await run(s, `return "after";`)).value, "after");
  });

  test("are stopped by the call limit", async () => {
    const s = await session([WEB]);
    const r = await run(s, `const out = []; for (let i = 0; i < ${RUN_CALLS + 2}; i++) out.push((await grants["${WEB}"].fetch("/" + i)).status); return out;`);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, [...Array(RUN_CALLS).fill(200), 429, 429]);
    assert.equal(r.calls, RUN_CALLS);
  });

  test("leave nothing behind", async () => {
    const s = await session([WEB]);
    const r = await run(s, `await grants["${WEB}"].fetch("/"); return 1;`);
    assert.deepEqual(ok(await kernel.api("GET", `/runs/${r.id}`)), { bound: false, keys: 0 });
    assert.equal((await kernel.api("GET", `/runs/${r.id}`, undefined, { as: "alice" })).status, 403);
    // A run's cell is never served, during or after the run.
    assert.equal((await kernel.request(`${r.id}.g.test`, "/")).status, 404);
    const failed = await run(s, `while (true) {}`);
    assert.deepEqual(ok(await kernel.api("GET", `/runs/${failed.id}`)), { bound: false, keys: 0 });
  });

  test("queue side effects for approval, and the session reports the outcome", async () => {
    const s = await session([SEND]);
    const r = await run(s, `
      const res = await grants["${SEND}"].fetch("", { method: "POST", body: { to: "bob@example.com", subject: "Hi", text: "Hello" } });
      return { status: res.status, decision: res.headers["x-kodo-decision"], approval: res.headers["x-kodo-approval"] };`);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.status, 202);
    assert.equal(r.value.decision, "pending");
    assert.deepEqual(r.approvals, [{ id: r.value.approval, capability: SEND }]);
    const queuedCall = kernel.gatekeeper.calls.find((c) => c.cell === r.id);
    assert.deepEqual(JSON.parse(Buffer.from(queuedCall.request.body, "base64")), { to: "bob@example.com", subject: "Hi", text: "Hello" });
    assert.equal(queuedCall.request.headers["content-type"], "application/json");

    const view = ok(await kernel.api("GET", `/workspaces/team/sessions/${s.id}`, undefined, { as: "alice" }));
    assert.deepEqual(view.pending, [{ id: r.value.approval, cell: r.id, capability: SEND }]);

    // The run's cell is gone; the session follows the approval for it.
    kernel.gatekeeper.approvals.set(r.value.approval, {
      cell: r.id,
      state: "done",
      capability: SEND,
      result: { status: 200, body: '{"id":"email-1"}' },
    });
    const event = await waitFor(async () => {
      const v = ok(await kernel.api("GET", `/workspaces/team/sessions/${s.id}`, undefined, { as: "alice" }));
      return v.messages.find((m) => m.role === "event" && m.approval?.id === r.value.approval);
    }, "the approval's event");
    assert.equal(event.approval.state, "done");
    assert.equal(event.approval.status, 200);
    assert.equal(event.approval.body, '{"id":"email-1"}');
    assert.match(event.content, /approved and made/);
    const after = ok(await kernel.api("GET", `/workspaces/team/sessions/${s.id}`, undefined, { as: "alice" }));
    assert.deepEqual(after.pending, []);
  });
});

describe("docs", () => {
  test("are written with the admin token and read by anyone, including a turn", async () => {
    const doc = "---\ndescription: How we write emails\n---\n# Email\nBe brief.\n";
    ok(await kernel.api("PUT", "/workspaces/team/docs/skills/email.md", doc));
    ok(await kernel.api("PUT", "/workspaces/team/docs/about.md", "# About the team\n\nWe make things.\n"));
    assert.equal((await kernel.api("PUT", "/workspaces/team/docs/x.md", "x", { as: "alice" })).status, 403);
    assert.equal((await kernel.api("PUT", "/workspaces/team/docs/Bad%20Path.md", "x")).status, 400);
    assert.equal((await kernel.api("PUT", "/workspaces/team/docs/notes.txt", "x")).status, 400);

    const list = ok(await kernel.api("GET", "/workspaces/team/docs", undefined, { as: "alice" })).docs;
    assert.deepEqual(
      list.map(({ path, description }) => ({ path, description })),
      [
        { path: "about.md", description: "About the team" },
        { path: "skills/email.md", description: "How we write emails" },
      ],
    );
    const s = await session();
    const t = await turn(s);
    const res = await withTurn(t, "GET", "/workspaces/team/docs/skills/email.md");
    assert.equal(res.status, 200);
    assert.equal(res.body, doc);
    assert.equal((await withTurn(t, "GET", "/workspaces/team/docs/missing.md")).status, 404);

    assert.equal((await kernel.api("DELETE", "/workspaces/team/docs/about.md")).status, 204);
    assert.equal((await kernel.api("GET", "/workspaces/team/docs/about.md", undefined, { as: "alice" })).status, 404);
  });
});
