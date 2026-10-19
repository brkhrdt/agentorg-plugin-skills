import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSkillImporter, type LocalImportJournal } from "../src/local-import.ts";
import type { CatalogSkill } from "../src/catalog.ts";
import { gitWithTimeout } from "../src/git.ts";
import { createLocalSkillFixture } from "./helpers/local-skill.ts";

function makeImporter(db: Database, central: string, options: { failPublish?: boolean; failEmit?: boolean; beforeJournal?: (journal: LocalImportJournal) => void; afterSourceResolved?: (path: string) => void | Promise<void> } = {}) {
  const published: CatalogSkill[] = [], emitted: CatalogSkill[] = [], reported: Error[] = [];
  const importer = new LocalSkillImporter({
    centralRoot: central, stagingRoot: join(central, "local-import-staging"), maxCatalogEntries: 8, gitTimeoutMs: 10_000,
    putJournal(journal) {
      options.beforeJournal?.(journal);
      db.query("INSERT OR REPLACE INTO journal VALUES (?,?)").run(journal.id, JSON.stringify(journal));
    },
    async publish(record, identity, journalId) {
      if (options.failPublish) throw new Error("injected publication failure");
      db.transaction(() => {
        if (db.query("SELECT 1 FROM catalog WHERE name=? OR url=?").get(record.name, identity)) throw Object.assign(new Error("duplicate"), { code: "DUPLICATE" });
        if ((db.query("SELECT COUNT(*) AS n FROM catalog").get() as any).n >= 8) throw Object.assign(new Error("limit"), { code: "LIMIT" });
        db.query("INSERT INTO catalog VALUES (?,?,?)").run(record.name, identity, JSON.stringify(record));
        db.query("DELETE FROM journal WHERE id=?").run(journalId);
      })();
      published.push(record);
    },
    emit(record) {
      expect(db.query("SELECT 1 FROM catalog WHERE name=?").get(record.name)).toBeDefined();
      if (options.failEmit) throw new Error("injected event failure");
      emitted.push(record);
    },
    afterSourceResolved: options.afterSourceResolved,
    report(error) { reported.push(error); },
  });
  return { importer, published, emitted, reported };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "skills-local-import-"));
  const central = join(root, "central"); await mkdir(central);
  const db = new Database(":memory:");
  db.exec("CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL); CREATE TABLE journal(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  return { root, central, db, cleanup: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

test("durable local import journals before staging, publishes local provenance atomically, and emits afterward", async () => {
  const f = await setup(), fixture = await createLocalSkillFixture();
  try {
    await mkdir(join(fixture.path, ".git")); await writeFile(join(fixture.path, ".git", "private"), "must be excluded");
    let intentPrecededStageCreation = false;
    const h = makeImporter(f.db, f.central, { beforeJournal: journal => {
      if (journal.localImport.phase === "intent") {
        intentPrecededStageCreation = true;
        expect(existsSync(join(f.central, "local-import-staging"))).toBe(false);
      }
    } });
    const record = await h.importer.import(fixture.path);
    expect(intentPrecededStageCreation).toBe(true);
    expect(record).toMatchObject({ name: "fixture-skill", source: { kind: "local", path: fixture.path } });
    expect(record.gitUrl).toBeUndefined();
    expect(record.path.startsWith(join(f.central, "local-import-staging"))).toBe(true);
    expect(h.published).toHaveLength(1); expect(h.emitted).toHaveLength(1);
    expect(f.db.query("SELECT COUNT(*) AS n FROM journal").get()).toEqual({ n: 0 });
    expect((JSON.parse((f.db.query("SELECT data FROM catalog").get() as any).data)).source).toEqual({ kind: "local", path: fixture.path });
    await expect(access(join(record.path, ".git", "private"))).rejects.toThrow();
    expect(await readFile(join(record.path, "asset.bin"))).toEqual(await readFile(join(fixture.path, "asset.bin")));
    expect(await readFile(join(record.path, "ignored-payload.txt"), "utf8")).toContain("ignored fixture payload");
    expect(await readFile(join(record.path, ".agents", "keep.txt"), "utf8")).toContain("include managed-looking data");
    expect((await stat(join(record.path, "asset.bin"))).ino).not.toBe((await stat(join(fixture.path, "asset.bin"))).ino);
    expect(await gitWithTimeout(record.path, 10_000, "remote")).toBe("");
    expect(await gitWithTimeout(record.path, 10_000, "status", "--porcelain")).toBe("");
    expect((await gitWithTimeout(record.path, 10_000, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(/\s+/)).toHaveLength(1);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("canonical source claims prevent concurrent duplicate snapshots", async () => {
  const f = await setup(), fixture = await createLocalSkillFixture();
  try {
    const h = makeImporter(f.db, f.central);
    const [a, b] = await Promise.allSettled([h.importer.import(fixture.path), h.importer.import(fixture.path)]);
    expect([a, b].filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect([a, b].find(result => result.status === "rejected")?.status).toBe("rejected");
    expect(h.published).toHaveLength(1);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("source alias replacement after provenance resolution cannot publish a different tree", async () => {
  const f = await setup(), original = await createLocalSkillFixture(), replacement = await createLocalSkillFixture();
  try {
    await writeFile(join(replacement.path, "untracked.txt"), "different source tree");
    const renamed = `${original.path}-retained`;
    const h = makeImporter(f.db, f.central, { afterSourceResolved: async path => {
      expect(path).toBe(original.path);
      await (await import("node:fs/promises")).rename(original.path, renamed);
      await (await import("node:fs/promises")).symlink(replacement.path, original.path, "dir");
    } });
    await expect(h.importer.import(original.path)).rejects.toThrow(/source path changed/);
    expect(h.published).toHaveLength(0);
    expect((f.db.query("SELECT COUNT(*) AS n FROM catalog").get() as any).n).toBe(0);
    const journal = JSON.parse((f.db.query("SELECT data FROM journal").get() as any).data);
    expect(journal.localImport.sourcePath).toBe(original.path);
    expect(await readFile(join(journal.path, "untracked.txt"), "utf8")).toBe("different source tree");
  } finally { await original.cleanup(); await replacement.cleanup(); await f.cleanup(); }
});

test("post-publication event failures do not report the import as failed or undo catalog state", async () => {
  const f = await setup(), fixture = await createLocalSkillFixture();
  try {
    const h = makeImporter(f.db, f.central, { failEmit: true });
    const record = await h.importer.import(fixture.path);
    expect(record.name).toBe("fixture-skill");
    expect((f.db.query("SELECT COUNT(*) AS n FROM catalog").get() as any).n).toBe(1);
    expect((f.db.query("SELECT COUNT(*) AS n FROM journal").get() as any).n).toBe(0);
    expect(h.reported[0]?.message).toContain("was published");
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("duplicate catalog names retain their error code through the durable importer", async () => {
  const f = await setup(), fixture = await createLocalSkillFixture();
  try {
    f.db.query("INSERT INTO catalog VALUES (?,?,?)").run("fixture-skill", "https://github.com/example/existing", "{}");
    const h = makeImporter(f.db, f.central);
    await expect(h.importer.import(fixture.path)).rejects.toMatchObject({ code: "DUPLICATE" });
    expect((f.db.query("SELECT COUNT(*) AS n FROM catalog").get() as any).n).toBe(1);
    expect((f.db.query("SELECT COUNT(*) AS n FROM journal").get() as any).n).toBe(1);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("catalog limits retain error code through the durable importer", async () => {
  const f = await setup(), fixture = await createLocalSkillFixture();
  try {
    for (let i = 0; i < 8; i++) f.db.query("INSERT INTO catalog VALUES (?,?,?)").run(`seed-${i}`, `https://example/${i}`, "{}");
    const h = makeImporter(f.db, f.central);
    await expect(h.importer.import(fixture.path)).rejects.toMatchObject({ code: "LIMIT" });
    expect((f.db.query("SELECT COUNT(*) AS n FROM catalog").get() as any).n).toBe(8);
    expect((f.db.query("SELECT COUNT(*) AS n FROM journal").get() as any).n).toBe(1);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("restart leaves interrupted import journal/stage untouched; failures never publish or delete artifacts", async () => {
  const f = await setup(), fixture = await createLocalSkillFixture();
  try {
    const h = makeImporter(f.db, f.central, { failPublish: true });
    await expect(h.importer.import(fixture.path)).rejects.toThrow(/retained at/);
    expect(h.published).toHaveLength(0); expect(h.emitted).toHaveLength(0); expect(h.reported).toHaveLength(1);
    const row = f.db.query("SELECT data FROM journal").get() as any;
    const journal = JSON.parse(row.data);
    expect(journal.localImport).toMatchObject({ phase: "initialized", name: "fixture-skill" });
    expect(await readFile(join(journal.path, "SKILL.md"), "utf8")).toContain("Fixture instructions");
    const persistedPath = journal.path;
    // Construction does not replay, register, recopy, or remove interrupted imports.
    makeImporter(f.db, f.central);
    expect((f.db.query("SELECT COUNT(*) AS n FROM catalog").get() as any).n).toBe(0);
    expect(JSON.parse((f.db.query("SELECT data FROM journal").get() as any).data).path).toBe(persistedPath);
    await access(persistedPath);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});
