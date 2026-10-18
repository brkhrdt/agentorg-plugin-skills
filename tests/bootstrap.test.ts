import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPlugin } from "agent-organization/plugin";
import { createSkillsPlugin } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  process.env.PATH = process.env.TEST_ORIGINAL_PATH ?? process.env.PATH;
  delete process.env.TEST_GIT_SOURCE;
  delete process.env.TEST_GIT_DELAY_MS;
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
setTimeout(() => { try { copy(); process.exit(0); } catch (e) { console.error(e); process.exit(1); } }, Number(process.env.TEST_GIT_DELAY_MS || 0));
`);
  await chmod(gitShim, 0o700);
  process.env.TEST_ORIGINAL_PATH ??= process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.TEST_GIT_SOURCE = source;

  const endpoints = new Map<string, (params: unknown, caller: { kind: string; id: string }) => unknown>();
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
    request: async () => ({}), emit() {},
  };
  const start = async () => {
    await (createSkillsPlugin({ home, allowLocalSources }) as ServerPlugin).setup(host as any);
    return { initialize: initialize!, shutdown: shutdown!, endpoints };
  };
  return { root, source, config, start };
}

const caller = { kind: "client", id: "test" };

test("configured repository seeds import once and identical restarts preserve the catalog path", async () => {
  const f = await fixture({
    repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }],
    gitTimeoutMs: 60_000, maxCatalogEntries: 4,
  });
  const first = await f.start();
  await first.initialize([]);
  const initial = await first.endpoints.get("skills.list")!({}, caller) as any;
  expect(initial.skills.map((skill: any) => skill.name)).toEqual(["alpha"]);
  const path = initial.skills[0].path;
  await first.shutdown();

  // Seed removal is non-destructive: an existing catalog entry is not evicted.
  f.config.repositories = [];
  const second = await f.start();
  await second.initialize([]);
  const restarted = await second.endpoints.get("skills.list")!({}, caller) as any;
  expect(restarted.skills).toHaveLength(1);
  expect(restarted.skills[0].path).toBe(path);
  await second.shutdown();
});

test("lower admission limits reject new catalog entries without evicting existing entries", async () => {
  const f = await fixture({
    repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }],
    gitTimeoutMs: 60_000, maxCatalogEntries: 1,
  }, true);
  const plugin = await f.start();
  await plugin.initialize([]);
  const list = plugin.endpoints.get("skills.list")!;
  const add = plugin.endpoints.get("skills.add")!;
  await expect(add({ name: "beta", gitUrl: f.source }, caller)).rejects.toThrow(/limit/i);
  expect((await list({}, caller) as any).skills.map((skill: any) => skill.name)).toEqual(["alpha"]);
  await plugin.shutdown();
});

test("configured Git timeout bounds subsequent clone work using a controlled local runner", async () => {
  const f = await fixture({ repositories: [], gitTimeoutMs: 1_000, maxCatalogEntries: 4 }, true);
  const plugin = await f.start();
  process.env.TEST_GIT_DELAY_MS = "1_200";
  const started = Date.now();
  await expect(plugin.endpoints.get("skills.add")!({ name: "alpha", gitUrl: f.source }, caller)).rejects.toThrow(/timed out|timeout/i);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect((await plugin.endpoints.get("skills.list")!({}, caller) as any).skills).toHaveLength(0);
  await plugin.shutdown();
});
