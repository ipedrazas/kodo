// Durable Object classes of a celld project run as gadgets, as `kodo publish`
// builds them (internal/celldapp; the bundles in test/gadgets/celld-*.js are
// its golden output for internal/celldapp/testdata/app).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startKernel } from "./dev.mjs";

let kernel;

before(async () => {
  kernel = await startKernel();
  await kernel.workspace("lab", {});
  await kernel.publish("test/gadgets/celld-counter.js", "celld-counter", "0.1.0");
  await kernel.publish("test/gadgets/celld-settings.js", "celld-settings", "0.1.0");
});

after(async () => {
  await kernel?.stop();
});

const call = async (cell, method = "GET") => {
  const res = await kernel.request(`${cell}.g.test`, "/", { method });
  return { status: res.status, body: res.body };
};

test("a celld class runs unchanged, with its storage in each cell", async () => {
  const a = (await kernel.createCell("lab", "celld-counter")).id;
  const b = (await kernel.createCell("lab", "celld-counter")).id;
  assert.deepEqual(await call(a), { status: 200, body: '{"value":0}' });
  assert.deepEqual(await call(a, "POST"), { status: 200, body: '{"value":1}' });
  assert.deepEqual(await call(a, "POST"), { status: 200, body: '{"value":2}' });
  assert.deepEqual(await call(a), { status: 200, body: '{"value":2}' });
  assert.deepEqual(await call(b), { status: 200, body: '{"value":0}' }, "cells share a count");
  assert.equal((await call(a, "DELETE")).status, 404);
});

test("a binding the checks could not see is refused when the class asks for it", async () => {
  const cell = (await kernel.createCell("lab", "celld-settings")).id;
  const res = await call(cell);
  assert.equal(res.status, 502);
  assert.match(res.body, /env\.API_KEY is not available in a kodo gadget/);
});
