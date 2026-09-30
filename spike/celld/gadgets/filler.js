import { DurableObject } from "cloudflare:workers";

// Sample gadget for activation timing: grows its SQLite database on request so
// cold activation can be measured against database size.
//   ?fill=MB   append MB mebibytes of random rows
//   (none)     report the row count and approximate size
export class App extends DurableObject {
  async fetch(request) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS blob (id INTEGER PRIMARY KEY, data BLOB)");
    const fill = Number(new URL(request.url).searchParams.get("fill") ?? 0);
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i < fill * 16; i++) {
      crypto.getRandomValues(chunk);
      sql.exec("INSERT INTO blob (data) VALUES (?)", chunk);
    }
    const rows = sql.exec("SELECT count(*) AS n FROM blob").one().n;
    return Response.json({ gadget: "filler", rows, mib: rows / 16 });
  }
}
