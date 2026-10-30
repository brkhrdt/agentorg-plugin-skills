import { expect, test } from "bun:test";
import { skillsServerSettings, validateSkillsConfig } from "../src/config.ts";

test("directory and bounded Git settings are public while seed configuration is retired", () => {
  const definition = skillsServerSettings();
  expect(definition.version).toBe(2);
  expect(definition.fields.map(field => field.key)).toEqual(["directory", "gitTimeoutMs", "maxCatalogEntries"]);
  expect(definition.fields[0]).toMatchObject({ effect: "restart", editor: "text" });
  expect(definition.validate({ directory: "skills", gitTimeoutMs: 60_000, maxCatalogEntries: 256 }))
    .toEqual({ directory: "skills", gitTimeoutMs: 60_000, maxCatalogEntries: 256 });
  expect(() => definition.validate({ directory: "skills", repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 })).toThrow();
});

test("directory path settings are normalized and bounded", () => {
  for (const directory of ["/srv/org/skills", "../skill-store", "~/skills"]) {
    expect(validateSkillsConfig({ directory, gitTimeoutMs: 1_000, maxCatalogEntries: 1 }).directory).toBe(directory);
  }
  for (const input of [
    { directory: "", gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
    { directory: "x".repeat(4097), gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
    { directory: "skills", gitTimeoutMs: 999, maxCatalogEntries: 256 },
    { directory: "skills", gitTimeoutMs: 60_000, maxCatalogEntries: 0 },
    { directory: "skills", gitTimeoutMs: 60_000, maxCatalogEntries: 256, unknown: true },
  ]) expect(() => validateSkillsConfig(input)).toThrow();
});
