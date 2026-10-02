import { sha256Hex } from "./http";
import { SES_SOURCE } from "./vendor/ses";

// The gadget that runs the agent's code: one bundle for every run, so the
// fleet loads it once per node however many runs there are (celld 0.6.0
// never releases a loaded bundle's memory). Every cell running it on a node
// shares one isolate, so the runner locks the isolate down with SES before
// any run: the shared built-ins are frozen, and each run evaluates in a
// Compartment of its own with a fresh global object. One run cannot change
// what another sees, and the code cannot reach the runner, the kernel's
// binding or anything but what it is given:
//
//   grants    one object per capability the session holds, keyed by it, with
//             fetch(path, {method, headers, body}) -> {status, ok, headers,
//             text(), json()}
//   input     the JSON value the agent passed
//   console   log, info, warn, error, debug; captured for the agent
//   Date, Math (with now() and random()), URL, URLSearchParams, atob,
//   btoa, crypto.randomUUID()
//
// The code works with text and JSON: it gets no ArrayBuffer, typed array,
// DataView, Atomics, WebAssembly, TextEncoder or TextDecoder, and nothing it
// is given holds one. Their memory is outside the isolate's heap, which
// celld limits (CELLD_V8_HEAP_LIMIT_MB), so one run could otherwise fill its
// node's memory faster than celld sheds load, and the node would be killed
// with every cell on it. On the heap, a run that grows too far is stopped
// and the isolate recovers.
//
// The cell calls __kodoRun(code, input) once and deletes itself afterwards.
const RUNNER_MODULE = `
import { Gadget } from "kodo";

// celld 0.6.0 implements TextDecoder.decode with a non-standard method on
// the prototype, which lockdown removes. Bind it into decode instead.
{
  const native = TextDecoder.prototype._decodeNative;
  if (typeof native === "function") {
    const { decode } = {
      decode(input, options = {}) {
        let bytes;
        if (input == null) bytes = new Uint8Array(0);
        else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        else throw new TypeError("TextDecoder.decode: input must be a BufferSource");
        return native.call(this, bytes, !!options?.stream);
      },
    };
    Object.defineProperty(TextDecoder.prototype, "decode", { value: decode, writable: true, configurable: true });
    delete TextDecoder.prototype._decodeNative;
  }
}

const hostCrypto = globalThis.crypto;
let broken = null;
try {
  lockdown({ errorTaming: "unsafe", consoleTaming: "unsafe" });
  for (const api of [URL, URLSearchParams, atob, btoa]) harden(api);
  if (new TextDecoder().decode(new TextEncoder().encode("ok")) !== "ok") throw new Error("TextDecoder fails");
  if (new URL("https://a.test/?q=1").searchParams.get("q") !== "1") throw new Error("URL fails");
} catch (err) {
  broken = String(err && err.message || err);
}
const CRYPTO = broken ? null : harden({ randomUUID: () => hostCrypto.randomUUID() });

// Built-ins whose memory is outside the heap, or that hand out objects
// whose constructors are.
const OFF_HEAP = Object.fromEntries([
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly", "TextEncoder", "TextDecoder",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
].map((name) => [name, undefined]));

const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 32 * 1024;
const MAX_LINE = 2048;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_ERROR = 4096;

const show = (value) => {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {}
  try { return String(value); } catch { return "[unprintable]"; }
};

const describe = (err) => {
  try {
    const text = err instanceof Error ? (err.stack || err.name + ": " + err.message) : show(err);
    return text.slice(0, MAX_ERROR);
  } catch {
    return "[unprintable error]";
  }
};

// A copy of a value as JSON, or an error if it is not JSON or too large.
const asJson = (value) => {
  let json;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch (err) {
    throw new Error("the result is not JSON: " + describe(err));
  }
  if (json === undefined) return null;
  if (json.length > MAX_RESULT_BYTES) throw new Error("the result is larger than " + MAX_RESULT_BYTES + " bytes of JSON");
  return JSON.parse(json);
};

const requestBody = (body, headers) => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  return JSON.stringify(body);
};

// A grant as the agent's code sees it: plain frozen data and functions,
// never a host object another run could also reach.
const wrapGrant = (grant, approvals) => harden({
  capability: grant.capability,
  fetch: async (path = "", init = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[String(k)] = String(v);
    const body = requestBody(init?.body, headers);
    const res = await grant.fetch(String(path), { method: String(init?.method ?? "GET"), headers, body });
    const bytes = await res.arrayBuffer();
    const out = {};
    for (const [k, v] of res.headers) out[k] = v;
    if (out["x-kodo-decision"] === "pending" && out["x-kodo-approval"]) {
      approvals.push({ id: out["x-kodo-approval"], capability: grant.capability });
    }
    const text = () => new TextDecoder().decode(bytes);
    return harden({
      status: res.status,
      ok: res.ok,
      headers: out,
      text: async () => text(),
      json: async () => JSON.parse(text()),
    });
  },
});

export class App extends Gadget {
  async fetch() {
    return new Response("not found\\n", { status: 404 });
  }

  // Runs the agent's code: the body of an async function. Returns
  // {ok, value, error, logs, approvals}; value is the code's return value as
  // JSON, approvals the calls it made that wait for the owner.
  async __kodoRun(code, input) {
    if (broken) return { ok: false, error: "the runner is not locked down: " + broken, logs: [], approvals: [] };
    const logs = [];
    let logBytes = 0;
    let dropped = 0;
    const log = (level) => (...args) => {
      const line = ((level === "log" ? "" : level + ": ") + args.map(show).join(" ")).slice(0, MAX_LINE);
      if (logs.length >= MAX_LOG_LINES || logBytes + line.length > MAX_LOG_BYTES) {
        dropped++;
        return;
      }
      logs.push(line);
      logBytes += line.length;
    };
    const approvals = [];
    const grants = {};
    for (const [capability, grant] of Object.entries(this.grants)) grants[capability] = wrapGrant(grant, approvals);
    const compartment = new Compartment({
      globals: {
        ...OFF_HEAP,
        grants: harden(grants),
        input: harden(asJson(input)),
        console: harden({ log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") }),
        Date,
        Math,
        URL,
        URLSearchParams,
        atob,
        btoa,
        crypto: CRYPTO,
      },
      __options__: true,
    });
    let value = null;
    let error;
    try {
      const run = compartment.evaluate("(async function () {\\n" + String(code) + "\\n})");
      value = asJson(await run());
    } catch (err) {
      error = describe(err);
    }
    if (dropped) logs.push("[" + dropped + " more log lines dropped]");
    return error === undefined
      ? { ok: true, value, logs, approvals: [...approvals] }
      : { ok: false, error, logs, approvals: [...approvals] };
  }
}
`;

export const RUNNER_SOURCE = `${SES_SOURCE}\n${RUNNER_MODULE}`;

let digest: Promise<string> | undefined;

// The runner's digest. Its bundle is stored by digest like any gadget's.
export function runnerDigest(): Promise<string> {
  digest ??= sha256Hex(new TextEncoder().encode(RUNNER_SOURCE));
  return digest;
}
