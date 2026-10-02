import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { gatekeeperConfig } from "./config";
import type { Env } from "./env";
import { isCapability } from "./names";

// What the cell hands a gadget in `ctx.props`. The gadget passes it back to
// the kernel on every host call, and the token proves which cell it is. The
// grants only tell the gadget runtime which bindings to create; the kernel
// asserts the cell's actual grants to the Gatekeeper on every call.
export interface CellProps {
  cell: string;
  token: string;
  grants?: string[];
}

// A gadget's request on one of its capability bindings.
export interface CapabilityRequest {
  method: string;
  // Relative to the capability's resource, with any query string, e.g.
  // "/readme" on github:repo/acme/api:read.
  path: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
}

export interface CapabilityResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

// What a gadget learns about a call that waited for its owner's approval.
// The state is pending, executing, done (result holds the provider's
// answer), failed, rejected, expired, or unknown for an id that is not this
// cell's.
export interface ApprovalStatus {
  id: string;
  state: string;
  capability?: string;
  reason?: string;
  createdAt?: string;
  decidedAt?: string;
  result?: CapabilityResponse;
}

// States after which an approval never changes.
export const SETTLED = new Set(["done", "failed", "rejected", "expired", "unknown"]);

// Headers that sign a call from the kernel to the Gatekeeper.
export const FLEET_HEADER = "x-kodo-fleet";
export const TIMESTAMP_HEADER = "x-kodo-timestamp";
export const SIGNATURE_HEADER = "x-kodo-signature";

// Above the Gatekeeper's own limits (20 s for a model call), so it answers
// first, and below a gadget call's 30 s.
const GATEKEEPER_TIMEOUT_MS = 25_000;
const MAX_REQUEST_BODY = 1024 * 1024;

// Holds the kernel's signing key: created on first use, stored in this
// object's database, shared by every node of the fleet.
export class Keys extends DurableObject<Env> {
  secret(): string {
    let secret = this.ctx.storage.kv.get<string>("cell-token-key");
    if (!secret) {
      secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      this.ctx.storage.kv.put("cell-token-key", secret);
    }
    return secret;
  }
}

let signingKey: Promise<CryptoKey> | undefined;

