// Calls that wait for the owner's approval: what the gadget gets at once,
// and how the cell tells it the outcome, across hibernation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { startKernel } from "./dev.mjs";

const SEND = "email:outbox:send";
const FIXTURE = new URL("./gadgets/capabilities.js", import.meta.url);
const IDLE_EVICT_S = 2;
const DRAFT = JSON.stringify({ to: "bob@example.com", subject: "Hi", text: "Hello" });

let kernel;
let queued = 0;

// Plays the Gatekeeper's queue: every send is parked as a pending approval
// that the test then settles by changing kernel.gatekeeper.approvals.
function answer(call) {
  const id = `20261001t000000-${String(++queued).padStart(12, "0")}`;
  kernel.gatekeeper.approvals.set(id, { cell: call.cell, state: "pending", capability: call.capability });
  return {
    status: 202,
    headers: { "content-type": "application/json", "x-kodo-decision": "pending", "x-kodo-approval": id },
    body: JSON.stringify({ approval: { id, state: "pending", capability: call.capability } }),
  };
}

before(async () => {
  kernel = await startKernel({ gatekeeper: answer, env: { CELLD_IDLE_EVICT_S: String(IDLE_EVICT_S) } });
  await kernel.api("PUT", "/workspaces/mail", { quota: 100 });
  const digest = (await kernel.api("POST", "/bundles", await readFile(FIXTURE))).body.digest;
  assert.equal((await kernel.api("PUT", "/blueprints/mailer/1", { bundle: digest, capabilities: [SEND] })).status, 201);
});

after(async () => {
  await kernel?.stop();
});

const get = async (cell, path, options = {}) => {
  const res = await kernel.request(`${cell}.g.test`, path, options);
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body);
};

// A cell with the send capability granted.
async function mailer() {
  const cell = (await kernel.createCell("mail", "mailer", "1")).id;
  await kernel.api("PUT", `/workspaces/mail/cells/${cell}/grants`, { grants: [SEND] }, { as: "alice" });
  return cell;
}

// Queues a send from the cell and returns the approval id.
async function send(cell) {
  const res = await get(cell, `/send?cap=${encodeURIComponent(SEND)}`, {
    method: "POST",
    body: DRAFT,
    headers: { origin: `http://${cell}.g.test` },
  });
  assert.equal(res.status, 202);
  assert.equal(res.decision, "pending");
  return res.approval;
}

const settle = (id, status) => kernel.gatekeeper.approvals.set(id, { ...kernel.gatekeeper.approvals.get(id), ...status });

async function waitFor(fn, what, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const settled = (cell) => waitFor(async () => {
  const list = await get(cell, "/settled");
  return list.length ? list : null;
}, `onApproval in ${cell}`);

const queriesFor = (id) => kernel.gatekeeper.queries.filter((q) => q.ids.includes(id)).length;

describe("a call that waits for approval", () => {
  test("answers 202 pending at once, with the approval's id, and reaches the Gatekeeper with its body", async () => {
    const cell = await mailer();
    const id = await send(cell);
    assert.match(id, /^20261001t000000-/);
    const call = kernel.gatekeeper.calls.at(-1);
    assert.equal(call.capability, SEND);
    assert.equal(call.request.method, "POST");
    assert.equal(Buffer.from(call.request.body, "base64").toString(), DRAFT);
    const seen = await get(cell, `/approval?id=${id}`);
    assert.equal(seen.state, "pending");
    assert.equal(seen.capability, SEND);
    assert.equal(seen.status, null);
  });

  test("tells the gadget once it is approved and sent, with the provider's answer", async () => {
    const cell = await mailer();
    const id = await send(cell);
    settle(id, {
      state: "done",
      decidedAt: new Date().toISOString(),
      result: { status: 200, headers: { "content-type": "application/json" }, body: '{"id":"email-1"}' },
    });
    const [delivered, ...more] = await settled(cell);
    assert.deepEqual(more, []);
    assert.equal(delivered.id, id);
    assert.equal(delivered.state, "done");
    assert.equal(delivered.decided, true);
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body, '{"id":"email-1"}');
    // Once delivered, the cell stops asking.
    const asked = queriesFor(id);
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(queriesFor(id), asked);
    assert.equal((await get(cell, "/settled")).length, 1);
  });

  test("tells the gadget when it is rejected, with no response", async () => {
    const cell = await mailer();
    const id = await send(cell);
    settle(id, { state: "rejected", decidedAt: new Date().toISOString() });
    const [delivered] = await settled(cell);
    assert.equal(delivered.state, "rejected");
    assert.equal(delivered.status, null);
  });

  test("tells the gadget when it failed, with the reason", async () => {
    const cell = await mailer();
    const id = await send(cell);
    settle(id, { state: "failed", reason: "the Gatekeeper stopped while making the call" });
    const [delivered] = await settled(cell);
    assert.equal(delivered.state, "failed");
    assert.match(delivered.reason, /stopped/);
  });

  test("is followed across the cell's hibernation", async () => {
    const cell = await mailer();
    const id = await send(cell);
    // Long enough for the cell to hibernate between polls.
    await new Promise((r) => setTimeout(r, (IDLE_EVICT_S * 3 + 2) * 1000));
    assert.ok(queriesFor(id) >= 2, "the cell kept asking while it waited");
    assert.deepEqual(await get(cell, "/settled"), []);
    settle(id, { state: "done", result: { status: 200, headers: {}, body: "ok" } });
    const [delivered] = await settled(cell);
    assert.equal(delivered.state, "done");
  });

  test("leaves the gadget's own alarm working", async () => {
    const cell = await mailer();
    await send(cell);
    await get(cell, "/alarm?in=1500");
    assert.equal(await waitFor(() => get(cell, "/alarmed"), "the gadget alarm", 15_000), 1);
  });

  test("of another cell is unknown to a gadget", async () => {
    const owner = await mailer();
    const id = await send(owner);
    const other = await mailer();
    assert.equal((await get(other, `/approval?id=${id}`)).state, "unknown");
  });

  test("that the Gatekeeper no longer knows is dropped without telling the gadget", async () => {
    const cell = await mailer();
    const id = await send(cell);
    kernel.gatekeeper.approvals.delete(id);
    await waitFor(() => queriesFor(id) >= 1, "a query");
    const asked = queriesFor(id);
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(queriesFor(id), asked);
    assert.deepEqual(await get(cell, "/settled"), []);
  });
});
