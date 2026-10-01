import { DurableObject } from "cloudflare:workers";
import type { BlueprintVersion } from "./catalog";
import type { Env } from "./env";
import { covers, newCellId } from "./names";

export type ShareRole = "viewer" | "editor";

export interface Owner {
  user: string;
  email: string;
}

export interface CellRecord {
  id: string;
  blueprint: string;
  version: string;
  owner: Owner;
  // Email -> role for everyone the owner has shared the cell with.
  shares: Record<string, ShareRole>;
  // Capabilities the owner has granted this cell, each covered by one its
  // Blueprint version declares.
  grants: string[];
  createdAt: number;
}

export interface WorkspaceInfo {
  name: string;
  quota: number;
  cells: number;
}

export type WorkspaceResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;

// The registry of one workspace: its settings, its cells, their owners and
// who they are shared with. A cell is served only while its workspace has
// bound it; removing it here unbinds it.
export class Workspace extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cells (
      id TEXT PRIMARY KEY,
      blueprint TEXT NOT NULL,
      version TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // Added in Phase 5; cells created before then have no owner.
    const columns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(cells)").toArray().map((c) => c.name);
    if (!columns.includes("owner_user")) {
      ctx.storage.sql.exec("ALTER TABLE cells ADD COLUMN owner_user TEXT NOT NULL DEFAULT ''");
      ctx.storage.sql.exec("ALTER TABLE cells ADD COLUMN owner_email TEXT NOT NULL DEFAULT ''");
    }
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS shares (
      cell TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (cell, email)
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS grants (
      cell TEXT NOT NULL,
      capability TEXT NOT NULL,
      PRIMARY KEY (cell, capability)
    )`);
  }

  configure(name: string, quota: number): WorkspaceInfo {
    this.ctx.storage.kv.put("name", name);
    this.ctx.storage.kv.put("quota", quota);
    return this.info()!;
  }

  info(): WorkspaceInfo | null {
    const name = this.ctx.storage.kv.get<string>("name");
    if (name === undefined) return null;
    return { name, quota: this.ctx.storage.kv.get<number>("quota") ?? 0, cells: this.count() };
  }

  async createCell(blueprint: BlueprintVersion, owner: Owner): Promise<WorkspaceResult<CellRecord>> {
    const info = this.info();
    if (!info) return fail(404, "workspace does not exist");
    if (info.cells >= info.quota) return fail(409, `workspace quota of ${info.quota} cells reached`);

    const record: CellRecord = {
      id: newCellId(),
      blueprint: blueprint.name,
      version: blueprint.version,
      owner,
      shares: {},
      grants: [],
      createdAt: Date.now(),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO cells (id, blueprint, version, created_at, owner_user, owner_email) VALUES (?, ?, ?, ?, ?, ?)",
      record.id,
      record.blueprint,
      record.version,
      record.createdAt,
      owner.user,
      owner.email,
    );
    try {
      await this.env.CELL.getByName(record.id).bind({ workspace: info.name, blueprint, owner, shares: {}, grants: [] });
    } catch (err) {
      this.ctx.storage.sql.exec("DELETE FROM cells WHERE id = ?", record.id);
      throw err;
    }
    return { ok: true, value: record };
  }

  listCells(): CellRecord[] {
    const shares = new Map<string, Record<string, ShareRole>>();
    for (const s of this.ctx.storage.sql.exec<{ cell: string; email: string; role: ShareRole }>("SELECT * FROM shares")) {
      shares.set(s.cell, { ...shares.get(s.cell), [s.email]: s.role });
    }
    const grants = new Map<string, string[]>();
    for (const g of this.ctx.storage.sql.exec<{ cell: string; capability: string }>(
      "SELECT * FROM grants ORDER BY capability",
    )) {
      grants.set(g.cell, [...(grants.get(g.cell) ?? []), g.capability]);
    }
    return this.ctx.storage.sql
      .exec<{
        id: string;
        blueprint: string;
        version: string;
        created_at: number;
        owner_user: string;
        owner_email: string;
      }>("SELECT * FROM cells ORDER BY created_at, id")
      .toArray()
      .map((r) => ({
        id: r.id,
        blueprint: r.blueprint,
        version: r.version,
        owner: { user: r.owner_user, email: r.owner_email },
        shares: shares.get(r.id) ?? {},
        grants: grants.get(r.id) ?? [],
        createdAt: r.created_at,
      }));
  }

  getCell(id: string): CellRecord | null {
    return this.listCells().find((c) => c.id === id) ?? null;
  }

  // Moves a cell to another version of the same Blueprint. The gadget keeps
  // its storage; the new code runs from its next call. Grants the new
  // version does not declare are dropped.
  async moveCell(id: string, blueprint: BlueprintVersion): Promise<WorkspaceResult<CellRecord>> {
    const info = this.info();
    const cell = this.getCell(id);
    if (!info || !cell) return fail(404, "cell does not exist in this workspace");
    if (cell.blueprint !== blueprint.name) {
      return fail(400, `cell runs ${cell.blueprint}, not ${blueprint.name}`);
    }
    const grants = cell.grants.filter((g) => blueprint.capabilities.some((c) => covers(c, g)));
    await this.env.CELL.getByName(id).bind({
      workspace: info.name,
      blueprint,
      owner: cell.owner,
      shares: cell.shares,
      grants,
    });
    this.ctx.storage.sql.exec("UPDATE cells SET version = ? WHERE id = ?", blueprint.version, id);
    this.writeGrants(id, grants);
    return { ok: true, value: { ...cell, version: blueprint.version, grants } };
  }

  // Replaces the capabilities granted to a cell. The caller has checked them
  // against the cell's Blueprint version.
  async setGrants(id: string, grants: string[]): Promise<WorkspaceResult<CellRecord>> {
    if (!this.getCell(id)) return fail(404, "cell does not exist in this workspace");
    this.writeGrants(id, grants);
    const cell = this.getCell(id)!;
    await this.env.CELL.getByName(id).setGrants(cell.grants);
    return { ok: true, value: cell };
  }

  // Shares a cell with a user by email, or changes their role.
  async share(id: string, email: string, role: ShareRole): Promise<WorkspaceResult<CellRecord>> {
    if (!this.getCell(id)) return fail(404, "cell does not exist in this workspace");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO shares VALUES (?, ?, ?)", id, email, role);
    return this.pushShares(id);
  }

  // Revokes a user's access to a cell.
  async unshare(id: string, email: string): Promise<WorkspaceResult<CellRecord>> {
    if (!this.getCell(id)) return fail(404, "cell does not exist in this workspace");
    this.ctx.storage.sql.exec("DELETE FROM shares WHERE cell = ? AND email = ?", id, email);
    return this.pushShares(id);
  }

  // Deletes a cell and its gadget's storage.
  async deleteCell(id: string): Promise<WorkspaceResult<null>> {
    if (!this.getCell(id)) return fail(404, "cell does not exist in this workspace");
    await this.env.CELL.getByName(id).unbind();
    this.ctx.storage.sql.exec("DELETE FROM cells WHERE id = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM shares WHERE cell = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM grants WHERE cell = ?", id);
    return { ok: true, value: null };
  }

  private writeGrants(id: string, grants: string[]): void {
    this.ctx.storage.sql.exec("DELETE FROM grants WHERE cell = ?", id);
    for (const g of new Set(grants)) this.ctx.storage.sql.exec("INSERT INTO grants VALUES (?, ?)", id, g);
  }

  private async pushShares(id: string): Promise<WorkspaceResult<CellRecord>> {
    const cell = this.getCell(id)!;
    await this.env.CELL.getByName(id).setShares(cell.shares);
    return { ok: true, value: cell };
  }

  private count(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM cells").one().n;
  }
}
