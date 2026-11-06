import { DatabaseSync } from "node:sqlite";

/** Small compatibility layer for synchronous SQLite statements used by the plugin. */
export class Database {
  private readonly database: DatabaseSync;
  constructor(path: string, _options?: { create?: boolean }) { this.database = new DatabaseSync(path); }
  exec(sql: string) { this.database.exec(sql); }
  query(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      all: (...parameters: any[]) => statement.all(...parameters) as Array<Record<string, any>>,
      get: (...parameters: any[]) => statement.get(...parameters) as Record<string, any> | undefined,
      run: (...parameters: any[]) => statement.run(...parameters),
    };
  }
  transaction<T>(work: () => T) { return () => { this.database.exec("BEGIN"); try { const result = work(); this.database.exec("COMMIT"); return result; } catch (error) { this.database.exec("ROLLBACK"); throw error; } }; }
  close() { this.database.close(); }
}
