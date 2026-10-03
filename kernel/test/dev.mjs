// Runs the kernel under `celld dev` for the tests, from a temporary copy of
// the project (celld requires `main` inside the project), so .dev.vars and
// the local state stay out of the repository. Needs celld and esbuild on PATH.
// Paths given to publish() are relative to the kernel directory.
//
// The harness plays the identity provider: it serves a JWKS and mints ID
// tokens for test users, and holds an admin token. With `gatekeeper` set it
// also plays the Gatekeeper: it checks each call's signature, records it, and
// answers with `gatekeeper(call)` if that is a function ({status, headers,
// body, usage?}), or else 200 with the call it received as the body. Approval
// queries are answered from `gatekeeper.approvals`, a Map of id to status
// ({state, ...}) that tests fill in; queries are kept in `queries`. Audit
// events (a Blueprint version authored or published, an admin's action) are
// kept in `events`; set `gatekeeper.refuseEvents` to answer them 503. Audit
// searches are kept in `auditQueries` and answered with `auditRecords`.
//
// "root" (root@test) is a platform admin, through the bootstrap emails.
// `workspace(name, body)` creates a workspace with the admin token, with
// alice, bob, carol and dave as members.
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const kernel = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ISSUER = "https://auth.test";
export const AUDIENCE = "kodo";

// Test users: the subject is the name, the email is <name>@test.
export const user = (name) => ({ sub: `sub-${name}`, email: `${name}@test` });

