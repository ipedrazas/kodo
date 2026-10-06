// The chat example (examples/chat): a room per cell, whose lines reach
// everyone in it as they are said.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startKernel } from "./dev.mjs";

let kernel;
let cell;

before(async () => {
  kernel = await startKernel();
  await kernel.workspace("friends", {});
  const source = await readFile(new URL("../../examples/chat/gadget.js", import.meta.url));
  const digest = (await kernel.api("POST", "/bundles", source)).body.digest;
  assert.equal((await kernel.api("PUT", "/blueprints/chat/1.0.0", { bundle: digest })).status, 201);
  cell = (await kernel.createCell("friends", "chat")).id;
  for (const [email, role] of [["bob@test", "editor"], ["carol@test", "viewer"]]) {
    const res = await kernel.api("PUT", `/workspaces/friends/cells/${cell}/shares/${email}`, { role }, { as: "alice" });
    assert.equal(res.status, 200);
  }
});

after(async () => {
  await kernel?.stop();
});

// Opens the room as a user; next() reads the next message other than a pong.
async function join(as) {
  const ws = kernel.socket(`${cell}.g.test`, { as });
  await ws.opened;
  const next = async (type) => {
    for (;;) {
      const raw = await ws.next();
      if (raw === "pong") continue;
      const m = JSON.parse(raw);
      if (!type || m.type === type) return m;
    }
  };
  return { ...ws, next, hello: await next("hello") };
}

const http = (as, method, body) =>
  kernel.request(`${cell}.g.test`, "/api/lines", {
    as,
    method,
    headers: { origin: `http://${cell}.g.test`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("a line from one person reaches everyone in the room", async () => {
  const alice = await join("alice");
  assert.deepEqual(alice.hello.online, ["alice@test"]);
  const bob = await join("bob");
  assert.equal(bob.hello.you, "bob@test");
  assert.deepEqual(bob.hello.online, ["alice@test", "bob@test"]);
  assert.deepEqual((await alice.next("online")).online, ["alice@test", "bob@test"]);

  bob.send(JSON.stringify({ text: "hi alice" }));
  const [heard, echoed] = await Promise.all([alice.next("line"), bob.next("line")]);
  assert.equal(heard.line.email, "bob@test");
  assert.equal(heard.line.text, "hi alice");
  assert.deepEqual(echoed, heard);

  bob.close();
  assert.deepEqual((await alice.next("online")).online, ["alice@test"]);
  alice.close();
});

test("a newcomer gets the history, and a line posted over HTTP is sent to the room", async () => {
  const alice = await join("alice");
  const res = await http("bob", "POST", { text: "posted" });
  assert.equal(res.status, 201, res.body);
  assert.equal((await alice.next("line")).line.text, "posted");
  const carol = JSON.parse((await http("carol", "GET")).body);
  assert.deepEqual(carol.lines.map((l) => l.text).slice(-2), ["hi alice", "posted"]);
  const bob = await join("bob");
  assert.deepEqual(bob.hello.lines.map((l) => l.text).slice(-2), ["hi alice", "posted"]);
  alice.close();
  bob.close();
});

test("a viewer can read but not join, and empty lines are refused", async () => {
  assert.equal((await http("carol", "POST", { text: "let me in" })).status, 403);
  await assert.rejects(kernel.socket(`${cell}.g.test`, { as: "carol" }).opened, /upgrade refused: 403/);
  assert.equal((await http("alice", "POST", { text: "  " })).status, 400);
  const alice = await join("alice");
  alice.send(JSON.stringify({ text: "" }));
  assert.equal((await alice.next("error")).type, "error");
  alice.send("ping");
  alice.send(JSON.stringify({ text: "after a ping" }));
  assert.equal((await alice.next("line")).line.text, "after a ping");
  alice.close();
});
