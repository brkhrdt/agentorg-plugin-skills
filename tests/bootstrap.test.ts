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
  for (const key of ["TEST_GIT_CALLS", "TEST_GIT_FAIL", "TEST_GIT_GATE_URL", "TEST_GIT_GATE_ENTERED", "TEST_GIT_GATE_RELEASE"]) delete process.env[key];
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
if (process.env.TEST_GIT_CALLS) fs.appendFileSync(process.env.TEST_GIT_CALLS, input + '\\n');
if (process.env.TEST_GIT_FAIL && fs.existsSync(process.env.TEST_GIT_FAIL)) process.exit(1);
const source = input.startsWith('https://') ? process.env.TEST_GIT_SOURCE : input;
const copy = () => { fs.mkdirSync(destination, { recursive: true }); fs.cpSync(source, destination, { recursive: true }); fs.mkdirSync(path.join(destination, '.git'), { recursive: true }); };
const delay = fs.existsSync(path.join(__dirname, 'delay')) ? Number(fs.readFileSync(path.join(__dirname, 'delay'), 'utf8')) : 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => { try {
  if (input === process.env.TEST_GIT_GATE_URL) {
    fs.writeFileSync(process.env.TEST_GIT_GATE_ENTERED, 'entered');
    while (!fs.existsSync(process.env.TEST_GIT_GATE_RELEASE)) await pause(10);
  }
  await pause(delay); copy(); process.exit(0);
} catch (e) { console.error(e); process.exit(1); } })();
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
    request: async (method: string) => method === "organization.settings.get" ? { revision: 0, effective: structuredClone(config) } : ({}), emit(type: string, payload: unknown) { events.push({ type, payload }); },
  };
  const start = async () => {
    await (createSkillsPlugin({ home, allowLocalSources }) as ServerPlugin).setup(host as any);
    return { initialize: initialize!, shutdown: shutdown!, endpoints, events };
  };
  return { root, source, config, start };
}

const caller = { kind: "client", id: "test" };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for bootstrap fixture state");
    await pause(20);
  }
};
const databasePath = async (root: string) => join(root, "home", ".agentorg", "skills",
  createHash("sha256").update(await realpath(join(root, "data"))).digest("hex"), "skills.sqlite");

test.serial("a status read schedules reconciliation after a missed settings event", async () => {
  const f = await fixture({ repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 4 }, true);
  const plugin = await f.start();
  try {
    await plugin.initialize([]);
    (f.config as any).repositories = [{ name: "alpha", gitUrl: f.source }];
    const before = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(before.skills).toHaveLength(0);
    expect(before.reconciliation.state).toBe("pending");
    await waitFor(async () => {
      const current = await plugin.endpoints.get("skills.list")!({}, caller) as any;
      return current.reconciliation.state === "ready" && current.skills.some((item: any) => item.name === "alpha");
    });
    const after = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(after.reconciliation.state).toBe("ready");
    expect(after.skills[0].origin).toBe("configured");
  } finally { await plugin.shutdown(); }
});

test.serial("configured repository seeds import once; identical restarts preserve path and metadata", async () => {
  const f = await fixture({
    repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }],
    gitTimeoutMs: 60_000, maxCatalogEntries: 4,
  });
  const first = await f.start();
  await first.initialize([]);
  const initial = await first.endpoints.get("skills.list")!({}, caller) as any;
  expect(initial.skills.map((skill: any) => skill.name)).toEqual(["alpha"]);
  expect(initial.reconciliation).toMatchObject({ state: "ready", entries: [{ name: "alpha", status: "ready" }] });
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
  expect(afterRemoval.skills).toHaveLength(0);
  expect(afterRemoval.retained).toHaveLength(1);
  expect(afterRemoval.retained[0]).toMatchObject({ path: original.path, createdAt: original.createdAt, status: "retired" });
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
  const view = await conflict.endpoints.get("skills.list")!({}, caller) as any;
  expect(view.skills).toHaveLength(0);
  expect(view.retained).toHaveLength(1);
  expect(view.retained[0]).toMatchObject({ path: original.path, gitUrl: original.gitUrl, createdAt: original.createdAt });
  expect(view.reconciliation.entries[0]).toMatchObject({ name: "alpha", status: "error" });
  expect(conflict.events.some(event => event.type === "skills.error" && JSON.stringify(event.payload).includes("alpha"))).toBe(true);
  await conflict.shutdown();
});

