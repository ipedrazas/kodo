// An identity provider that leaves the email out of its ID tokens: the
// kernel asks its userinfo endpoint, with the access token the gateway
// forwards.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startKernel } from "./dev.mjs";

let kernel;

before(async () => {
  kernel = await startKernel({ userinfo: true });
  await kernel.workspace("team", { quota: 100 });
  await kernel.publish("test/gadgets/fixture.js", "fixture", "1");
});

after(async () => {
  await kernel?.stop();
});

// An ID token with no email claims, and the access token that goes with it.
const signIn = (name, info) => {
  const access = `access-${name}`;
  if (info) kernel.idp.userinfo.set(access, { sub: `sub-${name}`, ...info });
  return {
    as: { token: kernel.idp.token({ sub: `sub-${name}`, email_verified: undefined }) },
    headers: { authorization: `Bearer ${access}` },
  };
};
const whoami = async (options) => (await kernel.api("GET", "/whoami", undefined, options)).body;

describe("email from userinfo", () => {
  test("a token without an email gets the one userinfo gives", async () => {
    const erin = signIn("erin", { email: "Erin@Test", email_verified: true });
    assert.deepEqual(await whoami(erin), { kind: "user", user: "sub-erin", email: "erin@test" });
  });

  test("it is remembered for a call without the access token", async () => {
    const erin = signIn("erin");
    const calls = kernel.idp.userinfoCalls.length;
    assert.equal((await whoami({ as: erin.as })).email, "erin@test");
    assert.equal((await whoami(erin)).email, "erin@test");
    assert.equal(kernel.idp.userinfoCalls.length, calls, "userinfo was asked again");
  });

  test("a token with an email does not ask", async () => {
    const calls = kernel.idp.userinfoCalls.length;
    const body = await whoami({ as: "alice", headers: { authorization: "Bearer access-erin" } });
    assert.equal(body.email, "alice@test");
    assert.equal(kernel.idp.userinfoCalls.length, calls);
  });

  test("another user's access token gives nothing", async () => {
    const frank = signIn("frank");
    const body = await whoami({ as: frank.as, headers: { authorization: "Bearer access-erin" } });
    assert.deepEqual(body, { kind: "user", user: "sub-frank", email: "" });
  });

  test("an access token userinfo refuses gives nothing, and the user still signs in", async () => {
    assert.deepEqual(await whoami(signIn("grace")), { kind: "user", user: "sub-grace", email: "" });
  });

  test("an email userinfo calls unverified is not used", async () => {
    const heidi = signIn("heidi", { email: "heidi@test", email_verified: false });
    assert.equal((await whoami(heidi)).email, "");
  });

  test("a platform admin is named by a verified email from userinfo", async () => {
    const root = signIn("root2", { email: "root@test", email_verified: true });
    assert.equal((await kernel.api("GET", "/admin/overview", undefined, root)).status, 200);
    // The provider must say it verified the address.
    const unsaid = signIn("root3", { email: "root@test" });
    assert.equal((await whoami(unsaid)).email, "root@test");
    assert.equal((await kernel.api("GET", "/admin/overview", undefined, unsaid)).status, 403);
  });

  test("a share by email reaches a user whose email came from userinfo", async () => {
    const cell = (await kernel.createCell("team", "fixture")).id;
    const erin = signIn("erin");
    assert.equal((await kernel.request(`${cell}.g.test`, "/", erin)).status, 403);
    const res = await kernel.api("PUT", `/workspaces/team/cells/${cell}/shares/erin@test`, { role: "viewer" }, { as: "alice" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await kernel.request(`${cell}.g.test`, "/", erin)).status, 200);
  });

  test("the access token does not reach a gadget", async () => {
    const cell = (await kernel.createCell("team", "fixture")).id;
    const res = await kernel.request(`${cell}.g.test`, "/?whoami", { headers: { authorization: "Bearer access-erin" } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).authorization, undefined);
  });
});
