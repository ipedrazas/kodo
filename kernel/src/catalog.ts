import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { Owner } from "./workspace";

export interface BlueprintVersion {
  name: string;
  version: string;
  bundle: string;
  capabilities: string[];
  tier: string;
  // When it was published; 0 while it is a draft.
  publishedAt: number;
  // A draft can be used only by its author; a published version by anyone.
  // Versions published with the admin token are published from the start.
  status?: "draft" | "published";
  // Who authored it, for a version the agent wrote: the session's owner,
  // and the session.
  author?: Owner;
  session?: string;
  workspace?: string;
  // Who published it, if not the admin token.
  publishedBy?: Owner;
  createdAt?: number;
}

export type PublishResult = { ok: true; blueprint: BlueprintVersion } | { ok: false; conflict: BlueprintVersion };

export type CatalogResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;

// Who is asking, for what they may see: the admin token sees everything, a
// user the published versions and their own drafts.
export type Viewer = { admin: true } | { admin: false; user: string };

const visible = (b: BlueprintVersion, viewer: Viewer) =>
  viewer.admin || b.status !== "draft" || b.author?.user === viewer.user;

// The catalog of Blueprint versions, one instance for the fleet. A version
// is immutable once published. The agent's drafts are versions too, usable
// only by their author until the author publishes them; a name the agent
// first used belongs to that author, who alone adds versions to it.
export class Catalog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS versions (
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      bundle TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      tier TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      PRIMARY KEY (name, version)
    )`);
    // Added in Phase 11, for the versions the agent writes.
    const columns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(versions)").toArray().map((c) => c.name);
    if (!columns.includes("status")) {
      ctx.storage.sql.exec("ALTER TABLE versions ADD COLUMN status TEXT NOT NULL DEFAULT 'published'");
      ctx.storage.sql.exec("ALTER TABLE versions ADD COLUMN authorship TEXT");
      ctx.storage.sql.exec("ALTER TABLE versions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    }
    // The fleet's workspaces by name, for the settings page to offer. A
    // workspace is its own object; this only remembers that it exists.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS workspaces (name TEXT PRIMARY KEY)");
  }

  rememberWorkspace(name: string): void {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO workspaces VALUES (?)", name);
  }

  workspaces(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM workspaces ORDER BY name")
      .toArray()
      .map((r) => r.name);
  }

  // Every version a user's agent authored, drafts and published, newest
  // first.
  authoredBy(user: string): BlueprintVersion[] {
    return this.select("WHERE status = 'draft' OR authorship IS NOT NULL ORDER BY created_at DESC, rowid DESC").filter(
      (v) => v.author?.user === user,
    );
  }

  // Publishes a version with the admin token.
  publish(blueprint: Omit<BlueprintVersion, "publishedAt">): PublishResult {
    const existing = this.get(blueprint.name, blueprint.version);
    if (existing) return { ok: false, conflict: existing };
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO versions (name, version, bundle, capabilities, tier, published_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'published', ?)",
      blueprint.name,
      blueprint.version,
      blueprint.bundle,
      JSON.stringify(blueprint.capabilities),
      blueprint.tier,
      now,
      now,
    );
    return { ok: true, blueprint: this.get(blueprint.name, blueprint.version)! };
  }

  // Records a draft the agent wrote for its session's owner, as the next
  // version of the name: 1, 2, 3... A name that has versions by anyone else,
  // or published with the admin token, is not theirs to add to.
  draft(d: {
    name: string;
    bundle: string;
    capabilities: string[];
    author: Owner;
    session: string;
    workspace: string;
  }): CatalogResult<BlueprintVersion> {
    const existing = this.select("WHERE name = ?", d.name);
    if (existing.some((v) => v.author?.user !== d.author.user)) {
      return fail(409, `the name ${d.name} belongs to someone else; choose another`);
    }
    const next = existing.reduce((n, v) => Math.max(n, /^\d+$/.test(v.version) ? Number(v.version) : 0), 0) + 1;
    const version = String(next);
    this.ctx.storage.sql.exec(
      "INSERT INTO versions (name, version, bundle, capabilities, tier, published_at, status, authorship, created_at) VALUES (?, ?, ?, ?, 'shared', 0, 'draft', ?, ?)",
      d.name,
      version,
      d.bundle,
      JSON.stringify(d.capabilities),
      JSON.stringify({ author: d.author, session: d.session, workspace: d.workspace }),
      Date.now(),
    );
    return { ok: true, value: this.get(d.name, version)! };
  }

  // Removes a draft that could not be audited.
  discard(name: string, version: string): void {
    this.ctx.storage.sql.exec("DELETE FROM versions WHERE name = ? AND version = ? AND status = 'draft'", name, version);
  }

  // Publishes a draft. Only its author, or the admin token, may.
  publishDraft(name: string, version: string, publisher: Owner | null): CatalogResult<BlueprintVersion> {
    const b = this.get(name, version);
    if (!b || (publisher && !visible(b, { admin: false, user: publisher.user }))) {
      return fail(404, "blueprint version does not exist");
    }
    if (b.status !== "draft") return fail(409, `${name} ${version} is already published`);
    if (publisher && b.author?.user !== publisher.user) return fail(403, "only its author can publish a draft");
    const authorship = { author: b.author, session: b.session, workspace: b.workspace, publishedBy: publisher ?? undefined };
    this.ctx.storage.sql.exec(
      "UPDATE versions SET status = 'published', published_at = ?, authorship = ? WHERE name = ? AND version = ?",
      Date.now(),
      JSON.stringify(authorship),
      name,
      version,
    );
    return { ok: true, value: this.get(name, version)! };
  }

  get(name: string, version: string): BlueprintVersion | null {
    const rows = this.select("WHERE name = ? AND version = ?", name, version);
    return rows[0] ?? null;
  }

  // The version a new cell gets when none is named: the latest published,
  // or, for its author, the latest draft of a name with none published.
  latest(name: string, viewer: Viewer = { admin: true }): BlueprintVersion | null {
    const all = this.select("WHERE name = ? ORDER BY published_at DESC, created_at DESC, rowid DESC", name);
    const published = all.find((v) => v.status !== "draft");
    if (published) return published;
    return all.find((v) => visible(v, viewer)) ?? null;
  }

  versions(name: string, viewer: Viewer = { admin: true }): BlueprintVersion[] {
    return this.select("WHERE name = ? ORDER BY created_at, published_at, rowid", name).filter((v) => visible(v, viewer));
  }

  names(viewer: Viewer = { admin: true }): string[] {
    const names = new Set(this.select("ORDER BY name").filter((v) => visible(v, viewer)).map((v) => v.name));
    return [...names];
  }

  private select(where: string, ...params: unknown[]): BlueprintVersion[] {
    return this.ctx.storage.sql
      .exec<{
        name: string;
        version: string;
        bundle: string;
        capabilities: string;
        tier: string;
        published_at: number;
        status: string;
        authorship: string | null;
        created_at: number;
      }>(`SELECT * FROM versions ${where}`, ...params)
      .toArray()
      .map((r) => {
        const v: BlueprintVersion = {
          name: r.name,
          version: r.version,
          bundle: r.bundle,
          capabilities: JSON.parse(r.capabilities),
          tier: r.tier,
          publishedAt: r.published_at,
          status: r.status === "draft" ? "draft" : "published",
          createdAt: r.created_at || r.published_at,
        };
        if (r.authorship) {
          const a = JSON.parse(r.authorship);
          if (a.author) v.author = a.author;
          if (a.session) v.session = a.session;
          if (a.workspace) v.workspace = a.workspace;
          if (a.publishedBy) v.publishedBy = a.publishedBy;
        }
        return v;
      });
  }
}
