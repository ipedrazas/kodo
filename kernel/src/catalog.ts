import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export interface BlueprintVersion {
  name: string;
  version: string;
  bundle: string;
  capabilities: string[];
  tier: string;
  publishedAt: number;
}

export type PublishResult = { ok: true; blueprint: BlueprintVersion } | { ok: false; conflict: BlueprintVersion };

// The catalog of published Blueprint versions, one instance for the fleet.
// A version is immutable once published.
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
  }

  publish(blueprint: Omit<BlueprintVersion, "publishedAt">): PublishResult {
    const existing = this.get(blueprint.name, blueprint.version);
    if (existing) return { ok: false, conflict: existing };
    const publishedAt = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)",
      blueprint.name,
      blueprint.version,
      blueprint.bundle,
      JSON.stringify(blueprint.capabilities),
      blueprint.tier,
      publishedAt,
    );
    return { ok: true, blueprint: { ...blueprint, publishedAt } };
  }

  get(name: string, version: string): BlueprintVersion | null {
    const rows = this.select("WHERE name = ? AND version = ?", name, version);
    return rows[0] ?? null;
  }

  // The most recently published version of a Blueprint.
  latest(name: string): BlueprintVersion | null {
    const rows = this.select("WHERE name = ? ORDER BY published_at DESC, rowid DESC LIMIT 1", name);
    return rows[0] ?? null;
  }

  versions(name: string): BlueprintVersion[] {
    return this.select("WHERE name = ? ORDER BY published_at, rowid", name);
  }

  names(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>("SELECT DISTINCT name FROM versions ORDER BY name")
      .toArray()
      .map((r) => r.name);
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
      }>(`SELECT * FROM versions ${where}`, ...params)
      .toArray()
      .map((r) => ({
        name: r.name,
        version: r.version,
        bundle: r.bundle,
        capabilities: JSON.parse(r.capabilities),
        tier: r.tier,
        publishedAt: r.published_at,
      }));
  }
}
