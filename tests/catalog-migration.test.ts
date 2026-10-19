import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateCatalog, sourceIdentity } from "../src/catalog.ts";

function database(version: number, records: Array<{ name: string; url: string | null; data: string }> = [], uniqueIdentity = true) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES (${version}); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT ${uniqueIdentity ? "UNIQUE" : ""},data TEXT NOT NULL); CREATE TABLE journal(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  for (const row of records) db.query("INSERT INTO catalog VALUES (?,?,?)").run(row.name, row.url, row.data);
  return db;
}

const legacyGit = { name: "alpha", gitUrl: "https://github.com/example/alpha", description: "alpha", createdAt: "2025-01-01", path: "/managed/alpha" };
const validJournal = { id: "j-1", agentId: "agent-1", revision: 2, actions: [{ generation: "g-1", from: "/a", to: "/b", old: true }] };

test.each([1, 2])("schema v%d upgrades legacy Git rows and legacy journals", version => {
  const db = database(version, [{ name: "alpha", url: legacyGit.gitUrl, data: JSON.stringify(legacyGit) }]);
  db.query("INSERT INTO journal VALUES (?,?)").run(validJournal.id, JSON.stringify(validJournal));
  try {
    expect(migrateCatalog(db)).toBe(3);
    const data = JSON.parse((db.query("SELECT data FROM catalog").get() as any).data);
    expect(data.source).toEqual({ kind: "git", gitUrl: legacyGit.gitUrl });
    expect(data.gitUrl).toBe(legacyGit.gitUrl);
    expect(migrateCatalog(db)).toBe(3);
    expect((db.query("SELECT version FROM meta").get() as any).version).toBe(3);
  } finally { db.close(); }
});

test("v3 local provenance omits top-level gitUrl and preserves central checkout identity", () => {
  const local = { name: "local", source: { kind: "local" as const, path: "/original/source" }, description: "local", createdAt: "2025-01-01", path: "/managed/local" };
  const db = database(3, [{ name: "local", url: sourceIdentity(local.source), data: JSON.stringify(local) }]);
  try {
    migrateCatalog(db);
    const data = JSON.parse((db.query("SELECT data FROM catalog").get() as any).data);
    expect(data).toEqual(local);
    expect(data.path).toBe("/managed/local");
    expect(data.gitUrl).toBeUndefined();
  } finally { db.close(); }
});

test.each([
  { name: "git identity mismatch", source: { kind: "git", gitUrl: "https://github.com/example/other" }, slot: "https://github.com/example/alpha" },
  { name: "local identity mismatch", source: { kind: "local", path: "/other" }, slot: "local:[\"/source\"]" },
])("migration rejects $name", ({ source, slot }) => {
  const data = { name: "alpha", source, ...(source.kind === "git" ? { gitUrl: source.gitUrl } : {}), description: "a", createdAt: "today", path: "/managed" };
  const db = database(2, [{ name: "alpha", url: slot, data: JSON.stringify(data) }]);
  try { expect(() => migrateCatalog(db)).toThrow(/identity mismatch/); } finally { db.close(); }
});

test("duplicate source identities, including Git/local cross-category collisions, fail closed", () => {
  const path = "/tmp/a";
  const identity = sourceIdentity({ kind: "local", path });
  const git = { name: "git", gitUrl: identity, description: "g", createdAt: "today", path: "/managed/g" };
  const local = { name: "local", source: { kind: "local", path }, description: "l", createdAt: "today", path: "/managed/l" };
  const db = database(2, [
    { name: "git", url: identity, data: JSON.stringify(git) },
    { name: "local", url: identity, data: JSON.stringify(local) },
  ], false);
  try { expect(() => migrateCatalog(db)).toThrow(/duplicate source identity/); } finally { db.close(); }
});

test("malformed or mismatched journals fail before recovery can address another row", () => {
  for (const data of [
    JSON.stringify({ ...validJournal, id: "other-journal" }),
    JSON.stringify({ ...validJournal, actions: [{ generation: "g-1", from: "/a", to: 4, old: true }] }),
    JSON.stringify({ ...validJournal, actions: [{ generation: "g-1", from: "/a", to: "/b" }] }),
  ]) {
    const db = database(2);
    db.query("INSERT INTO journal VALUES (?,?)").run(validJournal.id, data);
    try {
      expect(() => migrateCatalog(db)).toThrow(/journal/);
      expect((db.query("SELECT id FROM journal").get() as any).id).toBe(validJournal.id);
      expect((db.query("SELECT version FROM meta").get() as any).version).toBe(2);
    } finally { db.close(); }
  }
});

test("failed migration rolls back earlier catalog rewrites and schema version", () => {
  const first = { name: "a", gitUrl: "https://github.com/example/a", description: "a", createdAt: "today", path: "/managed/a" };
  const db = database(2, [
    { name: "a", url: first.gitUrl, data: JSON.stringify(first) },
    { name: "b", url: "https://github.com/example/b", data: "{" },
  ]);
  try {
    const before = db.query("SELECT name,url,data FROM catalog ORDER BY name").all();
    expect(() => migrateCatalog(db)).toThrow(/malformed catalog JSON/);
    expect(db.query("SELECT name,url,data FROM catalog ORDER BY name").all()).toEqual(before);
    expect((db.query("SELECT version FROM meta").get() as any).version).toBe(2);
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(0);
  } finally { db.close(); }
});

test("v3 local-import journals preserve unknown-name intent and later durable phases", () => {
  const db = database(3);
  const id = "local-import-1", path = "/managed/local-import-staging/1";
  const journal = {
    id, agentId: "catalog", revision: 0, actions: [], path,
    source: { source: { kind: "local", path: "/source" } },
    localImport: { phase: "intent", sourcePath: "/source", stagingPath: path },
  };
  db.query("INSERT INTO journal VALUES (?,?)").run(id, JSON.stringify(journal));
  try {
    expect(migrateCatalog(db)).toBe(3);
    expect(JSON.parse((db.query("SELECT data FROM journal").get() as any).data)).toEqual(journal);
    db.query("UPDATE journal SET data=? WHERE id=?").run(JSON.stringify({ ...journal, localImport: { ...journal.localImport, phase: "initialized", name: "fixture-skill" } }), id);
    expect(migrateCatalog(db)).toBe(3);
  } finally { db.close(); }
});

test("newer schema fails closed", () => {
  const db = database(4);
  try { expect(() => migrateCatalog(db)).toThrow(/unsupported schema/); } finally { db.close(); }
});
