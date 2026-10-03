// Administration: platform admins (an IdP group, or the bootstrap emails),
// workspace members and admins, the platform's settings, model budgets,
// withdrawing Blueprint versions, suspending users, the audit trail of every
// admin action, the audit search and the cluster report.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { startKernel, user } from "./dev.mjs";

const AGENT = "inference:model/agent:invoke";
const OTHER = "inference:model/other:invoke";
const DEFAULT = "inference:model/default:invoke";
const TOKENS_PER_CALL = 80;
let kernel;

// Plays the Gatekeeper: a model call uses TOKENS_PER_CALL tokens.
function answer(call) {
  if (call.capability.startsWith("inference:")) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
      usage: { model: "m", input: TOKENS_PER_CALL - 10, output: 10, total: TOKENS_PER_CALL },
    };
  }
  return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
}

before(async () => {
  kernel = await startKernel({ gatekeeper: answer, vars: { PLATFORM_ADMIN_GROUP: "kodo-admins" } });
  await kernel.workspace("team", {});
  await kernel.publish("test/gadgets/fixture.js", "fixture", "1");
});

after(async () => {
  await kernel?.stop();
});

const as = (name, claims = {}) => ({ token: kernel.idp.token({ ...user(name), ...claims }) });
const events = (action) => kernel.gatekeeper.events.filter((e) => e.kind === "admin" && (!action || e.action === action));
const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};

