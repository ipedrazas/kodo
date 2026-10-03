import { DurableObject } from "cloudflare:workers";
import type { BlueprintVersion } from "./catalog";
import type { CellUsage, ModelUsage } from "./cell";
import type { Env } from "./env";
import { covers, newCellId, newId } from "./names";
import type { SessionInfo } from "./session";

export type ShareRole = "viewer" | "editor";

// A member's role in a workspace: a viewer sees it, a member also creates
// cells and chats in it, and an admin also manages its members, quota and
// docs.
export type MemberRole = "viewer" | "member" | "admin";
export const MEMBER_ROLES: readonly MemberRole[] = ["viewer", "member", "admin"];

export interface Member {
  email: string;
  role: MemberRole;
  addedAt: number;
  addedBy: string;
}

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
  members: number;
}

// One of the workspace's markdown documents (skills, knowledge), which the
// agent reads when it needs them.
export interface DocInfo {
  path: string;
  // The front matter's description, else the first heading or line.
  description: string;
  bytes: number;
  updatedAt: number;
}

// Usage summed over some cells and agent sessions: the whole workspace, or
// one owner's.
export interface UsageTotals {
  cells: number;
  // Cells that served a request in the month.
  activeCells: number;
  sessions: number;
  requests: number;
  // The gadgets' databases as last measured; unmeasured cells add nothing.
  storageBytes: number;
  inference: ModelUsage;
}

export interface CellUsageRow extends CellUsage {
  // A cell, or a session with the agent (blueprint "agent"), whose model
  // calls and runs it counts.
  kind: "cell" | "session";
  id: string;
  blueprint: string;
  version: string;
  owner: Owner;
  // Why the cell's usage could not be read, if it could not; it then counts
  // as nothing.
  error?: string;
}

export interface WorkspaceUsage {
  workspace: string;
  month: string;
  totals: UsageTotals;
  owners: (UsageTotals & Owner)[];
  cells: CellUsageRow[];
}

