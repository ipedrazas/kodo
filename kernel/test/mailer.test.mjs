// The mailer example (examples/mailer) against a stand-in Gatekeeper that
// queues every send for approval, as the real one does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startKernel } from "./dev.mjs";

const SEND = "email:outbox:send";
let kernel;
let queued = 0;

function queue(call) {
  const message = JSON.parse(Buffer.from(call.request.body, "base64").toString());
  if (!message.to || !message.subject) {
    return { status: 403, headers: { "content-type": "application/json", "x-kodo-decision": "denied" }, body: '{"error":"a message needs to and subject"}' };
  }
  const id = `20261001t000000-${String(++queued).padStart(12, "0")}`;
  kernel.gatekeeper.approvals.set(id, { cell: call.cell, state: "pending", capability: call.capability });
  return { status: 202, headers: { "x-kodo-decision": "pending", "x-kodo-approval": id }, body: "{}" };
}

before(async () => {
  kernel = await startKernel({ gatekeeper: queue });
  await kernel.api("PUT", "/workspaces/examples", {});
  const source = await readFile(new URL("../../examples/mailer/gadget.js", import.meta.url));
  const digest = (await kernel.api("POST", "/bundles", source)).body.digest;
  assert.equal((await kernel.api("PUT", "/blueprints/mailer/1.0.0", { bundle: digest, capabilities: [SEND] })).status, 201);
});

after(async () => {
  await kernel?.stop();
});

test("the mailer queues drafts and learns from the cell when they are approved or rejected", async () => {
  const cell = (await kernel.createCell("examples", "mailer")).id;
  const call = async (path, body) => {
    const res = await kernel.request(`${cell}.g.test`, path, body === undefined ? {} : {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: `http://${cell}.g.test` },
    });
    return { status: res.status, body: res.body.startsWith("{") ? JSON.parse(res.body) : res.body };
  };
  assert.equal((await call("/api/outbox", { to: "bob@example.com", subject: "Hi", text: "x" })).status, 403);

  await kernel.api("PUT", `/workspaces/examples/cells/${cell}/grants`, { grants: [SEND] }, { as: "alice" });
  const first = await call("/api/outbox", { to: ["bob@example.com"], subject: "Numbers", text: "Here." });
  assert.equal(first.status, 202);
  assert.equal(first.body.state, "pending");
  assert.equal(first.body.draftedBy, "alice@test");
  const second = await call("/api/outbox", { to: "carol@example.com", subject: "Lunch", text: "?" });
  assert.equal((await call("/api/outbox", { to: "dan@example.com" })).status, 403);

  kernel.gatekeeper.approvals.set(first.body.id, {
    cell, state: "done", result: { status: 200, headers: {}, body: '{"id":"email-1"}' },
  });
  kernel.gatekeeper.approvals.set(second.body.id, { cell, state: "rejected" });
  const deadline = Date.now() + 30_000;
  let outbox;
  do {
    await new Promise((r) => setTimeout(r, 500));
    outbox = (await call("/api/outbox")).body.outbox;
  } while (outbox.some((m) => m.state === "pending") && Date.now() < deadline);
  const byId = Object.fromEntries(outbox.map((m) => [m.id, m]));
  assert.equal(byId[first.body.id].state, "done");
  assert.equal(byId[first.body.id].status, 200);
  assert.equal(byId[first.body.id].response, '{"id":"email-1"}');
  assert.equal(byId[first.body.id].notified, true);
  assert.equal(byId[second.body.id].state, "rejected");

  // A check asks the Gatekeeper directly.
  const third = await call("/api/outbox", { to: "erin@example.com", subject: "Now", text: "!" });
  kernel.gatekeeper.approvals.set(third.body.id, { cell, state: "failed", reason: "the owner has disconnected email" });
  const checked = await call(`/api/outbox/${third.body.id}?check=1`);
  assert.equal(checked.body.state, "failed");
  assert.match(checked.body.reason, /disconnected/);
});