test.serial("invalid configured checkout remains unregistered with an actionable seed report", async () => {
  const f = await fixture({ repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  await writeFile(join(f.source, "SKILL.md"), "---\nname: wrong\ndescription: Invalid fixture\n---\n# Instructions\n");
  const plugin = await f.start();
  await plugin.initialize([]);
  const view = await plugin.endpoints.get("skills.list")!({}, caller) as any;
  expect(view.skills).toHaveLength(0);
  expect(view.reconciliation.entries).toMatchObject([{ name: "alpha", status: "error" }]);
  expect(view.reconciliation.entries[0].error).toContain("SKILL.md");
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

test.serial("manual name and URL contention settles configured entries as conflicts", async () => {
  const f = await fixture({ repositories: [
    { name: "alpha", gitUrl: "https://github.com/example/configured" },
    { name: "beta", gitUrl: "https://github.com/example/manual" },
  ], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  const plugin = await f.start();
  try {
    const manual = await plugin.endpoints.get("skills.add")!({ name: "alpha", gitUrl: "https://github.com/example/manual" }, caller) as any;
    expect(manual.name).toBe("alpha");
    await plugin.initialize([]);
    const view = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(view.reconciliation.state).toBe("error");
    expect(view.reconciliation.entries).toMatchObject([
      { name: "alpha", status: "error" }, { name: "beta", status: "error" },
    ]);
    expect(view.reconciliation.entries.every((entry: any) => /conflict/i.test(entry.error))).toBe(true);
    expect(view.skills.map((item: any) => item.name)).toEqual(["alpha"]);
  } finally { await plugin.shutdown(); }
});

test.serial("reservation release wakes the reconciler and persists the resulting manual/configured conflict", async () => {
  const f = await fixture({ repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 4 }, true);
  const entered = join(f.root, "manual-entered"), release = join(f.root, "manual-release");
  process.env.TEST_GIT_GATE_URL = f.source;
  process.env.TEST_GIT_GATE_ENTERED = entered;
  process.env.TEST_GIT_GATE_RELEASE = release;
  const plugin = await f.start(); let pluginClosed = false;
  try {
    const pendingManual = plugin.endpoints.get("skills.add")!({ name: "alpha", gitUrl: f.source }, caller) as Promise<any>;
    await waitFor(async () => Bun.file(entered).exists());
    (f.config as any).repositories = [{ name: "alpha", gitUrl: "https://github.com/example/configured" }];
    const pending = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(pending.reconciliation.entries).toMatchObject([{ name: "alpha", status: "pending" }]);
    await writeFile(release, "release");
    const manual = await pendingManual;
    expect(manual.origin).toBe("manual");
    await waitFor(async () => {
      const result = await plugin.endpoints.get("skills.list")!({}, caller) as any;
      return result.reconciliation.entries[0]?.status === "error";
    });
    const result = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(result.reconciliation.entries[0].error).toContain("conflict");
    expect(result.skills[0].origin).toBe("manual");
    await plugin.shutdown(); pluginClosed = true;
    const restarted = await f.start();
    try {
      await restarted.initialize([]);
      const persisted = await restarted.endpoints.get("skills.list")!({}, caller) as any;
      expect(persisted.reconciliation.entries).toMatchObject([{ name: "alpha", status: "error" }]);
      expect(persisted.skills.map((item: any) => item.origin)).toEqual(["manual"]);
    } finally { await restarted.shutdown(); }
  } finally { if (!pluginClosed) await plugin.shutdown(); }
});

test.serial("legacy catalog ownership migration exposes configured versus manual provenance", async () => {
  const f = await fixture({ repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  const betaSource = join(f.root, "source-beta"); await mkdir(betaSource);
  await writeFile(join(betaSource, "SKILL.md"), "---\nname: beta\ndescription: Beta fixture\n---\n# Instructions\n");
  const dbPath = await databasePath(f.root); await mkdir(join(dbPath, ".."), { recursive: true });
  const legacy = new Database(dbPath);
  legacy.exec("CREATE TABLE meta(version INTEGER NOT NULL); INSERT INTO meta VALUES (1); CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL);");
  const record = (name: string, gitUrl: string, path: string) => ({ name, gitUrl, path, description: `${name} fixture`, createdAt: "2025-01-01T00:00:00.000Z" });
  legacy.query("INSERT INTO catalog VALUES (?,?,?)").run("alpha", "https://github.com/example/alpha", JSON.stringify(record("alpha", "https://github.com/example/alpha", f.source)));
  legacy.query("INSERT INTO catalog VALUES (?,?,?)").run("beta", "https://github.com/example/beta", JSON.stringify(record("beta", "https://github.com/example/beta", betaSource)));
  legacy.close();
  const plugin = await f.start();
  try {
    await plugin.initialize([]);
    const first = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(first.skills.map((item: any) => [item.name, item.origin])).toEqual([["alpha", "configured"], ["beta", "manual"]]);
    (f.config as any).repositories = [
      { name: "alpha", gitUrl: "https://github.com/example/alpha" },
      { name: "beta", gitUrl: "https://github.com/example/beta" },
    ];
    await plugin.initialize([]);
    expect((await plugin.endpoints.get("skills.list")!({}, caller) as any).skills.find((item: any) => item.name === "beta").origin).toBe("manual");
    (f.config as any).repositories = [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }];
    await plugin.initialize([]);
    const afterBetaConfigRemoval = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(afterBetaConfigRemoval.skills.find((item: any) => item.name === "beta").origin).toBe("manual");
    (f.config as any).repositories = [];
    await plugin.initialize([]);
    const afterRemoval = await plugin.endpoints.get("skills.list")!({}, caller) as any;
    expect(afterRemoval.retained.find((item: any) => item.name === "alpha").origin).toBe("configured");
    expect(afterRemoval.skills.map((item: any) => item.name)).toContain("beta");
  } finally { await plugin.shutdown(); }
});

test.serial("malformed YAML is permanent and does not consume transient retry attempts", async () => {
  const f = await fixture({ repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  await writeFile(join(f.source, "SKILL.md"), "---\nname: [broken\n---\n# Instructions\n");
  const calls = join(f.root, "git-calls"); process.env.TEST_GIT_CALLS = calls;
  const plugin = await f.start();
  try {
    await plugin.initialize([]);
    expect((await plugin.endpoints.get("skills.list")!({}, caller) as any).reconciliation.entries[0].status).toBe("error");
    await pause(1_250);
    expect((await Bun.file(calls).text()).trim().split("\n")).toHaveLength(1);
    const db = new Database(await databasePath(f.root), { readonly: true });
    const state = JSON.parse((db.query("SELECT data FROM repository_state WHERE name='alpha'").get() as any).data);
    db.close();
    expect(state.attempts).toBe(1);
  } finally { await plugin.shutdown(); }
});

test.serial("restart resets an exhausted transient retry budget", async () => {
  const f = await fixture({ repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 4 });
  const calls = join(f.root, "git-calls"), failure = join(f.root, "git-failure");
  process.env.TEST_GIT_CALLS = calls; process.env.TEST_GIT_FAIL = failure;
  await writeFile(failure, "fail");
  const first = await f.start(); let firstClosed = false;
  try {
    await first.initialize([]);
    await waitFor(async () => (await Bun.file(calls).text().catch(() => "")).trim().split("\n").filter(Boolean).length >= 3, 8_000);
    await pause(30);
    const db = new Database(await databasePath(f.root), { readonly: true });
    const state = JSON.parse((db.query("SELECT data FROM repository_state WHERE name='alpha'").get() as any).data);
    db.close();
    expect(state.attempts).toBe(3);
    await first.shutdown(); firstClosed = true;
    await rm(failure, { force: true });
    const restarted = await f.start();
    await restarted.initialize([]);
    const count = (await Bun.file(calls).text()).trim().split("\n").filter(Boolean).length;
    expect(count).toBe(4);
    expect((await restarted.endpoints.get("skills.list")!({}, caller) as any).reconciliation.state).toBe("ready");
    await restarted.shutdown();
  } finally { if (!firstClosed) await first.shutdown(); }
}, 20_000);
