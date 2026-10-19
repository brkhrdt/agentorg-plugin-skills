import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateCatalog } from "../src/catalog.ts";

function database(version: number, records: Array<{ name: string; url: string | null; data: string }> = []) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES (${version}); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL); CREATE TABLE journal(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  for (const row of records) db.query("INSERT INTO catalog VALUES (?,?,?)").run(row.name, row.url, row.data);
  return db;
}

const legacyGit = { name: "alpha", gitUrl: "https://github.com/example/alpha", description: "alpha", createdAt: "2025-01-01", path: "/managed/alpha" };

test.each([1, 2])("schema v%d upgrades legacy Git rows atomically and idempotently", version => {
  const db = database(version, [{ name: "alpha", url: legacyGit.gitUrl, data: JSON.stringify(legacyGit) }]);
  try {
    expect(migrateCatalog(db)).toBe(3);
    const data = JSON.parse((db.query("SELECT data FROM catalog").get() as any).data);
    expect(data.source).toEqual({ kind: "git", gitUrl: legacyGit.gitUrl });
    expect(data.gitUrl).toBe(legacyGit.gitUrl);
    expect(migrateCatalog(db)).toBe(3);
    expect((db.query("SELECT version FROM meta").get() as any).version).toBe(3);
  } finally { db.close(); }
});

test("v3 local provenance omits top-level gitUrl and preserves the managed checkout path", () => {
  const local = { name: "local", source: { kind: "local", path: "/original/source" }, description: "local", createdAt: "2025-01-01", path: "/managed/local" };
  const db = database(3, [{ name: "local", url: "local:[\"/original/source\"]", data: JSON.stringify(local) }]);
  try {
    migrateCatalog(db);
    const data = JSON.parse((db.query("SELECT data FROM catalog").get() as any).data);
    expect(data).toEqual(local);
    expect(data.path).toBe("/managed/local");
    expect(data.gitUrl).toBeUndefined();
  } finally { db.close(); }
});

test("newer schema and malformed catalog fail closed without changing ledger", () => {
  const newer = database(4);
  try { expect(() => migrateCatalog(newer)).toThrow(/unsupported schema/); } finally { newer.close(); }
  const malformed = database(2, [{ name: "alpha", url: legacyGit.gitUrl, data: "{" }]);
  try {
    expect(() => migrateCatalog(malformed)).toThrow(/malformed catalog JSON/);
    expect((malformed.query("SELECT version FROM meta").get() as any).version).toBe(2);
  } finally { malformed.close(); }
});