describe("platform admins", () => {
  test("a bootstrap email or the configured group makes a platform admin", async () => {
    assert.equal(ok(await kernel.api("GET", "/whoami", undefined, { as: "root" })).platformAdmin, true);
    const grouped = as("gina", { groups: ["staff", "kodo-admins"] });
    assert.equal(ok(await kernel.api("GET", "/whoami", undefined, { as: grouped })).platformAdmin, true);
    assert.equal(ok(await kernel.api("GET", "/admin/overview", undefined, { as: grouped })).build !== undefined, true);
    assert.equal(ok(await kernel.api("GET", "/whoami", undefined, { as: "alice" })).platformAdmin, undefined);
  });

  test("a bootstrap email the IdP says is unverified does not", async () => {
    const unverified = as("root", { email_verified: false });
    assert.equal(ok(await kernel.api("GET", "/whoami", undefined, { as: unverified })).platformAdmin, undefined);
    assert.equal((await kernel.api("GET", "/admin/overview", undefined, { as: unverified })).status, 403);
  });

  test("anyone else gets 403 on every admin endpoint and the dashboard", async () => {
    const endpoints = [
      ["GET", "/admin/overview"],
      ["GET", "/admin/settings"],
      ["PUT", "/admin/settings", { agent: { model: "x", maxTokens: 1000, maxSteps: 2 } }],
      ["GET", "/admin/budgets"],
      ["PUT", "/admin/budgets", { user: 1, workspace: 1 }],
      ["GET", "/admin/usage"],
      ["GET", "/admin/workspaces"],
      ["GET", "/admin/blueprints"],
      ["GET", "/admin/users"],
      ["PUT", "/admin/users/sub-bob", { suspended: true }],
      ["GET", "/admin/audit"],
      ["PUT", "/admin/cluster", {}],
      ["POST", "/blueprints/fixture/1/withdraw"],
      ["POST", "/bundles", "export class App {}"],
      ["PUT", "/workspaces/new-one", {}],
    ];
    for (const [method, path, body] of endpoints) {
      const res = await kernel.api(method, path, body, { as: "alice" });
      assert.equal(res.status, 403, `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    assert.equal((await kernel.request("app.test", "/admin/", { as: "alice" })).status, 403);
    const page = await kernel.request("app.test", "/admin/", { as: "root" });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Admin · kodo<\/title>/);
    assert.equal((await kernel.request("app.test", "/admin", { as: "root" })).status, 301);
  });

  test("a platform admin can do through their login what the admin token did for a person", async () => {
    // Publish with no author.
    const digest = ok(await kernel.api("POST", "/bundles", await readFile("test/gadgets/fixture.js"), { as: "root" }), 201).digest;
    ok(await kernel.api("PUT", "/blueprints/rooted/1", { bundle: digest }, { as: "root" }), 201);
    assert.deepEqual(events("blueprint.publish").at(-1).user, { user: "sub-root", email: "root@test" });
    // Create and configure workspaces; see and write their docs.
    ok(await kernel.api("PUT", "/workspaces/rootws", { quota: 3 }, { as: "root" }));
    assert.equal(events("workspace.create").at(-1).workspace, "rootws");
    ok(await kernel.api("PUT", "/workspaces/team/docs/about.md", "# About", { as: "root" }));
    // Every workspace, and every cell and its usage.
    const cell = await kernel.createCell("team", "fixture", "1", "alice");
    assert.ok(ok(await kernel.api("GET", "/workspaces", undefined, { as: "root" })).workspaces.includes("rootws"));
    assert.ok(ok(await kernel.api("GET", "/workspaces/team/cells", undefined, { as: "root" })).cells.some((c) => c.id === cell.id));
    assert.ok(ok(await kernel.api("GET", "/workspaces/team/usage", undefined, { as: "root" })).cells.some((c) => c.id === cell.id));
    // A platform admin sees a cell but cannot open it as its owner.
    assert.equal((await kernel.request(`${cell.id}.g.test`, "/", { as: "root" })).status, 403);
    // Deleting someone's cell is recorded.
    assert.equal((await kernel.api("DELETE", `/workspaces/team/cells/${cell.id}`, undefined, { as: "root" })).status, 204);
    assert.equal(events("cell.delete").at(-1).target, cell.id);
  });

  test("an action that cannot be audited does not happen", async () => {
    kernel.gatekeeper.refuseEvents = true;
    try {
      const res = await kernel.api("PUT", "/admin/budgets", { user: 5, workspace: 5 }, { as: "root" });
      assert.equal(res.status, 503);
      assert.match(res.body.error, /could not be audited/);
      assert.equal(ok(await kernel.api("GET", "/admin/budgets", undefined, { as: "root" })).user, 1_000_000);
    } finally {
      kernel.gatekeeper.refuseEvents = false;
    }
  });
});

describe("workspace members and admins", () => {
  before(async () => {
    // A workspace whose only member is alice, as its admin.
    ok(await kernel.api("PUT", "/workspaces/lab", { quota: 5, members: { "alice@test": "admin" } }, { as: "root" }));
  });

  test("only a platform admin creates a workspace", async () => {
    assert.equal((await kernel.api("PUT", "/workspaces/mine", {}, { as: "alice" })).status, 403);
    assert.equal(ok(await kernel.api("GET", "/workspaces/lab", undefined, { as: "alice" })).role, "admin");
  });

  test("a non-member cannot create cells or chats there", async () => {
    assert.equal((await kernel.api("POST", "/workspaces/lab/cells", { blueprint: "fixture" }, { as: "bob" })).status, 403);
    assert.equal((await kernel.api("POST", "/workspaces/lab/sessions", {}, { as: "bob" })).status, 403);
    assert.equal((await kernel.api("GET", "/workspaces/lab/docs", undefined, { as: "bob" })).status, 403);
    assert.equal(ok(await kernel.api("GET", "/workspaces/lab", undefined, { as: "bob" })).role, null);
  });

  test("a workspace admin adds members, who then create cells and chats; viewers do not", async () => {
    ok(await kernel.api("PUT", "/workspaces/lab/members/bob@test", { role: "member" }, { as: "alice" }));
    ok(await kernel.api("PUT", "/workspaces/lab/members/carol@test", { role: "viewer" }, { as: "alice" }));
    assert.deepEqual(events("member.set").at(-1), {
      kind: "admin",
      action: "member.set",
      user: { user: "sub-alice", email: "alice@test" },
      workspace: "lab",
      target: "carol@test",
      detail: '{"role":"viewer"}',
    });
    ok(await kernel.api("POST", "/workspaces/lab/cells", { blueprint: "fixture" }, { as: "bob" }), 201);
    ok(await kernel.api("POST", "/workspaces/lab/sessions", {}, { as: "bob" }), 201);
    assert.equal((await kernel.api("POST", "/workspaces/lab/cells", { blueprint: "fixture" }, { as: "carol" })).status, 403);
    // Members read the docs and the member list, but do not manage them.
    ok(await kernel.api("GET", "/workspaces/lab/docs", undefined, { as: "carol" }));
    const members = ok(await kernel.api("GET", "/workspaces/lab/members", undefined, { as: "bob" })).members;
    assert.deepEqual(members.map((m) => [m.email, m.role]), [["alice@test", "admin"], ["bob@test", "member"], ["carol@test", "viewer"]]);
    assert.equal((await kernel.api("PUT", "/workspaces/lab/members/dave@test", { role: "member" }, { as: "bob" })).status, 403);
    assert.equal((await kernel.api("PUT", "/workspaces/lab/docs/x.md", "x", { as: "bob" })).status, 403);
    // A user lists the workspaces they belong to.
    assert.deepEqual(ok(await kernel.api("GET", "/workspaces", undefined, { as: "carol" })).memberships.find((m) => m.workspace === "lab"), {
      workspace: "lab",
      role: "viewer",
    });
  });

  test("a workspace admin manages quota and docs of their workspace and nothing beyond it", async () => {
    assert.equal(ok(await kernel.api("PUT", "/workspaces/lab", { quota: 7 }, { as: "alice" })).quota, 7);
    ok(await kernel.api("PUT", "/workspaces/lab/docs/skills/lab.md", "# Lab\n", { as: "alice" }));
    assert.equal(events("doc.put").at(-1).target, "skills/lab.md");
    assert.equal((await kernel.api("DELETE", "/workspaces/lab/docs/skills/lab.md", undefined, { as: "alice" })).status, 204);
    // team is not hers to manage.
    assert.equal((await kernel.api("PUT", "/workspaces/team", { quota: 1 }, { as: "alice" })).status, 403);
    assert.equal((await kernel.api("PUT", "/workspaces/team/members/x@test", { role: "member" }, { as: "alice" })).status, 403);
    assert.equal((await kernel.api("PUT", "/workspaces/team/docs/x.md", "x", { as: "alice" })).status, 403);
    assert.equal((await kernel.api("GET", "/admin/workspaces", undefined, { as: "alice" })).status, 403);
  });

  test("a workspace admin cannot lock themselves out", async () => {
    assert.equal((await kernel.api("PUT", "/workspaces/lab/members/alice@test", { role: "member" }, { as: "alice" })).status, 400);
    assert.equal((await kernel.api("DELETE", "/workspaces/lab/members/alice@test", undefined, { as: "alice" })).status, 400);
  });

  test("a removed member keeps their cells but cannot create more or chat on", async () => {
    const session = ok(await kernel.api("POST", "/workspaces/lab/sessions", {}, { as: "bob" }), 201);
    assert.equal((await kernel.api("DELETE", "/workspaces/lab/members/bob@test", undefined, { as: "alice" })).status, 204);
    assert.equal(events("member.remove").at(-1).target, "bob@test");
    const cells = ok(await kernel.api("GET", "/workspaces/lab/cells", undefined, { as: "bob" })).cells;
    assert.equal(cells.length, 1);
    assert.equal((await kernel.request(`${cells[0].id}.g.test`, "/", { as: "bob" })).status, 200);
    assert.equal((await kernel.api("POST", "/workspaces/lab/cells", { blueprint: "fixture" }, { as: "bob" })).status, 403);
    const turn = await kernel.api("POST", `/workspaces/lab/sessions/${session.id}/turns`, { content: "hi" }, { as: "bob" });
    assert.equal(turn.status, 403);
  });

  test("the admin dashboard lists workspaces with their admins", async () => {
    const lab = ok(await kernel.api("GET", "/admin/workspaces", undefined, { as: "root" })).workspaces.find((w) => w.name === "lab");
    assert.deepEqual(lab, { name: "lab", quota: 7, cells: 1, members: 2, admins: ["alice@test"] });
  });
});

describe("settings", () => {
  test("the agent's settings default, and every user can read them", async () => {
    assert.deepEqual(ok(await kernel.api("GET", "/platform/agent", undefined, { as: "bob" })), {
      model: "agent",
      maxTokens: 16384,
      maxSteps: 10,
      grant: AGENT,
    });
  });

  test("a new chat gets the platform's grants when it names none", async () => {
    const s = ok(await kernel.api("POST", "/workspaces/team/sessions", {}, { as: "alice" }), 201);
    assert.deepEqual(s.grants, [AGENT]);
    const named = ok(await kernel.api("POST", "/workspaces/team/sessions", { grants: [] }, { as: "alice" }), 201);
    assert.deepEqual(named.grants, []);
  });

  test("a platform admin's change applies to the next turn, which gets the new model", async () => {
    const s = ok(await kernel.api("POST", "/workspaces/team/sessions", {}, { as: "alice" }), 201);
    const settings = { agent: { model: "other", maxTokens: 32768, maxSteps: 4 }, sessionGrants: [OTHER, DEFAULT] };
    assert.deepEqual(ok(await kernel.api("PUT", "/admin/settings", settings, { as: "root" })), {
      ...settings,
      sessionGrants: [DEFAULT, OTHER],
    });
    assert.equal(events("settings.update").at(-1).user.email, "root@test");
    assert.equal(ok(await kernel.api("GET", "/platform/agent", undefined, { as: "alice" })).maxTokens, 32768);
    // A turn says how the agent is to work, and the owner who starts it
    // lets the chat use the agent's model.
    const turn = ok(await kernel.api("POST", `/workspaces/team/sessions/${s.id}/turns`, { content: "hi" }, { as: "alice" }), 201);
    assert.deepEqual(turn.agent, settings.agent);
    assert.deepEqual(turn.session.grants, [AGENT, OTHER]);
    assert.deepEqual(ok(await kernel.api("POST", "/workspaces/team/sessions", {}, { as: "alice" }), 201).grants, [DEFAULT, OTHER]);
    // Back to the defaults for the other tests.
    ok(await kernel.api("PUT", "/admin/settings", { agent: { model: "agent", maxTokens: 16384, maxSteps: 10 } }, { as: "root" }));
  });

  test("invalid settings are refused", async () => {
    for (const agent of [
      { model: "Bad Model", maxTokens: 1000, maxSteps: 2 },
      { model: "x", maxTokens: 10, maxSteps: 2 },
      { model: "x", maxTokens: 1000, maxSteps: 0 },
    ]) {
      assert.equal((await kernel.api("PUT", "/admin/settings", { agent }, { as: "root" })).status, 400, JSON.stringify(agent));
    }
    assert.equal((await kernel.api("PUT", "/admin/settings", { agent: { model: "x", maxTokens: 1000, maxSteps: 2 }, sessionGrants: ["a:*:read"] }, { as: "root" })).status, 400);
  });
});

describe("budgets", () => {
  let session;
  const complete = () =>
    kernel.api("POST", `/workspaces/team/sessions/${session.id}/complete`, { model: "agent", request: { messages: [] } }, { as: "carol" });

  before(async () => {
    session = ok(await kernel.api("POST", "/workspaces/team/sessions", {}, { as: "carol" }), 201);
  });

  test("a user's model calls stop once their budget is spent, without reaching the Gatekeeper", async () => {
    // Carol may spend 100 tokens a month: the call that crosses it is
    // answered, the next is refused.
    ok(await kernel.api("PUT", "/admin/budgets", { user: 1_000_000, workspace: null, users: { "sub-carol": 100 } }, { as: "root" }));
    assert.equal(events("budgets.update").length > 0, true);
    assert.equal((await complete()).status, 200);
    assert.equal((await complete()).status, 200);
    const calls = kernel.gatekeeper.calls.length;
    const refused = await complete();
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /owner's monthly budget of 100 model tokens is spent/);
    assert.equal(kernel.gatekeeper.calls.length, calls);
    // Others are not affected.
    const bobs = ok(await kernel.api("POST", "/workspaces/team/sessions", {}, { as: "bob" }), 201);
    const res = await kernel.api("POST", `/workspaces/team/sessions/${bobs.id}/complete`, { model: "agent", request: { messages: [] } }, { as: "bob" });
    assert.equal(res.status, 200);
  });

  test("raising a budget lets the user go on; a workspace budget stops everyone in it", async () => {
    ok(await kernel.api("PUT", "/admin/budgets", { user: 1_000_000, workspace: null, users: { "sub-carol": null } }, { as: "root" }));
    assert.equal((await complete()).status, 200);
    const usage = ok(await kernel.api("GET", "/admin/usage", undefined, { as: "root" }));
    const team = usage.workspaces.find((w) => w.workspace === "team");
    ok(await kernel.api("PUT", "/admin/budgets", { user: 1_000_000, workspace: null, workspaces: { team: team.tokens } }, { as: "root" }));
    const refused = await complete();
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /workspace team's monthly budget/);
    ok(await kernel.api("PUT", "/admin/budgets", { user: 1_000_000, workspace: 5_000_000 }, { as: "root" }));
  });

  test("a gadget's model calls count against the same budgets", async () => {
    const source = await readFile(new URL("../../examples/ask/gadget.js", import.meta.url));
    const digest = ok(await kernel.api("POST", "/bundles", source), 201).digest;
    ok(await kernel.api("PUT", "/blueprints/ask/1.0.0", { bundle: digest, capabilities: ["inference:model/*:invoke"] }), 201);
    const cell = await kernel.createCell("team", "ask", "1.0.0", "dave");
    ok(await kernel.api("PUT", `/workspaces/team/cells/${cell.id}/grants`, { grants: [DEFAULT] }, { as: "dave" }));
    ok(await kernel.api("PUT", "/admin/budgets", { user: 1_000_000, workspace: 5_000_000, users: { "sub-dave": 1 } }, { as: "root" }));
    const ask = () =>
      kernel.request(`${cell.id}.g.test`, "/api/chat", {
        as: "dave",
        method: "POST",
        body: JSON.stringify({ prompt: "hello" }),
        headers: { "content-type": "application/json", origin: `http://${cell.id}.g.test` },
      });
    assert.equal((await ask()).status, 200);
    const refused = await ask();
    assert.notEqual(refused.status, 200);
    assert.match(refused.body, /budget/);
    const dave = ok(await kernel.api("GET", "/admin/usage", undefined, { as: "root" })).users.find((u) => u.user === "sub-dave");
    assert.deepEqual([dave.calls, dave.tokens, dave.budget], [1, TOKENS_PER_CALL, 1]);
    ok(await kernel.api("PUT", "/admin/budgets", { user: 1_000_000, workspace: 5_000_000 }, { as: "root" }));
  });

  test("budgets are whole numbers or null", async () => {
    assert.equal((await kernel.api("PUT", "/admin/budgets", { user: -1, workspace: null }, { as: "root" })).status, 400);
    assert.equal((await kernel.api("PUT", "/admin/budgets", { user: 1 }, { as: "root" })).status, 400);
    assert.equal((await kernel.api("PUT", "/admin/budgets", { user: 1, workspace: 1, workspaces: { "Not A Name": 1 } }, { as: "root" })).status, 400);
  });
});

