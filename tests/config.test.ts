import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPlugin, ServerSettingsDefinition } from "agent-organization/plugin";
import { createSkillsPlugin } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function definition(allowLocalSources = false) {
  const root = await mkdtemp(join(tmpdir(), "skills-settings-contract-"));
  roots.push(root);
  await mkdir(join(root, "data"));
  let captured: ServerSettingsDefinition | undefined;
  const noop = () => {};
  const host = {
    dataDir: join(root, "data"),
    registerSettings: noop,
    registerServerSettings(value: ServerSettingsDefinition) { captured = value; },
    serverSettings: () => ({ repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 }),
    registerCapability: noop,
    beforeMutation: noop,
    onInitialize: noop,
    prepareLaunch: noop,
    validateLaunch: noop,
    registerHarness: noop,
    registerEndpoint: noop,
    registerTool: noop,
    transformTool: noop,
    beforeSettings: noop,
    onEvent: noop,
    onShutdown: noop,
    request: async () => ({}),
    emit: noop,
  };
  await (createSkillsPlugin({ home: root, allowLocalSources }) as ServerPlugin).setup(host as any);
  return captured;
}

test("skills declares the public server settings contract separately from agent selections", async () => {
  const config = await definition();
  expect(config).toBeDefined();
  expect(config).toMatchObject({
    namespace: "skills",
    title: expect.any(String),
    version: 1,
    defaults: { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
  });
  const repositories = config!.fields.find(field => field.key === "repositories");
  expect(repositories).toMatchObject({
    editor: "list", effect: "immediate", itemIdKey: "name", itemLabelKey: "name",
    itemFields: [
      { key: "name", editor: "text", effect: "immediate" },
      { key: "gitUrl", editor: "text", effect: "immediate" },
    ],
  });
  expect(config!.fields.find(field => field.key === "gitTimeoutMs")).toMatchObject({
    editor: "number", min: 1_000, max: 60_000, effect: "immediate",
  });
  expect(config!.fields.find(field => field.key === "maxCatalogEntries")).toMatchObject({
    editor: "number", min: 1, max: 256, effect: "immediate",
  });
  expect(config!.validate({ repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 })).toEqual({
    repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256,
  });
});

test("local repository seeds require the explicit embedded-test opt-in", async () => {
  const path = join(tmpdir(), "skills-local-seed-fixture");
  const publicConfig = await definition();
  expect(() => publicConfig!.validate({ repositories: [{ name: "alpha", gitUrl: path }], gitTimeoutMs: 60_000, maxCatalogEntries: 256 })).toThrow();
  const trustedConfig = await definition(true);
  expect(trustedConfig!.validate({ repositories: [{ name: "alpha", gitUrl: path }], gitTimeoutMs: 60_000, maxCatalogEntries: 256 }))
    .toEqual({ repositories: [{ name: "alpha", gitUrl: path }], gitTimeoutMs: 60_000, maxCatalogEntries: 256 });
});

test("skills settings normalize only valid unique repository seeds and bounded integer limits", async () => {
  const config = await definition();
  expect(config).toBeDefined();
  const validate = config!.validate;
  const valid = { repositories: [{ name: "alpha-skill", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 1_000, maxCatalogEntries: 1 };
  expect(validate(valid)).toEqual(valid);

  const invalid = [
    { repositories: [{ name: "../escape", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
    { repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }, { name: "alpha", gitUrl: "https://github.com/example/beta" }], gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
    { repositories: [{ name: "alpha", gitUrl: "https://github.com/example/alpha" }, { name: "beta", gitUrl: "https://github.com/example/alpha" }], gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
    ...["http://github.com/example/alpha", "https://user:secret@github.com/example/alpha", "https://github.com:443/example/alpha", "https://github.com/example/alpha?branch=main", "ssh://github.com/example/alpha", "https://localhost/example/alpha"].map(gitUrl => ({ repositories: [{ name: "alpha", gitUrl }], gitTimeoutMs: 60_000, maxCatalogEntries: 256 })),
    { repositories: [], gitTimeoutMs: 999, maxCatalogEntries: 256 },
    { repositories: [], gitTimeoutMs: 60_001, maxCatalogEntries: 256 },
    { repositories: [], gitTimeoutMs: 1_500.5, maxCatalogEntries: 256 },
    { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 0 },
    { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 257 },
    { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 1.5 },
    { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256, unknown: true },
  ];
  for (const candidate of invalid) expect(() => validate(candidate)).toThrow();
});
