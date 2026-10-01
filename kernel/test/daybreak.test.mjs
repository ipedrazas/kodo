// The daybreak example (examples/daybreak): a circle of friends in one cell,
// whose members are the people it is shared with.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startKernel } from "./dev.mjs";

const HOUR = 60 * 60 * 1000;
let kernel;
let cell;

before(async () => {
  kernel = await startKernel();
  await kernel.api("PUT", "/workspaces/friends", {});
  const source = await readFile(new URL("../../examples/daybreak/gadget.js", import.meta.url));
  const digest = (await kernel.api("POST", "/bundles", source)).body.digest;
  assert.equal((await kernel.api("PUT", "/blueprints/daybreak/1.0.0", { bundle: digest })).status, 201);
  cell = (await kernel.createCell("friends", "daybreak")).id;
  for (const [email, role] of [["bob@test", "editor"], ["carol@test", "viewer"]]) {
    const res = await kernel.api("PUT", `/workspaces/friends/cells/${cell}/shares/${email}`, { role }, { as: "alice" });
    assert.equal(res.status, 200);
  }
});

after(async () => {
  await kernel?.stop();
});

const call = async (as, method, path, body) => {
  const res = await kernel.request(`${cell}.g.test`, path, {
    as,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", origin: `http://${cell}.g.test` },
  });
  return { status: res.status, body: res.body.startsWith("{") ? JSON.parse(res.body) : res.body };
};
// Tomorrow at an hour, on the hour.
const at = (hour) => {
  const d = new Date(Date.now() + 24 * HOUR);
  d.setUTCHours(hour, 0, 0, 0);
  return d.getTime();
};

test("members join by opening the cell; only the circle and its owner can", async () => {
  const page = await kernel.request(`${cell}.g.test`, "/", { as: "bob" });
  assert.equal(page.status, 200);
  assert.match(page.body, /Daybreak/);
  for (const who of ["alice", "bob", "carol"]) assert.equal((await call(who, "GET", "/api/state")).status, 200);
  assert.equal((await call("dan", "GET", "/api/state")).status, 403);
  const state = (await call("bob", "GET", "/api/state")).body;
  assert.deepEqual(state.members.map((m) => m.email), ["alice@test", "bob@test", "carol@test"]);
  assert.deepEqual(state.me, { email: "bob@test", role: "editor" });
  assert.deepEqual([state.cell, state.workspace], [cell, "friends"]);
});

test("free time is merged, checked, and seen by the circle", async () => {
  assert.equal((await call("alice", "POST", "/api/slots", { start: at(17), end: at(19) })).status, 200);
  const merged = await call("alice", "POST", "/api/slots", { start: at(19), end: at(21) });
  const alice = merged.body.members.find((m) => m.me);
  assert.deepEqual(alice.free.map((f) => [f.start, f.end]), [[at(17), at(21)]]);
  for (const bad of [
    { start: at(17) + 1, end: at(18) },
    { start: at(18), end: at(17) },
    { start: at(1), end: at(14) },
    { start: Date.now() - 48 * HOUR - ((Date.now() - 48 * HOUR) % (15 * 60000)), end: Date.now() - 47 * HOUR - ((Date.now() - 47 * HOUR) % (15 * 60000)) },
  ]) {
    assert.equal((await call("alice", "POST", "/api/slots", bad)).status, 400, JSON.stringify(bad));
  }
  await call("bob", "POST", "/api/slots", { start: at(18), end: at(23) });
  const state = (await call("bob", "GET", "/api/state")).body;
  assert.deepEqual(state.windows.map((w) => [w.with, w.start, w.end]), [["alice@test", at(18), at(21)]]);
  // A viewer sees the circle but cannot add free time; the kernel refuses the write.
  assert.equal((await call("carol", "POST", "/api/slots", { start: at(18), end: at(19) })).status, 403);
  assert.equal((await call("carol", "GET", "/api/state")).body.members.find((m) => m.email === "alice@test").free.length, 1);
});

test("a proposed meeting, once accepted, takes the time out of both people's free time", async () => {
  assert.equal((await call("bob", "POST", "/api/meetings", { with: "alice@test", start: at(17), end: at(19) })).status, 409);
  assert.equal((await call("bob", "POST", "/api/meetings", { with: "dan@test", start: at(18), end: at(19) })).status, 404);
  const proposed = await call("bob", "POST", "/api/meetings", { with: "alice@test", start: at(19), end: at(20), title: "Dinner" });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  const [meeting] = proposed.body.meetings;
  assert.deepEqual([meeting.title, meeting.status, meeting.direction, meeting.with], ["Dinner", "pending", "outgoing", "alice@test"]);
  assert.equal((await call("bob", "POST", `/api/meetings/${meeting.id}/accept`)).status, 403);

  const accepted = await call("alice", "POST", `/api/meetings/${meeting.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.meetings[0].status, "accepted");
  const alice = accepted.body.members.find((m) => m.email === "alice@test");
  const bob = accepted.body.members.find((m) => m.email === "bob@test");
  assert.deepEqual(alice.free.map((f) => [f.start, f.end]), [[at(17), at(19)], [at(20), at(21)]]);
  assert.deepEqual(bob.free.map((f) => [f.start, f.end]), [[at(18), at(19)], [at(20), at(23)]]);
  assert.equal((await call("alice", "POST", `/api/meetings/${meeting.id}/accept`)).status, 409);

  // Cancelling gives the time back to both.
  const cancelled = await call("bob", "POST", `/api/meetings/${meeting.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body.meetings, []);
  assert.deepEqual(cancelled.body.members.find((m) => m.email === "alice@test").free.map((f) => [f.start, f.end]), [[at(17), at(21)]]);
});

test("accepting fails if either is no longer free", async () => {
  const proposed = await call("alice", "POST", "/api/meetings", { with: "bob@test", start: at(18), end: at(19) });
  const id = proposed.body.meetings[0].id;
  const bob = (await call("bob", "GET", "/api/state")).body.members.find((m) => m.me);
  await call("bob", "DELETE", `/api/slots/${bob.free[0].id}`);
  const res = await call("bob", "POST", `/api/meetings/${id}/accept`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no longer free/);
  assert.equal((await call("bob", "POST", `/api/meetings/${id}/decline`)).status, 200);
});