describe("withdrawing a Blueprint version", () => {
  let onTwo;
  before(async () => {
    await kernel.publish("test/gadgets/fixture.js", "tool", "1");
    await kernel.publish("test/gadgets/fixture.js", "tool", "2");
    onTwo = await kernel.createCell("team", "tool", "2", "alice");
  });

  test("a withdrawn version cannot be instantiated; existing cells keep running", async () => {
    const withdrawn = ok(await kernel.api("POST", "/blueprints/tool/2/withdraw", undefined, { as: "root" }));
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.withdrawnBy.email, "root@test");
    assert.equal(events("blueprint.withdraw").at(-1).target, "tool@2");
    // New cells get the latest version that is not withdrawn.
    assert.equal((await kernel.createCell("team", "tool", undefined, "bob")).version, "1");
    assert.equal((await kernel.api("POST", "/workspaces/team/cells", { blueprint: "tool", version: "2" }, { as: "bob" })).status, 410);
    // The cell on it serves; its owner can move away but not back.
    assert.equal((await kernel.request(`${onTwo.id}.g.test`, "/", { as: "alice" })).status, 200);
    ok(await kernel.api("PATCH", `/workspaces/team/cells/${onTwo.id}`, { version: "1" }, { as: "alice" }));
    assert.equal((await kernel.api("PATCH", `/workspaces/team/cells/${onTwo.id}`, { version: "2" }, { as: "alice" })).status, 410);
    assert.equal((await kernel.api("POST", "/blueprints/tool/2/withdraw", undefined, { as: "root" })).status, 409);
  });

  test("restoring makes it usable again", async () => {
    assert.equal(ok(await kernel.api("POST", "/blueprints/tool/2/restore", undefined, { as: "root" })).status, "published");
    assert.equal((await kernel.createCell("team", "tool", undefined, "bob")).version, "2");
  });

  test("the dashboard lists every version with its status", async () => {
    const versions = ok(await kernel.api("GET", "/admin/blueprints", undefined, { as: "root" })).versions;
    assert.deepEqual(versions.filter((v) => v.name === "tool").map((v) => [v.version, v.status]), [["1", "published"], ["2", "published"]]);
  });
});

