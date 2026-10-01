// The HN reader example (examples/hn-reader) against a stand-in Gatekeeper
// that answers as the Algolia HN API and a model would.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startKernel } from "./dev.mjs";

const WEB = "web:hn.algolia.com/api/v1:read";
const MODEL = "inference:model/default:invoke";
let kernel;
let cell;
let hnDown = false;

const hit = (id, title) => ({ objectID: String(id), title, url: `https://example.com/${id}`, points: id, num_comments: 2, author: "pg", created_at_i: 1790000000 });
const item = {
  id: 7, title: "Seven", url: "https://example.com/7", points: 70, author: "pg", created_at_i: 1790000000, text: null,
  children: [
    { id: 71, author: "a", created_at_i: 1790000100, text: "<p>First &amp; <i>best</i>", children: [
      { id: 711, author: "b", created_at_i: 1790000200, text: 'See <a href="https://x.test/">https://x.test/</a><script>alert(1)</script>', children: [] },
    ] },
    { id: 72, author: "c", created_at_i: 1790000300, text: "Second", children: [] },
  ],
};

function gatekeeper(call) {
  if (call.capability === WEB) {
    if (hnDown) return { status: 502, headers: { "x-kodo-decision": "failed" }, body: '{"error":"hn.algolia.com is unreachable"}' };
    const path = call.request.path;
    if (path.startsWith("/search")) {
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ hits: [hit(7, "Seven"), hit(8, path)] }) };
    }
    if (path === "/items/7") return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(item) };
    return { status: 404, headers: {}, body: '{"error":"not found"}' };
  }
  const prompt = JSON.parse(Buffer.from(call.request.body, "base64").toString()).messages.at(-1).content;
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "backend-1", choices: [{ message: { content: `summary of ${prompt.length} chars` } }] }),
    usage: { input: 100, output: 10, total: 110 },
  };
}

before(async () => {
  kernel = await startKernel({ gatekeeper });
  await kernel.api("PUT", "/workspaces/news", {});
  const source = await readFile(new URL("../../examples/hn-reader/gadget.js", import.meta.url));
  const digest = (await kernel.api("POST", "/bundles", source)).body.digest;
  const res = await kernel.api("PUT", "/blueprints/hn-reader/1.0.0", { bundle: digest, capabilities: [WEB, "inference:model/*:invoke"] });
  assert.equal(res.status, 201);
  cell = (await kernel.createCell("news", "hn-reader")).id;
  await kernel.api("PUT", `/workspaces/news/cells/${cell}/shares/bob@test`, { role: "editor" }, { as: "alice" });
});

after(async () => {
  await kernel?.stop();
});

const call = async (path, { as = "alice", method = "GET", body } = {}) => {
  const res = await kernel.request(`${cell}.g.test`, path, {
    as,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", origin: `http://${cell}.g.test` },
  });
  return { status: res.status, body: res.body.startsWith("{") ? JSON.parse(res.body) : res.body };
};
const webCalls = () => kernel.gatekeeper.calls.filter((c) => c.cell === cell && c.capability === WEB);

test("without the web grant there is nothing to read, and setup says where to grant it", async () => {
  const res = await call("/api/stories");
  assert.equal(res.status, 403);
  assert.match(res.body.error, /no grant/);
  assert.deepEqual((await call("/api/setup")).body, { web: false, models: [], role: "owner", cell, workspace: "news" });
  assert.equal((await call("/api/setup", { as: "bob" })).body.role, "editor");
  const page = await kernel.request(`${cell}.g.test`, "/", { as: "alice" });
  assert.match(page.body, /Grant them on the kodo home page/);
});

test("lists come from the HN API through the grant, once per five minutes", async () => {
  await kernel.api("PUT", `/workspaces/news/cells/${cell}/grants`, { grants: [WEB] }, { as: "alice" });
  const front = await call("/api/stories?list=front");
  assert.equal(front.status, 200, JSON.stringify(front.body));
  assert.deepEqual(front.body.stories.map((s) => s.id), ["7", "8"]);
  assert.equal(front.body.stories[0].domain, "example.com");
  assert.deepEqual(front.body.models, []);
  assert.equal((await call("/api/stories?list=front")).status, 200);
  assert.equal((await call("/api/stories?list=new")).body.stories[1].title, "/search_by_date?tags=story&hitsPerPage=30");
  assert.deepEqual(webCalls().map((c) => [c.request.method, c.request.path]), [
    ["GET", "/search?tags=front_page&hitsPerPage=30"],
    ["GET", "/search_by_date?tags=story&hitsPerPage=30"],
  ]);
  assert.equal((await call("/api/stories?list=jobs")).status, 400);
});

test("a thread is plain text, and opening it marks it read for that person only", async () => {
  const res = await call("/api/stories/7");
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 3);
  assert.deepEqual(res.body.comments.map((c) => [c.author, c.depth, c.text]), [
    ["a", 0, "First & best"],
    ["b", 1, "See https://x.test/alert(1)"],
    ["c", 0, "Second"],
  ]);
  assert.equal((await call("/api/stories?list=front")).body.stories[0].read, true);
  assert.equal((await call("/api/stories?list=front", { as: "bob" })).body.stories[0].read, false);
});

test("saving is per person", async () => {
  assert.deepEqual((await call("/api/stories/7/save", { method: "POST" })).body, { saved: true });
  assert.deepEqual((await call("/api/saved")).body.saved.map((s) => [s.id, s.title]), [["7", "Seven"]]);
  assert.deepEqual((await call("/api/saved", { as: "bob" })).body.saved, []);
  assert.deepEqual((await call("/api/stories/7/save", { method: "POST" })).body, { saved: false });
});

test("a summary needs a model grant, asks it once, and is kept", async () => {
  assert.equal((await call("/api/stories/7/summary", { method: "POST", body: {} })).status, 403);
  await kernel.api("PUT", `/workspaces/news/cells/${cell}/grants`, { grants: [WEB, MODEL] }, { as: "alice" });
  const res = await call("/api/stories/7/summary", { method: "POST", body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.model, "default");
  assert.equal(res.body.backend, "backend-1");
  assert.match(res.body.text, /^summary of \d+ chars$/);
  assert.equal((await call("/api/stories/7/summary", { method: "POST", body: {} })).body.text, res.body.text);
  const asked = kernel.gatekeeper.calls.filter((c) => c.cell === cell && c.capability === MODEL);
  assert.equal(asked.length, 1);
  const prompt = JSON.parse(Buffer.from(asked[0].request.body, "base64").toString()).messages.at(-1).content;
  assert.match(prompt, /Title: Seven/);
  assert.match(prompt, /- a: First & best/);
  assert.equal((await call("/api/stories/7")).body.summary.text, res.body.text);
});

test("when Hacker News cannot be reached, the last copy is served", async () => {
  const before = webCalls().length;
  hnDown = true;
  try {
    const ask = await call("/api/stories?list=ask&refresh=1");
    assert.equal(ask.status, 502);
    assert.match(ask.body.error, /502/);
    const front = await call("/api/stories?list=front&refresh=1");
    assert.equal(front.status, 200);
    assert.equal(front.body.stale, true);
    assert.equal(front.body.stories.length, 2);
  } finally {
    hnDown = false;
  }
  // Both went to Hacker News, and refreshing works again once it answers.
  assert.equal(webCalls().length, before + 2);
  assert.equal((await call("/api/stories?list=front&refresh=1")).body.stale, false);
});
