import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPlugin } from "agent-organization/plugin";
import { createSkillsPlugin } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  process.env.PATH = process.env.TEST_ORIGINAL_PATH ?? process.env.PATH;
  delete process.env.TEST_GIT_SOURCE;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(config: Record<string, unknown>, allowLocalSources = false) {
  const root = await mkdtemp(join(tmpdir(), "skills-bootstrap-contract-"));
  roots.push(root);
  const dataDir = join(root, "data"), home = join(root, "home"), source = join(root, "source");
  await Promise.all([mkdir(dataDir), mkdir(home), mkdir(source)]);
  await writeFile(join(source, "SKILL.md"), "---\nname: alpha\ndescription: Alpha fixture\n---\n# Instructions\n");

  const bin = join(root, "bin");
  await mkdir(bin);
  const gitShim = join(bin, "git");
  await writeFile(gitShim, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const clone = args.indexOf('clone');
if (clone < 0) process.exit(2);
const destination = args.at(-1);
const input = args.at(-2);
const source = input.startsWith('https://') ? process.env.TEST_GIT_SOURCE : input;
const copy = () => { fs.mkdirSync(destination, { recursive: true }); fs.cpSync(source, destination, { recursive: true }); fs.mkdirSync(path.join(destination, '.git'), { recursive: true }); };
const delay = fs.existsSync(path.join(__dirname, 'delay')) ? Number(fs.readFileSync(path.join(__dirname, 'delay'), 'utf8')) : 0;
setTimeout(() => { try { copy(); process.exit(0); } catch (e) { console.error(e); process.exit(1); } }, delay);
`);
  await chmod(gitShim, 0o700);
  process.env.TEST_ORIGINAL_PATH ??= process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.TEST_GIT_SOURCE = source;

  const endpoints = new Map<string, (params: unknown, caller: { kind: string; id: string }) => unknown>();
  const events: Array<{ type: string; payload: unknown }> = [];
  let initialize: ((agents: any[]) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const host = {
    dataDir,
    registerSettings() {},
    registerServerSettings() {},
    serverSettings: () => structuredClone(config),
    registerCapability() {}, beforeMutation() {},
    onInitialize(callback: (agents: any[]) => Promise<void>) { initialize = callback; },
    prepareLaunch() {}, validateLaunch() {}, registerHarness() {},
    registerEndpoint(name: string, callback: (params: unknown, caller: { kind: string; id: string }) => unknown) { endpoints.set(name, callback); },
    registerTool() {}, transformTool() {}, beforeSettings() {}, onEvent() {},
    onShutdown(callback: () => Promise<void>) { shutdown = callback; },
    request: async () => ({}), emit(type: string, payload: unknown) { events.push({ type, payload }); },
  };
  const start = async () => {
    await (createSkillsPlugin({ home, allowLocalSources }) as ServerPlugin).setup(host as any);
    return { initialize: initialize!, shutdown: shutdown!, endpoints, events };
  };
  return { root, source, config, start };
}

const caller = { kind: "client", id: "test" };

test.serial("configured repository seeds import once; identical restarts preserve path and metadata", async () => {
  const f = await fixture({
    repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }],
    gitTimeoutMs: 60_000, maxCatalogEntries: 4,
  });
  const first = await f.start();
  await first.initialize([]);
  const initial = await first.endpoints.get("skills.list")!({}, caller) as any;
  expect(initial.skills.map((skill: any) => skill.name)).toEqual(["alpha"]);
  const original = initial.skills[0];
  await first.shutdown();

  // An identical seed is idempotent across restart, preserving the catalog record.
  const second = await f.start();
  await second.initialize([]);
  const restarted = await second.endpoints.get("skills.list")!({}, caller) as any;
  expect(restarted.skills).toHaveLength(1);
  expect(restarted.skills[0]).toMatchObject({
    name: original.name, gitUrl: original.gitUrl, description: original.description,
    path: original.path, createdAt: original.createdAt,
  });
  await second.shutdown();

  // Seed removal is non-destructive: an existing catalog entry is not evicted.
  f.config.repositories = [];
  const third = await f.start();
  await third.initialize([]);
  const afterRemoval = await third.endpoints.get("skills.list")!({}, caller) as any;
  expect(afterRemoval.skills).toHaveLength(1);
  expect(afterRemoval.skills[0]).toMatchObject({ path: original.path, createdAt: original.createdAt });
  await third.shutdown();
});

test.serial("configured name/source conflicts preserve the existing catalog entry", async () => {
  const f = await fixture({ repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  const initial = await f.start();
  await initial.initialize([]);
  const original = (await initial.endpoints.get("skills.list")!({}, caller) as any).skills[0];
  await initial.shutdown();

  (f.config as { repositories: Array<{ name: string; gitUrl: string }> }).repositories[0]!.gitUrl = "https://github.com/example/other";
  const conflict = await f.start();
  await conflict.initialize([]);
  const items = (await conflict.endpoints.get("skills.list")!({}, caller) as any).skills;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ path: original.path, gitUrl: original.gitUrl, createdAt: original.createdAt });
  expect(conflict.events.some(event => event.type === "skills.error" && JSON.stringify(event.payload).includes("alpha"))).toBe(true);
  await conflict.shutdown();
});

test.serial("invalid configured checkout remains unregistered with an actionable seed report", async () => {
  const f = await fixture({ repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  await writeFile(join(f.source, "SKILL.md"), "---\nname: wrong\ndescription: Invalid fixture\n---\n# Instructions\n");
  const plugin = await f.start();
  await plugin.initialize([]);
  expect((await plugin.endpoints.get("skills.list")!({}, caller) as any).skills).toHaveLength(0);
  expect(plugin.events.some(event => event.type === "skills.error" && JSON.stringify(event.payload).includes("alpha"))).toBe(true);
  await plugin.shutdown();
});

test.serial("catalog write failures report source and retain the checkout and journal", async () => {
  const f = await fixture({ repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  const plugin = await f.start();
  const scope = createHash("sha256").update(await realpath(join(f.root, "data"))).digest("hex");
  const db = new Database(join(f.root, "home", ".agentorg", "skills", scope, "skills.sqlite"));
  db.exec("CREATE TRIGGER fail_catalog_insert BEFORE INSERT ON catalog BEGIN SELECT RAISE(ABORT, 'injected catalog write failure'); END;");
  await plugin.initialize([]);
  const listed = await plugin.endpoints.get("skills.list")!({}, caller) as any;
  expect(listed.skills).toHaveLength(0);
  const journals = db.query("SELECT data FROM journal").all() as Array<{ data: string }>;
  expect(journals).toHaveLength(1);
  const journal = JSON.parse(journals[0]!.data);
  await access(journal.path);
  expect(plugin.events.some(event => event.type === "skills.error" &&
    JSON.stringify(event.payload).includes("alpha") && JSON.stringify(event.payload).includes("https://github.com/example/alpha") &&
    JSON.stringify(event.payload).includes(journal.path))).toBe(true);
  db.close();
  await plugin.shutdown();
});

test.serial("lower admission limits reject new catalog entries without evicting existing entries", async () => {
  const f = await fixture({
    repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }],
    gitTimeoutMs: 60_000, maxCatalogEntries: 4,
  }, true);
  const betaSource = join(f.root, "source-beta");
  await mkdir(betaSource);
  await writeFile(join(betaSource, "SKILL.md"), "---\nname: beta\ndescription: Beta fixture\n---\n# Instructions\n");
  const plugin = await f.start();
  await plugin.initialize([]);
  (f.config as any).maxCatalogEntries = 1;
  const list = plugin.endpoints.get("skills.list")!;
  const add = plugin.endpoints.get("skills.add")!;
  await expect(add({ name: "alpha", gitUrl: betaSource }, caller)).rejects.toMatchObject({ code: "DUPLICATE" });
  await expect(add({ name: "beta", gitUrl: betaSource }, caller)).rejects.toThrow(/limit/i);
  expect((await list({}, caller) as any).skills.map((skill: any) => skill.name)).toEqual(["alpha"]);
  await plugin.shutdown();
});

test.serial("configured Git timeout bounds subsequent clone work using a controlled local runner", async () => {
  const f = await fixture({ repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 4 }, true);
  const plugin = await f.start();
  (f.config as any).gitTimeoutMs = 1_000;
  await writeFile(join(f.root, "bin", "delay"), "1200");
  const started = Date.now();
  await expect(plugin.endpoints.get("skills.add")!({ name: "alpha", gitUrl: f.source }, caller)).rejects.toThrow(/timed out|timeout/i);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect((await plugin.endpoints.get("skills.list")!({}, caller) as any).skills).toHaveLength(0);
  await plugin.shutdown();
});