// The kernel's own HMAC key, from Keys. It signs each cell's props, and,
// with a "turn:" prefix, the agent's turn tokens.
export function kernelKey(env: Env): Promise<CryptoKey> {
  signingKey ??= env.KEYS.getByName("kernel")
    .secret()
    .then((secret) =>
      crypto.subtle.importKey(
        "raw",
        Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    )
    .catch((err) => {
      signingKey = undefined;
      throw err;
    });
  return signingKey;
}

export async function cellProps(env: Env, cell: string, grants: string[] = []): Promise<CellProps> {
  const mac = await crypto.subtle.sign("HMAC", await kernelKey(env), new TextEncoder().encode(cell));
  return { cell, token: btoa(String.fromCharCode(...new Uint8Array(mac))), grants };
}

async function verified(env: Env, props: unknown): Promise<string> {
  const { cell, token } = (props ?? {}) as Partial<CellProps>;
  if (typeof cell !== "string" || typeof token !== "string") throw new Error("invalid cell props");
  let mac: Uint8Array;
  try {
    mac = Uint8Array.from(atob(token), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("invalid cell props");
  }
  const ok = await crypto.subtle.verify("HMAC", await kernelKey(env), mac, new TextEncoder().encode(cell));
  if (!ok) throw new Error("invalid cell props");
  return cell;
}

// The one binding every gadget gets, as `env.KODO`. Each call names the cell
// it acts for through the props the cell issued, so a gadget can only act
// for its own cell.
export class GadgetHost extends WorkerEntrypoint<Env> {
  async setAlarm(props: CellProps, when: number): Promise<void> {
    if (typeof when !== "number" || !Number.isFinite(when)) throw new Error("alarm time must be a number");
    await this.env.CELL.getByName(await verified(this.env, props)).setGadgetAlarm(when);
  }

  async deleteAlarm(props: CellProps): Promise<void> {
    await this.env.CELL.getByName(await verified(this.env, props)).deleteGadgetAlarm();
  }

  // A call on one of the gadget's capability bindings. The kernel asserts the
  // cell, its owner and its grants to the Gatekeeper, which decides, holds
  // the owner's token, makes the call and records it. Tokens never come back.
  async call(props: CellProps, capability: string, request: CapabilityRequest): Promise<CapabilityResponse> {
    const cell = await verified(this.env, props);
    if (!isCapability(capability)) throw new Error("not a capability: " + String(capability));
    const method = String(request?.method ?? "GET").toUpperCase();
    const path = String(request?.path ?? "");
    if (path && !path.startsWith("/") && !path.startsWith("?")) throw new Error("path must start with /");
    const body = request?.body;
    if (body !== undefined && !(body instanceof ArrayBuffer)) throw new Error("body must be an ArrayBuffer");
    if (body && body.byteLength > MAX_REQUEST_BODY) throw new Error("request body larger than 1 MiB");

    const context = await this.env.CELL.getByName(cell).callContext();
    if (!context) return denied(404, `cell ${cell} does not exist`);
    if ("refused" in context) return denied(context.status, context.refused);

    let res: Response;
    try {
      res = await gatekeeper(this.env, "/v1/calls", {
        ...context,
        cell,
        capability,
        request: {
          method,
          path,
          headers: stringHeaders(request?.headers),
          ...(body && body.byteLength ? { body: toBase64(new Uint8Array(body)) } : {}),
        },
      });
    } catch (err) {
      if (err instanceof GatekeeperError) return denied(err.status, err.message);
      throw err;
    }
    const raw = (await res.json()) as Answer;
    const answer = fromAnswer(raw);
    // What a metered call (a model call) consumed is counted for the cell;
    // the gadget sees only the response.
    if (raw.usage) {
      try {
        await this.env.CELL.getByName(cell).recordUsage(capability, raw.usage);
      } catch (err) {
        console.log(`cell ${cell}: counting usage failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    // A call parked for approval: the cell follows it and tells the gadget
    // how it ends.
    const approval = answer.headers["x-kodo-approval"];
    if (answer.headers["x-kodo-decision"] === "pending" && approval) {
      await this.env.CELL.getByName(cell).trackApproval(approval, capability);
    }
    return answer;
  }

  // The state of one of this cell's approvals.
  async approval(props: CellProps, id: string): Promise<ApprovalStatus> {
    const cell = await verified(this.env, props);
    if (typeof id !== "string" || !id) throw new Error("approval id must be a string");
    const [status] = await this.env.CELL.getByName(cell).queryApprovals([id]);
    return status;
  }
}

// An answer from the Gatekeeper, with the body base64-encoded, and what the
// call consumed if its provider is metered.
interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  usage?: TokenUsage;
}

// Tokens one model call used, as its backend reported them.
export interface TokenUsage {
  model?: string;
  input: number;
  output: number;
  total: number;
}

function fromAnswer(answer: Answer): CapabilityResponse {
  return {
    status: answer.status,
    headers: answer.headers ?? {},
    body: answer.body ? (fromBase64(answer.body).buffer as ArrayBuffer) : new ArrayBuffer(0),
  };
}

// The Gatekeeper's answer about some of a cell's approvals.
export function fromApprovals(statuses: (Omit<ApprovalStatus, "result"> & { result?: Answer })[]): ApprovalStatus[] {
  return statuses.map((s) => ({ ...s, result: s.result ? fromAnswer(s.result) : undefined }));
}

// A request to the Gatekeeper that it did not answer, or refused.
export class GatekeeperError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Sends a signed request to the Gatekeeper and returns its 200 answer.
export async function gatekeeper(env: Env, path: string, body: unknown): Promise<Response> {
  const config = gatekeeperConfig(env);
  if (!config.url || !config.key || !config.fleet) throw new GatekeeperError(503, "this fleet has no Gatekeeper configured");
  const payload = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await fetch(new URL(path, config.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [FLEET_HEADER]: config.fleet,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: "v1=" + (await sign(config.key, `${timestamp}.${payload}`)),
      },
      body: payload,
      signal: AbortSignal.timeout(GATEKEEPER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GatekeeperError(502, `gatekeeper unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new GatekeeperError(502, `gatekeeper refused the call: ${res.status} ${(await res.text()).trim()}`);
  return res;
}

function denied(status: number, error: string): CapabilityResponse {
  return {
    status,
    headers: { "content-type": "application/json", "x-kodo-decision": "error" },
    body: new TextEncoder().encode(JSON.stringify({ error })).buffer as ArrayBuffer,
  };
}

function stringHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

async function sign(key: string, message: string): Promise<string> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// The module the kernel adds beside every gadget as "kodo". Gadgets extend
// Gadget to reach the host; a gadget that extends DurableObject directly
// still works but cannot schedule or use its grants.
export const GADGET_RUNTIME = `
import { DurableObject } from "cloudflare:workers";

const toResponse = (res) => {
  const empty = res.body.byteLength === 0 || [204, 205, 304].includes(res.status);
  return new Response(empty ? null : res.body, { status: res.status, headers: res.headers });
};

// An approval as the gadget sees it: the provider's answer, once there is
// one, as a Response.
const toApproval = (a) => Object.freeze({
  id: a.id,
  capability: a.capability ?? null,
  state: a.state,
  reason: a.reason ?? null,
  createdAt: a.createdAt ? new Date(a.createdAt) : null,
  decidedAt: a.decidedAt ? new Date(a.decidedAt) : null,
  response: a.result ? toResponse(a.result) : null,
});

// One granted capability. fetch() takes a path relative to the capability's
// resource and returns a Response; the Gatekeeper makes the actual call with
// the owner's credentials, which the gadget never sees. A call that sends,
// writes or deletes waits for the owner's approval: fetch() answers 202 with
// x-kodo-decision: pending and the approval's id in x-kodo-approval.
class Grant {
  #call;

  constructor(capability, call) {
    this.capability = capability;
    this.#call = call;
    Object.freeze(this);
  }

  async fetch(path = "", init = {}) {
    const headers = {};
    for (const [k, v] of new Headers(init.headers ?? {})) headers[k] = v;
    const body = init.body == null ? undefined : await new Response(init.body).arrayBuffer();
    const res = await this.#call((host, props) => host.call(props, this.capability, {
      method: (init.method ?? "GET").toUpperCase(),
      path,
      headers,
      body,
    }));
    return toResponse(res);
  }
}

export class Gadget extends DurableObject {
  #grants;
  #warm;

  // Every call to the host goes through here. On a freshly loaded gadget,
  // celld 0.6.0 hangs a burst of concurrent host calls, so the first call
  // goes alone and the others wait for it; after that they run concurrently.
  #host(fn) {
    if (this.#warm) return this.#warm.then(() => fn(this.env.KODO, this.ctx.props));
    const first = fn(this.env.KODO, this.ctx.props);
    this.#warm = first.then(
      () => {},
      () => { this.#warm = undefined; },
    );
    return first;
  }

  // The id of the cell this gadget instance runs in.
  get cellId() {
    return this.ctx.props.cell;
  }

  // One binding per capability the cell's owner granted, keyed by the
  // capability, e.g. this.grants["github:repo/acme/api:read"]. A capability
  // that was not granted has no binding.
  get grants() {
    this.#grants ??= Object.freeze(
      Object.fromEntries((this.ctx.props.grants ?? []).map((c) => [c, new Grant(c, (fn) => this.#host(fn))])),
    );
    return this.#grants;
  }

  // Asks the cell to call onAlarm() at \`when\` (a Date or epoch milliseconds).
  // Replaces any earlier request.
  setAlarm(when) {
    const at = typeof when === "number" ? when : when.getTime();
    return this.#host((host, props) => host.setAlarm(props, at));
  }

  deleteAlarm() {
    return this.#host((host, props) => host.deleteAlarm(props));
  }

  // The state of an approval one of this cell's calls is waiting on, by id:
  // {id, capability, state, reason, createdAt, decidedAt, response}.
  async approval(id) {
    return toApproval(await this.#host((host, props) => host.approval(props, id)));
  }

  // Called by the cell to measure the gadget's database for usage reports.
  __kodoStorageBytes() {
    return this.ctx.storage.sql.databaseSize;
  }

  // Called by the cell when an approval this cell is waiting on settles.
  async __kodoApprovalSettled(status) {
    if (typeof this.onApproval === "function") await this.onApproval(toApproval(status));
  }
}
`;
