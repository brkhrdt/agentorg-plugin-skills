import { expect, test } from "bun:test";
import { validateSkillsConfig, skillsServerSettings } from "../src/config.ts";
import { ServerSettingsRegistry } from "../../agentorg/src/server-settings.ts";

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
  expect(view.defaults).toEqual(defaults);
  expect(view.fields.find(field => field.key === "repositories")).toMatchObject({
    editor: "list", itemIdKey: "name", itemLabelKey: "name", itemDefaults: { name: "", gitUrl: "" },
  });
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
