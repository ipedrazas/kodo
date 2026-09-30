// Runs the kernel under `celld dev` for the tests, from a temporary copy of
// the project (celld requires `main` inside the project), so .dev.vars and
// the local state stay out of the repository. Needs celld and esbuild on PATH.
// Paths given to publish() are relative to the kernel directory.
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const kernel = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function startKernel({ vars = {}, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kodo-kernel-"));
  await cp(join(kernel, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
  await cp(join(kernel, "src"), join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, ".dev.vars"),
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n"),
  );

  const port = 20000 + Math.floor(Math.random() * 20000);
  const logs = [];
  const child = spawn("celld", ["dev", dir, "--port", String(port), "--no-watch", "--logs"], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  const kernelApi = {
    port,
    logs: () => logs.join(""),
    request: (host, path = "/", options = {}) => request(port, host, path, options),
    socket: (host) => socket(port, host),
    // Calls the kernel API. Returns {status, body} with body parsed as JSON
    // when it is JSON.
    api: async (method, path, body) => {
      const res = await request(port, "api.test", `/api${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
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
    // Creates a cell in a workspace and returns its record.
    createCell: async (workspace, blueprint, version) => {
      const res = await kernelApi.api("POST", `/workspaces/${workspace}/cells`, { blueprint, version });
      if (res.status !== 201) throw new Error(`create cell failed: ${JSON.stringify(res)}`);
      return res.body;
    },
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      await rm(dir, { recursive: true, force: true });
    },
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`celld dev exited:\n${kernelApi.logs()}`);
    try {
      if ((await request(port, "localhost", "/")).status === 404) return kernelApi;
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
function socket(port, host) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host } });
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
