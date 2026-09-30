import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";

// What the cell hands a gadget in `ctx.props`. The gadget passes it back to
// the kernel on every host call, and the token proves which cell it is.
export interface CellProps {
  cell: string;
  token: string;
}

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

function key(env: Env): Promise<CryptoKey> {
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

export async function cellProps(env: Env, cell: string): Promise<CellProps> {
  const mac = await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(cell));
  return { cell, token: btoa(String.fromCharCode(...new Uint8Array(mac))) };
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
  const ok = await crypto.subtle.verify("HMAC", await key(env), mac, new TextEncoder().encode(cell));
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
}

// The module the kernel adds beside every gadget as "kodo". Gadgets extend
// Gadget to reach the host; a gadget that extends DurableObject directly
// still works but cannot schedule.
export const GADGET_RUNTIME = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  // The id of the cell this gadget instance runs in.
  get cellId() {
    return this.ctx.props.cell;
  }

  // Asks the cell to call onAlarm() at \`when\` (a Date or epoch milliseconds).
  // Replaces any earlier request.
  setAlarm(when) {
    return this.env.KODO.setAlarm(this.ctx.props, typeof when === "number" ? when : when.getTime());
  }

  deleteAlarm() {
    return this.env.KODO.deleteAlarm(this.ctx.props);
  }
}
`;
