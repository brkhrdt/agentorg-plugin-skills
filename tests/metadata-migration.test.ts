import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateMetadataDatabase } from "../src/metadata-store.ts";

test("metadata DB migrates transactionally from legacy home to dataDir and remains idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-db-migration-")), oldPath = join(root, "old.sqlite"), newPath = join(root, "data", "skills.sqlite");
  try {
    const old = new Database(oldPath);
    old.exec("CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES (5); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL); CREATE TABLE installations(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE journal(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE repository_state(name TEXT NOT NULL,url TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(name,url)); CREATE TABLE reconciliation(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);");
    old.query("INSERT INTO catalog VALUES (?,?,?)").run("demo", "https://example.invalid/demo", "{\"name\":\"demo\"}"); old.close();
    await mkdir(join(root, "data"));
    const db = new Database(newPath, { create: true });
    db.exec("CREATE TABLE meta(version INTEGER NOT NULL); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL); CREATE TABLE installations(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE journal(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE repository_state(name TEXT NOT NULL,url TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(name,url)); CREATE TABLE reconciliation(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); INSERT INTO meta VALUES (1);");
    migrateMetadataDatabase(db, oldPath);
    expect(db.query("SELECT version FROM meta").get()).toEqual({ version: 5 });
    expect(db.query("SELECT data FROM catalog WHERE name='demo'").get()).toEqual({ data: "{\"name\":\"demo\"}" });
    migrateMetadataDatabase(db, oldPath);
    expect(db.query("SELECT count(*) AS n FROM catalog").get()).toEqual({ n: 1 });
    db.query("UPDATE catalog SET data='edited-after-migration' WHERE name='demo'").run();
    db.close();
    const restarted = new Database(newPath);
    expect(() => migrateMetadataDatabase(restarted, oldPath)).not.toThrow();
    expect(restarted.query("SELECT data FROM catalog WHERE name='demo'").get()).toEqual({ data: "edited-after-migration" });
    restarted.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("metadata migration refuses to overwrite a nonempty destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-db-conflict-")), oldPath = join(root, "old.sqlite"), newPath = join(root, "new.sqlite");
  try {
    const old = new Database(oldPath); old.exec("CREATE TABLE meta(version INTEGER); INSERT INTO meta VALUES (1); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT,data TEXT); INSERT INTO catalog VALUES ('old','old','{}');"); old.close();
    const db = new Database(newPath); db.exec("CREATE TABLE meta(version INTEGER); INSERT INTO meta VALUES (1); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT,data TEXT); INSERT INTO catalog VALUES ('new','new','{}'); CREATE TABLE installations(id TEXT,data TEXT); CREATE TABLE journal(id TEXT,data TEXT); CREATE TABLE repository_state(name TEXT,url TEXT,data TEXT); CREATE TABLE reconciliation(id INTEGER,data TEXT);");
    expect(() => migrateMetadataDatabase(db, oldPath)).toThrow(/nonempty/i);
    expect(db.query("SELECT name FROM catalog").get()).toEqual({ name: "new" }); db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
