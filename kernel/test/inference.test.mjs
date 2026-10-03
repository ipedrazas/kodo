// Model calls through an inference grant, and the workspace usage report,
// with the ask example (examples/ask) against a stand-in Gatekeeper that
// answers chat completions as the inference gateway does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startKernel, user } from "./dev.mjs";

const DEFAULT = "inference:model/default:invoke";
const SMALL = "inference:model/small:invoke";
let kernel;
let overBudget = false;

function gateway(call) {
  if (overBudget) {
    return {
      status: 429,
      headers: { "content-type": "application/json", "x-ratelimit-reset": "60" },
      body: '{"error":"over the inference budget"}',
      usage: undefined,
    };
  }
  const request = JSON.parse(Buffer.from(call.request.body, "base64").toString());
  const last = request.messages.at(-1).content;
  const input = request.messages.length * 10;
  const model = call.capability === SMALL ? "backend-small" : "backend-default";
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      choices: [{ message: { role: "assistant", content: `you said: ${last}` } }],
      usage: { prompt_tokens: input, completion_tokens: 5, total_tokens: input + 5 },
    }),
    usage: { model, input, output: 5, total: input + 5 },
  };
}

before(async () => {
  kernel = await startKernel({ gatekeeper: gateway });
  await kernel.workspace("team", {});
  const source = await readFile(new URL("../../examples/ask/gadget.js", import.meta.url));
  const digest = (await kernel.api("POST", "/bundles", source)).body.digest;
  const res = await kernel.api("PUT", "/blueprints/ask/1.0.0", { bundle: digest, capabilities: ["inference:model/*:invoke"] });
  assert.equal(res.status, 201);
});

after(async () => {
  await kernel?.stop();
});

const chat = async (cell, body, as = "alice") => {
  const res = await kernel.request(`${cell}.g.test`, "/api/chat", body === undefined ? { as } : {
    as,
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: `http://${cell}.g.test` },
  });
  return { status: res.status, body: res.body.startsWith("{") ? JSON.parse(res.body) : res.body };
};
const usage = async (query = "", as = "admin") => kernel.api("GET", `/workspaces/team/usage${query}`, undefined, { as });

test("a gadget asks a granted model and keeps the conversation; the model is the grant's", async () => {
  const cell = (await kernel.createCell("team", "ask")).id;
  assert.equal((await chat(cell, { prompt: "hello" })).status, 403);

  const granted = await kernel.api("PUT", `/workspaces/team/cells/${cell}/grants`, { grants: [DEFAULT, SMALL] }, { as: "alice" });
  assert.equal(granted.status, 200);
  assert.deepEqual((await chat(cell)).body.models.sort(), ["default", "small"]);

  const first = await chat(cell, { prompt: "hello", model: "default" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.content, "you said: hello");
  assert.equal(first.body.backend, "backend-default");
  assert.deepEqual(first.body.tokens, { input: 10, output: 5 });

  const second = await chat(cell, { prompt: "and again", model: "small" });
  assert.equal(second.body.backend, "backend-small");
  assert.equal((await chat(cell, { prompt: "x", model: "big" })).status, 403);

  const calls = kernel.gatekeeper.calls.filter((c) => c.cell === cell);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.capability), [DEFAULT, SMALL]);
  for (const c of calls) {
    assert.equal(c.request.method, "POST");
    assert.equal(c.request.path, "/chat/completions");
    assert.equal(c.owner.user, user("alice").sub);
    assert.equal(c.workspace, "team");
  }
  // The second question carries the conversation so far.
  const sent = JSON.parse(Buffer.from(calls[1].request.body, "base64").toString());
  assert.deepEqual(sent.messages.map((m) => m.content), ["hello", "you said: hello", "and again"]);
});

test("a call over budget reaches the gadget as a 429 and is not counted", async () => {
  const cell = (await kernel.createCell("team", "ask", undefined, "bob")).id;
  await kernel.api("PUT", `/workspaces/team/cells/${cell}/grants`, { grants: [DEFAULT] }, { as: "bob" });
  overBudget = true;
  try {
    const res = await chat(cell, { prompt: "hello" }, "bob");
    assert.equal(res.status, 429);
    assert.match(res.body.error, /budget/);
  } finally {
    overBudget = false;
  }
  const report = await usage("", "bob");
  assert.equal(report.body.totals.inference.calls, 0);
  assert.equal(report.body.totals.requests, 1);
});

test("the usage report counts requests, tokens and storage per cell, per owner and for the workspace", async () => {
  // Measured a few seconds after the cell was last used.
  await new Promise((r) => setTimeout(r, 6_000));
  const report = await usage();
  assert.equal(report.status, 200);
  assert.equal(report.body.month, new Date().toISOString().slice(0, 7));
  const { totals, owners, cells } = report.body;
  assert.equal(totals.cells, 2);
  assert.equal(totals.activeCells, 2);
  assert.deepEqual(totals.inference, { calls: 2, input: 40, output: 10, total: 50 });

  const alice = owners.find((o) => o.email === "alice@test");
  const bob = owners.find((o) => o.email === "bob@test");
  assert.deepEqual(alice.inference, totals.inference);
  assert.equal(bob.inference.calls, 0);
  assert.equal(alice.requests + bob.requests, totals.requests);

  const cell = cells.find((c) => c.owner.email === "alice@test");
  assert.equal(cell.blueprint, "ask");
  // One GET and four POSTs, including the one before the grant and the one for
  // an ungranted model: every request that reached the gadget.
  assert.equal(cell.requests, 5);
  assert.ok(cell.lastActive > Date.now() - 120_000, `lastActive ${cell.lastActive}`);
  assert.deepEqual(cell.inference, {
    default: { calls: 1, input: 10, output: 5, total: 15 },
    small: { calls: 1, input: 30, output: 5, total: 35 },
  });
  assert.ok(cell.storageBytes > 0, `storage ${cell.storageBytes}`);
  assert.equal(totals.storageBytes, cells.reduce((n, c) => n + (c.storageBytes ?? 0), 0));
});

test("a user sees only their own cells in the usage report, and months are separate", async () => {
  const mine = await usage("", "alice");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.cells.length, 1);
  assert.deepEqual(mine.body.owners.map((o) => o.email), ["alice@test"]);
  assert.equal(mine.body.totals.inference.calls, 2);

  const nobody = await usage("", "carol");
  assert.deepEqual(nobody.body.cells, []);
  assert.equal(nobody.body.totals.cells, 0);

  const past = await usage("?month=2020-01");
  assert.equal(past.body.totals.requests, 0);
  assert.equal(past.body.totals.inference.calls, 0);
  assert.equal(past.body.totals.cells, 2);
  assert.equal((await usage("?month=2026-13")).status, 400);
  assert.equal((await kernel.api("GET", "/workspaces/nope/usage")).status, 404);
});