// How many cells the usage report asks at once.
const USAGE_CONCURRENCY = 8;
// Sessions with the agent one owner may keep in a workspace.
export const MAX_SESSIONS_PER_OWNER = 50;
const MAX_DOCS = 500;
export const MAX_DOC_BYTES = 256 * 1024;

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
    // Added in Phase 10: sessions with the agent, and the workspace's docs.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_user TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // Added in Phase 12: members, by email, as shares are.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS members (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      added_by TEXT NOT NULL
    )`);
    // A workspace from before membership keeps working for the people who
    // use it: everyone who owns a cell or a chat in it becomes a member.
    if (!ctx.storage.kv.get("members-migrated")) {
      const now = Date.now();
      for (const table of ["cells", "sessions"]) {
        ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO members SELECT DISTINCT owner_email, 'member', ?, 'migration' FROM ${table} WHERE owner_email != ''`,
          now,
        );
      }
      ctx.storage.kv.put("members-migrated", true);
      if (this.info()) ctx.blockConcurrencyWhile(() => this.syncMembers());
    }
  }

  // Creates the workspace, or changes its quota. A quota left out keeps the
  // current one, or is `fallback` for a new workspace.
  configure(name: string, quota: number | undefined, fallback: number): WorkspaceInfo {
    this.ctx.storage.kv.put("name", name);
    const current = this.ctx.storage.kv.get<number>("quota");
    this.ctx.storage.kv.put("quota", quota ?? current ?? fallback);
    return this.info()!;
  }

  info(): WorkspaceInfo | null {
    const name = this.ctx.storage.kv.get<string>("name");
    if (name === undefined) return null;
    const members = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM members").one().n;
    return { name, quota: this.ctx.storage.kv.get<number>("quota") ?? 0, cells: this.count(), members };
  }

  members(): Member[] {
    return this.ctx.storage.sql
      .exec<{ email: string; role: MemberRole; added_at: number; added_by: string }>(
        "SELECT * FROM members ORDER BY email",
      )
      .toArray()
      .map((r) => ({ email: r.email, role: r.role, addedAt: r.added_at, addedBy: r.added_by }));
  }

  // The role of the user with this email, or null if they are not a member.
  role(email: string): MemberRole | null {
    if (!email) return null;
    return (
      this.ctx.storage.sql.exec<{ role: MemberRole }>("SELECT role FROM members WHERE email = ?", email).toArray()[0]
        ?.role ?? null
    );
  }

  // Adds members or changes their roles.
  async setMembers(members: Record<string, MemberRole>, by: string): Promise<WorkspaceResult<Member[]>> {
    if (!this.info()) return fail(404, "workspace does not exist");
    const now = Date.now();
    for (const [email, role] of Object.entries(members)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO members VALUES (?, ?, ?, ?)
         ON CONFLICT (email) DO UPDATE SET role = excluded.role`,
        email,
        role,
        now,
        by,
      );
    }
    await this.syncMembers();
    return { ok: true, value: this.members() };
  }

  // Removes a member. Their cells and chats stay theirs; they can no longer
  // create others here.
  async removeMember(email: string): Promise<WorkspaceResult<null>> {
    if (this.role(email) === null) return fail(404, `${email} is not a member`);
    this.ctx.storage.sql.exec("DELETE FROM members WHERE email = ?", email);
    await this.syncMembers();
    return { ok: true, value: null };
  }

  // The catalog keeps who belongs to which workspace, so a user can list
  // theirs without asking every workspace.
  private async syncMembers(): Promise<void> {
    const name = this.info()?.name;
    if (!name) return;
    const members = Object.fromEntries(this.members().map((m) => [m.email, m.role]));
    try {
      await this.env.CATALOG.getByName("catalog").setMemberships(name, members);
    } catch (err) {
      console.log(`workspace ${name}: listing its members in the catalog failed: ${err instanceof Error ? err.message : err}`);
    }
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

  // Registers a session with the agent and creates it.
  async createSession(owner: Owner, title: string, grants: string[]): Promise<WorkspaceResult<SessionInfo>> {
    const info = this.info();
    if (!info) return fail(404, "workspace does not exist");
    const n = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE owner_user = ?", owner.user)
      .one().n;
    if (n >= MAX_SESSIONS_PER_OWNER) return fail(409, `you have ${MAX_SESSIONS_PER_OWNER} sessions here; delete one first`);
    const session: SessionInfo = { id: newId("s"), workspace: info.name, title, owner, createdAt: Date.now() };
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
      session.id,
      title,
      owner.user,
      owner.email,
      session.createdAt,
    );
    try {
      await this.env.SESSION.getByName(session.id).create(session, grants);
    } catch (err) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", session.id);
      throw err;
    }
    return { ok: true, value: session };
  }

  listSessions(): SessionInfo[] {
    const name = this.info()?.name ?? "";
    return this.ctx.storage.sql
      .exec<{ id: string; title: string; owner_user: string; owner_email: string; created_at: number }>(
        "SELECT * FROM sessions ORDER BY created_at DESC, id",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        workspace: name,
        title: r.title,
        owner: { user: r.owner_user, email: r.owner_email },
        createdAt: r.created_at,
      }));
  }

  getSession(id: string): SessionInfo | null {
    return this.listSessions().find((s) => s.id === id) ?? null;
  }

  async renameSession(id: string, title: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE sessions SET title = ? WHERE id = ?", title, id);
    await this.env.SESSION.getByName(id).rename(title);
  }

  // Deletes a session and its transcript.
  async deleteSession(id: string): Promise<WorkspaceResult<null>> {
    if (!this.getSession(id)) return fail(404, "session does not exist in this workspace");
    await this.env.SESSION.getByName(id).destroy();
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", id);
    return { ok: true, value: null };
  }

  listDocs(): DocInfo[] {
    return this.ctx.storage.sql
      .exec<{ path: string; content: string; updated_at: number }>("SELECT * FROM docs ORDER BY path")
      .toArray()
      .map((r) => ({
        path: r.path,
        description: describeDoc(r.content),
        bytes: new TextEncoder().encode(r.content).byteLength,
        updatedAt: r.updated_at,
      }));
  }

  getDoc(path: string): string | null {
    return (
      this.ctx.storage.sql.exec<{ content: string }>("SELECT content FROM docs WHERE path = ?", path).toArray()[0]
        ?.content ?? null
    );
  }

  // Creates or replaces a document. The caller has checked the path and size.
  putDoc(path: string, content: string): WorkspaceResult<DocInfo> {
    if (!this.info()) return fail(404, "workspace does not exist");
    const exists = this.getDoc(path) !== null;
    const n = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM docs").one().n;
    if (!exists && n >= MAX_DOCS) return fail(409, `the workspace has ${MAX_DOCS} documents`);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO docs VALUES (?, ?, ?)", path, content, Date.now());
    return { ok: true, value: this.listDocs().find((d) => d.path === path)! };
  }

  deleteDoc(path: string): WorkspaceResult<null> {
    if (this.getDoc(path) === null) return fail(404, "document does not exist");
    this.ctx.storage.sql.exec("DELETE FROM docs WHERE path = ?", path);
    return { ok: true, value: null };
  }

  // What the cells and agent sessions did in a month, per cell or session,
  // per owner and in total. `only` limits the report to one owner's.
  async usage(month: string, only?: string): Promise<WorkspaceUsage | null> {
    const info = this.info();
    if (!info) return null;
    const mine = (o: Owner) => only === undefined || o.user === only;
    const cells = [
      ...this.listCells()
        .filter((c) => mine(c.owner))
        .map((c) => ({ kind: "cell" as const, id: c.id, blueprint: c.blueprint, version: c.version, owner: c.owner })),
      ...this.listSessions()
        .filter((s) => mine(s.owner))
        .map((s) => ({ kind: "session" as const, id: s.id, blueprint: "agent", version: s.id, owner: s.owner })),
    ];
    const rows: CellUsageRow[] = new Array(cells.length);
    let next = 0;
    const worker = async () => {
      while (next < cells.length) {
        const i = next++;
        const row = cells[i];
        try {
          const usage =
            row.kind === "cell"
              ? await this.env.CELL.getByName(row.id).usage(month)
              : await this.env.SESSION.getByName(row.id).usage(month);
          rows[i] = { ...usage, ...row };
        } catch (err) {
          // One cell that cannot answer, e.g. still running an older kernel
          // just after a deploy, does not fail the report.
          const error = err instanceof Error ? err.message : String(err);
          rows[i] = { month, requests: 0, lastActive: null, inference: {}, storageBytes: null, ...row, error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(USAGE_CONCURRENCY, cells.length) }, worker));

    const totals = emptyTotals();
    const owners = new Map<string, UsageTotals & Owner>();
    for (const row of rows) {
      let owner = owners.get(row.owner.user);
      if (!owner) owners.set(row.owner.user, (owner = { ...row.owner, ...emptyTotals() }));
      for (const t of [totals, owner]) addUsage(t, row);
    }
    return { workspace: info.name, month, totals, owners: [...owners.values()], cells: rows };
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

function emptyTotals(): UsageTotals {
  return {
    cells: 0,
    activeCells: 0,
    sessions: 0,
    requests: 0,
    storageBytes: 0,
    inference: { calls: 0, input: 0, output: 0, total: 0 },
  };
}

function addUsage(t: UsageTotals, row: CellUsageRow): void {
  if (row.kind === "session") {
    t.sessions++;
  } else {
    t.cells++;
    if (row.requests > 0) t.activeCells++;
  }
  t.requests += row.requests;
  t.storageBytes += row.storageBytes ?? 0;
  for (const m of Object.values(row.inference)) {
    t.inference.calls += m.calls;
    t.inference.input += m.input;
    t.inference.output += m.output;
    t.inference.total += m.total;
  }
}

// A document's description: its front matter's `description:`, else its
// first heading or line.
function describeDoc(content: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const described = front && /^description:\s*(.+)$/m.exec(front[1]);
  if (described) return described[1].trim().replace(/^["']|["']$/g, "").slice(0, 200);
  const body = front ? content.slice(front[0].length) : content;
  const line = body.split("\n").map((l) => l.trim()).find((l) => l);
  return (line ?? "").replace(/^#+\s*/, "").slice(0, 200);
}