export async function startKernel({ vars = {}, env = {}, gatekeeper = false } = {}) {
  const idp = await startIdentityProvider();
  const adminToken = randomBytes(16).toString("hex");
  const gk = gatekeeper ? await startGatekeeper(typeof gatekeeper === "function" ? gatekeeper : undefined) : null;
  if (gk) vars = { GATEKEEPER_URL: gk.url, GATEKEEPER_KEY: gk.key, FLEET_ID: gk.fleet, ...vars };

  const dir = await mkdtemp(join(tmpdir(), "kodo-kernel-"));
  await cp(join(kernel, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
  await cp(join(kernel, "src"), join(dir, "src"), { recursive: true });
  const allVars = {
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URL: idp.jwksUrl,
    ADMIN_TOKEN_SHA256: createHash("sha256").update(adminToken).digest("hex"),
    PLATFORM_ADMIN_EMAILS: "root@test",
    ...vars,
  };
  await writeFile(join(dir, ".dev.vars"), Object.entries(allVars).map(([k, v]) => `${k}=${v}`).join("\n"));

  const port = 20000 + Math.floor(Math.random() * 20000);
  const logs = [];
  const child = spawn("celld", ["dev", dir, "--port", String(port), "--no-watch", "--logs"], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  // `as` is a test user name, "admin", a raw token (as: {token}), or null for
  // no identity.
  const identity = (as) => {
    if (as === null) return {};
    if (as === "admin") return { "x-kodo-admin-token": adminToken };
    if (typeof as === "object") return { "x-kodo-identity": as.token };
    return { "x-kodo-identity": idp.token(user(as)) };
  };

  const kernelApi = {
    port,
    idp,
    adminToken,
    gatekeeper: gk,
    logs: () => logs.join(""),
    // A request to any host, by default as alice.
    request: (host, path = "/", { as = "alice", headers = {}, ...options } = {}) =>
      request(port, host, path, { ...options, headers: { ...identity(as), ...headers } }),
    socket: (host, { as = "alice", headers = {} } = {}) => socket(port, host, { ...identity(as), ...headers }),
    // Calls the kernel API, by default with the admin token. Returns
    // {status, body} with body parsed as JSON when it is JSON.
    api: async (method, path, body, { as = "admin", headers = {} } = {}) => {
      const res = await request(port, "api.test", `/api${path}`, {
        method,
        headers: {
          ...identity(as),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      let parsed = res.body;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        // Not JSON.
      }
      return { status: res.status, body: parsed };
    },
    // Creates or updates a workspace with the test users as members.
    workspace: async (name, body = {}) => {
      const members = Object.fromEntries(["alice", "bob", "carol", "dave"].map((n) => [`${n}@test`, "member"]));
      const res = await kernelApi.api("PUT", `/workspaces/${name}`, { ...body, members: { ...members, ...body.members } });
      if (res.status !== 200) throw new Error(`workspace failed: ${JSON.stringify(res)}`);
      return res.body;
    },
    // Uploads a gadget file and publishes it as blueprint name@version.
    publish: async (file, name, version) => {
      const source = await readFile(resolve(kernel, file));
      const upload = await kernelApi.api("POST", "/bundles", source);
      if (upload.status !== 201) throw new Error(`upload failed: ${JSON.stringify(upload)}`);
      const res = await kernelApi.api("PUT", `/blueprints/${name}/${version}`, { bundle: upload.body.digest });
      if (res.status !== 201) throw new Error(`publish failed: ${JSON.stringify(res)}`);
      return res.body;
    },
    // Creates a cell in a workspace, by default owned by alice.
    createCell: async (workspace, blueprint, version, as = "alice") => {
      const res = await kernelApi.api("POST", `/workspaces/${workspace}/cells`, { blueprint, version }, { as });
      if (res.status !== 201) throw new Error(`create cell failed: ${JSON.stringify(res)}`);
      return res.body;
    },
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      idp.close();
      gk?.close();
      await rm(dir, { recursive: true, force: true });
    },
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`celld dev exited:\n${kernelApi.logs()}`);
    try {
      // Any answer from the kernel means the deployment is serving.
      if ([401, 404].includes((await request(port, "localhost", "/nothing")).status)) return kernelApi;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await kernelApi.stop();
      throw new Error(`celld dev did not start:\n${kernelApi.logs()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// A stand-in Gatekeeper. Calls with a bad signature are answered 401 and
// counted in `rejected`; good ones are kept in `calls`.
const echo = (call) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(call) });

async function startGatekeeper(answer = echo) {
  const key = randomBytes(32).toString("hex");
  const fleet = "test/kodo";
  const calls = [];
  const queries = [];
  const approvals = new Map();
  const events = [];
  const auditQueries = [];
  let rejected = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const ts = req.headers["x-kodo-timestamp"];
      const want = Buffer.from("v1=" + createHmac("sha256", key).update(`${ts}.${body}`).digest("hex"));
      const got = Buffer.from(String(req.headers["x-kodo-signature"] ?? ""));
      const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 60;
      if (req.headers["x-kodo-fleet"] !== fleet || !fresh || got.length !== want.length || !timingSafeEqual(got, want)) {
        rejected++;
        res.statusCode = 401;
        res.end("bad signature\n");
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/approvals/query") {
        const query = JSON.parse(body);
        queries.push(query);
        const answer = query.ids.map((id) => {
          const a = approvals.get(id);
          if (!a || a.cell !== query.cell) return { id, state: "unknown" };
          const { cell, ...status } = a;
          return {
            id,
            ...status,
            ...(a.result ? { result: { ...a.result, body: Buffer.from(a.result.body ?? "").toString("base64") } } : {}),
          };
        });
        res.end(JSON.stringify({ approvals: answer }));
        return;
      }
      if (req.url === "/v1/events") {
        if (gk.refuseEvents) {
          res.statusCode = 503;
          res.end("the audit log is unavailable\n");
          return;
        }
        events.push(JSON.parse(body));
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.url === "/v1/audit/query") {
        const query = JSON.parse(body);
        auditQueries.push(query);
        res.end(JSON.stringify({ records: gk.auditRecords, scanned: gk.auditRecords.length, truncated: false }));
        return;
      }
      if (req.url !== "/v1/calls") {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      const call = JSON.parse(body);
      calls.push(call);
      const a = answer(call);
      res.end(JSON.stringify({
        status: a.status,
        headers: { "x-kodo-decision": "allowed", ...a.headers },
        body: Buffer.from(a.body ?? "").toString("base64"),
        ...(a.usage ? { usage: a.usage } : {}),
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const gk = {
    url: `http://127.0.0.1:${server.address().port}`,
    key,
    fleet,
    calls,
    events,
    refuseEvents: false,
    auditQueries,
    auditRecords: [],
    queries,
    approvals,
    rejected: () => rejected,
    close: () => server.close(),
  };
  return gk;
}

// A minimal OIDC signer: an RSA key served as a JWKS, and ID tokens for it.
async function startIdentityProvider() {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

  // Claims default to a valid token; override any, or set signWith: "other"
  // or alg: "none" to produce an invalid one.
  const token = (claims, { signWith = "key", alg = "RS256" } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg, kid: "test-key", typ: "JWT" });
    const payload = b64({ iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 300, email_verified: true, ...claims });
    if (alg === "none") return `${header}.${payload}.`;
    const signer = signWith === "other" ? other.privateKey : key.privateKey;
    return `${header}.${payload}.${sign("sha256", Buffer.from(`${header}.${payload}`), signer).toString("base64url")}`;
  };
  return {
    jwksUrl: `http://127.0.0.1:${server.address().port}/keys`,
    token,
    close: () => server.close(),
  };
}

function request(port, host, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: { ...headers, host } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// Opens a WebSocket and collects its messages and close event.
function socket(port, host, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { ...headers, host } });
  const messages = [];
  const waiters = [];
  const closed = new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
  ws.on("message", (data) => {
    messages.push(String(data));
    waiters.splice(0).forEach((w) => w());
  });
  return {
    opened: new Promise((r, reject) => {
      ws.once("open", r);
      ws.once("error", reject);
      ws.once("unexpected-response", (_, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    }),
    send: (m) => ws.send(m),
    next: async () => {
      while (messages.length === 0) await new Promise((r) => waiters.push(r));
      return messages.shift();
    },
    closed,
    close: () => ws.close(),
  };
}
