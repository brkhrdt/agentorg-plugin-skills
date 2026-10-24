import { Database } from "bun:sqlite";

/** Import the legacy plugin-home ledger into a freshly created dataDir ledger.
 * The source is opened read-only and never removed. Existing active destination
 * data is never merged implicitly. */
export function migrateMetadataDatabase(destination: Database, legacyPath: string): void {
  let legacy: Database;
  try { legacy = new Database(legacyPath, { readonly: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "SQLITE_CANTOPEN") return; throw error; }
  try {
    const tables = new Set((legacy.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    if (!tables.has("catalog") || !tables.has("meta")) throw new Error("Legacy skills metadata database is incomplete");
    const destinationTables = new Set((destination.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    const hasData = (table: string) => destinationTables.has(table) && Number((destination.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n) > 0;
    const columns: Record<string, string[]> = {
      meta: ["version"], catalog: ["name", "url", "data"], installations: ["id", "data"], journal: ["id", "data"],
      repository_state: ["name", "url", "data"], reconciliation: ["id", "data"],
    };
    const tableOrder = ["meta", "catalog", "installations", "journal", "repository_state", "reconciliation"];
    const oldRows = new Map<string, any[]>();
    for (const table of tableOrder) {
      if (!tables.has(table)) { oldRows.set(table, []); continue; }
      oldRows.set(table, legacy.query(`SELECT ${columns[table]!.join(",")} FROM ${table}`).all());
    }
    const businessTables = ["catalog", "installations", "journal", "repository_state", "reconciliation"];
    if (businessTables.some(hasData)) {
      const same = businessTables.every(table => {
        if (!destinationTables.has(table)) return !(oldRows.get(table)?.length);
        const cols = columns[table]!;
        const current = destination.query(`SELECT ${cols.join(",")} FROM ${table}`).all();
        return JSON.stringify(current) === JSON.stringify(oldRows.get(table) ?? []);
      });
      if (same) return;
      throw new Error("Refusing to merge legacy skills metadata into a nonempty dataDir database");
    }
    destination.transaction(() => {
      for (const table of tableOrder) {
        const cols = columns[table]!;
        if (table === "meta") destination.query("DELETE FROM meta").run();
        const placeholders = cols.map(() => "?").join(",");
        const statement = destination.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`);
        for (const row of oldRows.get(table) ?? []) statement.run(...cols.map(column => row[column]));
      }
    })();
  } finally { legacy.close(); }
}
