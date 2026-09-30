import { DurableObject } from "cloudflare:workers";
import type { BlueprintVersion } from "./catalog";
import type { Env } from "./env";
import { newCellId } from "./names";

export interface CellRecord {
  id: string;
  blueprint: string;
  version: string;
  createdAt: number;
}

export interface WorkspaceInfo {
  name: string;
  quota: number;
  cells: number;
}

export type WorkspaceResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;

// The registry of one workspace: its settings and its cells. A cell is served
// only while its workspace has bound it; removing it here unbinds it.
export class Workspace extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cells (
      id TEXT PRIMARY KEY,
      blueprint TEXT NOT NULL,
      version TEXT NOT NULL,
      created_at INTEGER NOT NULL
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

  async createCell(blueprint: BlueprintVersion): Promise<WorkspaceResult<CellRecord>> {
    const info = this.info();
    if (!info) return fail(404, "workspace does not exist");
    if (info.cells >= info.quota) return fail(409, `workspace quota of ${info.quota} cells reached`);

    const record: CellRecord = {
      id: newCellId(),
      blueprint: blueprint.name,
      version: blueprint.version,
      createdAt: Date.now(),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO cells VALUES (?, ?, ?, ?)",
      record.id,
      record.blueprint,
      record.version,
      record.createdAt,
    );
    try {
      await this.env.CELL.getByName(record.id).bind({ workspace: info.name, blueprint });
    } catch (err) {
      this.ctx.storage.sql.exec("DELETE FROM cells WHERE id = ?", record.id);
      throw err;
    }
    return { ok: true, value: record };
  }

  listCells(): CellRecord[] {
    return this.ctx.storage.sql
      .exec<{ id: string; blueprint: string; version: string; created_at: number }>(
        "SELECT * FROM cells ORDER BY created_at, id",
      )
      .toArray()
      .map((r) => ({ id: r.id, blueprint: r.blueprint, version: r.version, createdAt: r.created_at }));
  }

  getCell(id: string): CellRecord | null {
    return this.listCells().find((c) => c.id === id) ?? null;
  }

  // Moves a cell to another version of the same Blueprint. The gadget keeps
  // its storage; the new code runs from its next call.
  async moveCell(id: string, blueprint: BlueprintVersion): Promise<WorkspaceResult<CellRecord>> {
    const info = this.info();
    const cell = this.getCell(id);
    if (!info || !cell) return fail(404, "cell does not exist in this workspace");
    if (cell.blueprint !== blueprint.name) {
      return fail(400, `cell runs ${cell.blueprint}, not ${blueprint.name}`);
    }
    await this.env.CELL.getByName(id).bind({ workspace: info.name, blueprint });
    this.ctx.storage.sql.exec("UPDATE cells SET version = ? WHERE id = ?", blueprint.version, id);
    return { ok: true, value: { ...cell, version: blueprint.version } };
  }

  // Deletes a cell and its gadget's storage.
  async deleteCell(id: string): Promise<WorkspaceResult<null>> {
    if (!this.getCell(id)) return fail(404, "cell does not exist in this workspace");
    await this.env.CELL.getByName(id).unbind();
    this.ctx.storage.sql.exec("DELETE FROM cells WHERE id = ?", id);
    return { ok: true, value: null };
  }

  private count(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM cells").one().n;
  }
}
