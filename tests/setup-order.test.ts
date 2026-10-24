import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { createSkillsPlugin } from "../src/index.ts";

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
