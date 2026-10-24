import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, rename, lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { createSkillsPlugin } from "../src/index.ts";
import { sourceIdentity } from "../src/catalog.ts";

test.each(["before-swap", "after-old-rename", "after-both-renames", "after-db-commit", "active-lock"] as const)("canonical publication restart recovery is idempotent at %s", async boundary => {
  const root = await mkdtemp(join(tmpdir(), `skills-publication-${boundary}-`)), dataDir = join(root, "data"), home = join(root, "home");
  const canonicalRoot = join(dataDir, "skills"), canonical = join(canonicalRoot, "demo"), stageId = randomUUID();
  const stage = join(canonicalRoot, `.skills-update-${stageId}`), backup = join(canonicalRoot, `.skills-backup-demo-${stageId}`);
  await mkdir(canonicalRoot, { recursive: true }); await mkdir(home);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const source = join(root, "source"); await mkdir(source);
  git(source, "init", "-q"); git(source, "config", "user.email", "test@example.invalid"); git(source, "config", "user.name", "test");
  await writeFile(join(source, "SKILL.md"), "---\nname: demo\ndescription: old\n---\nold\n"); git(source, "add", "."); git(source, "commit", "-qm", "old");
  git(root, "clone", "--no-hardlinks", source, canonical); const oldHead = git(canonical, "rev-parse", "HEAD");
  git(root, "clone", "--no-hardlinks", canonical, stage);
  git(stage, "config", "user.name", "test"); git(stage, "config", "user.email", "test@example.invalid");
  await writeFile(join(stage, "SKILL.md"), "---\nname: demo\ndescription: new\n---\nnew\n"); git(stage, "add", "."); git(stage, "commit", "-qm", "new");
  const newHead = git(stage, "rev-parse", "HEAD");
  if (boundary !== "before-swap" && boundary !== "active-lock") await rename(canonical, backup);
  if (boundary === "after-both-renames" || boundary === "after-db-commit") await rename(stage, canonical);
  const data = new Database(join(dataDir, "skills.sqlite"));
  data.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES(5); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL); CREATE TABLE installations(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE journal(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE repository_state(name TEXT NOT NULL,url TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(name,url)); CREATE TABLE reconciliation(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);");
  const sourceValue = { kind: "local" as const, path: source }, url = sourceIdentity(sourceValue), operationId = randomUUID();
  const oldCatalog = { name: "demo", source: sourceValue, description: "old", createdAt: "2025-01-01T00:00:00.000Z", path: canonical, history: { mode: "directory-initialized" as const, selectedCommit: oldHead }, catalogStatus: "active" as const };
  const newCatalog = { ...oldCatalog, description: "new", history: { mode: "directory-initialized" as const, selectedCommit: newHead } };
  data.query("INSERT INTO catalog VALUES (?,?,?)").run("demo", url, JSON.stringify(boundary === "after-db-commit" ? newCatalog : oldCatalog));
  if (boundary !== "after-db-commit") data.query("INSERT INTO journal VALUES (?,?)").run(operationId, JSON.stringify({ id: operationId, agentId: "catalog-publication", revision: 0, actions: [], canonicalPublication: { phase: "prepared", operationId, name: "demo", canonicalPath: canonical, stage, backup, oldHead, head: newHead, oldCatalog, newCatalog } }));
  data.close();
  const lock = join(canonicalRoot, ".skills-lock-demo"), ownerPid = boundary === "active-lock" ? process.pid : 99999999;
  await (await import("node:fs/promises")).symlink(`skills-lock-v1:${ownerPid}:${operationId}`, lock);
  let registered = false, shutdown: (() => Promise<void>) | undefined;
  const host: any = new Proxy({ dataDir, async request(method: string) { if (method === "organization.snapshot") return { capabilities: {} }; throw new Error(method); },
    registerServerSettings() { registered = true; }, serverSettings() { if (!registered) throw new Error("settings read before registration"); return { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 }; },
    onShutdown(fn: () => Promise<void>) { shutdown = fn; }, emit() {},
  }, { get(target, key: string) { return key in target ? (target as any)[key] : () => {}; } });
  try {
    await createSkillsPlugin({ home }).setup(host);
    const expectedHead = boundary === "active-lock" ? oldHead : newHead;
    expect(git(canonical, "rev-parse", "HEAD")).toBe(expectedHead);
    const reopened = new Database(join(dataDir, "skills.sqlite"), { readonly: true });
    expect(JSON.parse((reopened.query("SELECT data FROM catalog WHERE name='demo'").get() as any).data).history.selectedCommit).toBe(expectedHead);
    expect(reopened.query("SELECT id FROM journal WHERE id=?").get(operationId) === null).toBe(boundary !== "active-lock"); reopened.close();
    if (boundary === "active-lock") {
      expect((await lstat(lock)).isSymbolicLink()).toBe(true);
      expect((await stat(stage)).isDirectory()).toBe(true);
    } else await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await shutdown?.();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("server settings are registered before migration reads and plugin can restart against its dataDir DB", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-setup-order-")), dataDir = join(root, "data"), home = join(root, "home");
  await mkdir(dataDir); await mkdir(home);
  const scope = createHash("sha256").update(await realpath(dataDir)).digest("hex");
  const legacyRoot = join(home, ".agentorg", "skills", scope), source = join(legacyRoot, "old-checkout");
  await mkdir(source, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "test");
  await writeFile(join(source, "SKILL.md"), "---\nname: demo\ndescription: setup order regression\n---\nInstructions\n");
  git("add", "."); git("commit", "-qm", "fixture");
  const legacy = new Database(join(legacyRoot, "skills.sqlite"));
  legacy.exec("CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES (1); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL); CREATE TABLE installations(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE journal(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE repository_state(name TEXT NOT NULL,url TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(name,url)); CREATE TABLE reconciliation(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);");
  const url = "https://example.invalid/demo";
  legacy.query("INSERT INTO catalog VALUES (?,?,?)").run("demo", url, JSON.stringify({ name: "demo", gitUrl: url, path: source, description: "setup order regression", createdAt: "2025-01-01T00:00:00.000Z" }));
  legacy.close();
  let registered = false;
  const hooks: Array<() => Promise<void>> = [];
  const makeHost = (): any => new Proxy({ dataDir,
    async request(method: string) { if (method === "organization.snapshot") return { capabilities: {} }; throw new Error(`unexpected request ${method}`); },
    serverSettings() { if (!registered) throw new Error("serverSettings read before registration"); return { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 }; },
    registerServerSettings() { registered = true; },
    onShutdown(fn: () => Promise<void>) { hooks.push(fn); },
    emit() {},
  }, { get(target, key: string) { if (key in target) return (target as any)[key]; return () => {}; } });
  try {
    const plugin = createSkillsPlugin({ home });
    await plugin.setup(makeHost());
    expect(registered).toBe(true);
    expect(await Bun.file(join(dataDir, "skills.sqlite")).exists()).toBe(true);
    await hooks.shift()?.();
    registered = false;
    await plugin.setup(makeHost());
    expect(registered).toBe(true);
    expect(await Bun.file(join(dataDir, "skills.sqlite")).exists()).toBe(true);
    await hooks.shift()?.();
  } finally { await rm(root, { recursive: true, force: true }); }
});
