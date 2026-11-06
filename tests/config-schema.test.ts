import { expect, test } from "vitest";
import { validateSkillsConfig, skillsServerSettings, skillsStartupDefaults } from "../src/config.ts";
import { ServerSettingsRegistry } from "../../agentorg/src/server-settings.ts";

test("skills settings expose a restart-required store directory and no desired repository seeds", () => {
  const records = new Map<string, any>();
  const store = { serverSettings: (namespace: string) => records.get(namespace), saveServerSettings: (record: any) => records.set(record.namespace, record) } as any;
  const registry = new ServerSettingsRegistry(store);
  registry.register(skillsServerSettings());
  const view = registry.get("skills");
  expect(view.version).toBe(2);
  expect(view.defaults).toEqual(skillsStartupDefaults);
  expect(view.fields.map(field => field.key)).toEqual(["directory", "gitTimeoutMs", "maxCatalogEntries"]);
  expect(view.fields[0]).toMatchObject({ key: "directory", effect: "restart", editor: "text" });
});

test("skills settings validate bounded store paths and reject retired seed fields", () => {
  expect(validateSkillsConfig({ directory: "/srv/skills", gitTimeoutMs: 20_000, maxCatalogEntries: 20 }))
    .toEqual({ directory: "/srv/skills", gitTimeoutMs: 20_000, maxCatalogEntries: 20 });
  for (const directory of ["", "\0bad", "x".repeat(4097)])
    expect(() => validateSkillsConfig({ directory, gitTimeoutMs: 60_000, maxCatalogEntries: 256 })).toThrow();
  expect(() => validateSkillsConfig({ directory: "skills", repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 })).toThrow();
});