describe("suspending a user", () => {
  let cell;
  let turnToken;
  before(async () => {
    cell = await kernel.createCell("team", "fixture", "1", "bob");
    const s = ok(await kernel.api("POST", "/workspaces/team/sessions", {}, { as: "bob" }), 201);
    turnToken = ok(await kernel.api("POST", `/workspaces/team/sessions/${s.id}/turns`, { content: "hi" }, { as: "bob" }), 201).turn.token;
    turnToken = { s: s.id, token: turnToken };
  });

  const refused = async (fn) => {
    // A suspension reaches every isolate within a few seconds.
    const deadline = Date.now() + 8000;
    for (;;) {
      const res = await fn();
      if (res.status === 403 || Date.now() > deadline) return res;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  test("a suspended user's requests, turns and cells are refused", async () => {
    const user = ok(await kernel.api("PUT", "/admin/users/sub-bob", { suspended: true }, { as: "root" }));
    assert.equal(user.suspended.by, "root@test");
    assert.equal(events("user.suspend").at(-1).target, "sub-bob");
    const api = await refused(() => kernel.api("GET", "/whoami", undefined, { as: "bob" }));
    assert.equal(api.status, 403);
    assert.match(api.body, /suspended/);
    assert.equal((await refused(() => kernel.request(`${cell.id}.g.test`, "/", { as: "bob" }))).status, 403);
    const turn = await kernel.api("GET", `/workspaces/team/sessions/${turnToken.s}`, undefined, {
      as: null,
      headers: { "x-kodo-turn": turnToken.token },
    });
    assert.equal(turn.status, 403);
    // Others are served.
    assert.equal((await kernel.api("GET", "/whoami", undefined, { as: "alice" })).status, 200);
    const users = ok(await kernel.api("GET", "/admin/users", undefined, { as: "root" })).users;
    assert.ok(users.find((u) => u.user === "sub-bob").suspended);
  });

  test("lifting it serves them again; nobody suspends themselves", async () => {
    ok(await kernel.api("PUT", "/admin/users/sub-bob", { suspended: false }, { as: "root" }));
    const deadline = Date.now() + 8000;
    let res;
    do {
      res = await kernel.request(`${cell.id}.g.test`, "/", { as: "bob" });
    } while (res.status !== 200 && Date.now() < deadline && (await new Promise((r) => setTimeout(r, 250)), true));
    assert.equal(res.status, 200);
    assert.equal((await kernel.api("PUT", "/admin/users/sub-root", { suspended: true }, { as: "root" })).status, 400);
  });

  test("the users list shows who signed in", async () => {
    const users = ok(await kernel.api("GET", "/admin/users", undefined, { as: "root" })).users;
    const alice = users.find((u) => u.user === "sub-alice");
    assert.equal(alice.email, "alice@test");
    assert.ok(alice.lastSeen >= alice.firstSeen);
  });
});

describe("audit search and the cluster report", () => {
  test("the audit log is searched at the Gatekeeper with the dashboard's filters", async () => {
    kernel.gatekeeper.auditRecords = [{ time: "2026-10-03T00:00:00Z", decision: "admin", action: "budgets.update", user: "sub-root" }];
    const r = ok(await kernel.api("GET", "/admin/audit?user=root@test&workspace=team&days=7&limit=50", undefined, { as: "root" }));
    assert.equal(r.records[0].action, "budgets.update");
    assert.deepEqual(kernel.gatekeeper.auditQueries.at(-1), { user: "root@test", workspace: "team", days: 7, limit: 50 });
    assert.equal((await kernel.api("GET", "/admin/audit?days=90", undefined, { as: "root" })).status, 400);
  });

  test("only the operator reports the cluster, and the overview shows it", async () => {
    const report = { fleet: { name: "kodo", replicas: 3, readyReplicas: 3 }, models: [{ name: "agent", backends: [{ backend: "openrouter" }] }] };
    assert.equal((await kernel.api("PUT", "/admin/cluster", report, { as: "root" })).status, 403);
    assert.equal((await kernel.api("PUT", "/admin/cluster", report)).status, 204);
    const overview = ok(await kernel.api("GET", "/admin/overview", undefined, { as: "root" }));
    assert.equal(overview.cluster.fleet.readyReplicas, 3);
    assert.ok(overview.cluster.reportedAt > 0);
  });
});
