import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Organization } from "../../agentorg/src/organization.ts";
import { validateSkillsConfig, skillsServerSettings } from "../src/config.ts";
import { ServerSettingsRegistry } from "../../agentorg/src/server-settings.ts";
import { git } from "../src/git.ts";

const defaults = { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 };

test("skills settings descriptor registers with the host registry record-list contract", () => {
  const records = new Map<string, any>();
  const store = {
    serverSettings: (namespace: string) => records.get(namespace),
    saveServerSettings: (record: any) => records.set(record.namespace, record),
  } as any;
  const registry = new ServerSettingsRegistry(store);
  registry.register(skillsServerSettings());
  const view = registry.get("skills");
  expect(view.version).toBe(1);
  expect(view.defaults).toEqual(defaults);
  expect(view.fields.find(field => field.key === "repositories")).toMatchObject({
    editor: "list", effect: "immediate", itemIdKey: "name", itemLabelKey: "name", itemDefaults: { name: "", gitUrl: "" },
    itemFields: [{ key: "name", effect: "immediate" }, { key: "gitUrl", effect: "immediate" }],
  });
});

test("skills settings persist, fence changes, reset and enforce client-only access on the real host", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-settings-host-"));
  const dataDir = join(root, "data");
  const repo = join(root, "local-alpha");
  await mkdir(repo);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "SKILL.md"), "---\nname: alpha\ndescription: Alpha settings fixture\n---\n# Instructions\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "settings fixture");
  const client = { kind: "client", id: "test" } as const;
  const agent = { kind: "agent", id: "test-agent" } as const;
  let org = new Organization(join(root, "server.sock"), dataDir);
  const events: any[] = [];
  org.onEvent(event => events.push(event));
  try {
    await org.use((await import("../src/index.ts")).createSkillsPlugin({ home: root, allowLocalSources: true }));
    const initial = await org.request("organization.settings.get", { namespace: "skills" }, client) as any;
    expect(initial.version).toBe(1);
    expect(initial.defaults).toEqual(defaults);
    const changed = await org.request("organization.settings.update", {
      namespace: "skills", expectedRevision: 0,
      patch: { repositories: [{ name: "alpha", gitUrl: repo }], gitTimeoutMs: 30_000 },
    }, client) as any;
    expect(changed.version).toBe(1);
    expect(changed.revision).toBe(1);
    expect(changed.values.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
    expect(changed.effective.repositories).toEqual(changed.values.repositories);
    expect(changed.restartRequired).not.toContain("repositories");
    expect(changed.restartRequired).toEqual([]);
    expect(org.serverSettings("skills").gitTimeoutMs).toBe(30_000);
    const settingsEvents = () => events.filter(event => event.type === "organization.settings.changed");
    const eventsBeforeNoOp = settingsEvents().length;
    const noOp = await org.request("organization.settings.update", {
      namespace: "skills", expectedRevision: 1,
      patch: { repositories: [{ name: "alpha", gitUrl: repo }], gitTimeoutMs: 30_000 },
    }, client) as any;
    expect(noOp.revision).toBe(1);
    expect(settingsEvents()).toHaveLength(eventsBeforeNoOp);
    const eventsBeforeConflict = settingsEvents().length;
    await expect(org.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: {} }, client))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(settingsEvents()).toHaveLength(eventsBeforeConflict);
    for (const method of ["list", "get", "update"])
      await expect(org.request(`organization.settings.${method}`, { namespace: "skills" }, agent)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const tools = await org.request("mcp.list", {}, agent) as any;
    expect(JSON.stringify(tools)).not.toContain("organization.settings");
    await org.close();

    org = new Organization(join(root, "server.sock"), dataDir);
    await org.use((await import("../src/index.ts")).createSkillsPlugin({ home: root, allowLocalSources: true }));
    const persisted = await org.request("organization.settings.get", { namespace: "skills" }, client) as any;
    expect(persisted.version).toBe(1);
    expect(persisted.revision).toBe(1);
    expect(persisted.values.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
    const reset = await org.request("organization.settings.update", {
      namespace: "skills", expectedRevision: 1, reset: ["repositories", "gitTimeoutMs"],
    }, client) as any;
    expect(reset.values).toEqual(defaults);
    expect(reset.revision).toBe(2);
  } finally {
    await org.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("skills config canonicalizes repository trailing slashes and rejects canonical duplicates", () => {
  const config = validateSkillsConfig({ repositories: [
    { name: "alpha", gitUrl: "https://github.com/example/alpha/" },
  ], gitTimeoutMs: 60_000, maxCatalogEntries: 256 });
  expect(config.repositories[0]!.gitUrl).toBe("https://github.com/example/alpha");
  expect(() => validateSkillsConfig({ repositories: [
    { name: "alpha", gitUrl: "https://github.com/example/alpha/" },
    { name: "beta", gitUrl: "https://github.com/example/alpha" },
  ], gitTimeoutMs: 60_000, maxCatalogEntries: 256 })).toThrow(/duplicate/i);
  for (const gitUrl of ["https://github.com:443/example/alpha", "https:github.com:443/example/alpha"]) {
    expect(() => validateSkillsConfig({ repositories: [{ name: "alpha", gitUrl }],
      gitTimeoutMs: 60_000, maxCatalogEntries: 256 })).toThrow();
  }
});
