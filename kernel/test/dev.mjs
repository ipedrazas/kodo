// Runs the kernel under `celld dev` for the tests, from a temporary copy of
// the project (celld requires `main` inside the project), so .dev.vars and
// the local state stay out of the repository. Needs celld and esbuild on PATH.
// Paths given to publish() are relative to the kernel directory.
//
// The harness plays the identity provider: it serves a JWKS and mints ID
// tokens for test users, and holds an admin token.
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
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

export async function startKernel({ vars = {}, env = {} } = {}) {
  const idp = await startIdentityProvider();
  const adminToken = randomBytes(16).toString("hex");

  const dir = await mkdtemp(join(tmpdir(), "kodo-kernel-"));
  await cp(join(kernel, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
  await cp(join(kernel, "src"), join(dir, "src"), { recursive: true });
  const allVars = {
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URL: idp.jwksUrl,
    ADMIN_TOKEN_SHA256: createHash("sha256").update(adminToken).digest("hex"),
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
    const payload = b64({ iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 300, ...claims });
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
