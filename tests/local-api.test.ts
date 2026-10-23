import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Organization } from "../../agentorg/src/organization.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { createLocalSkillFixture } from "./helpers/local-skill.ts";

const client = { kind: "client", id: "local-import-test" } as const;
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "skills-local-api-"));
  const org = new Organization(join(root, "server.sock"), join(root, "data"));
  const events: any[] = [];
  org.onEvent(event => { events.push(event); });
  await org.use(createSkillsPlugin({ home: root }));
  return { root, org, events, cleanup: async () => { await org.close(); await rm(root, { recursive: true, force: true }); } };
}

async function namedFixture(name: string) {
  const fixture = await createLocalSkillFixture();
  await writeFile(join(fixture.path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} local API fixture\n---\n\nInstructions.\n`);
  return fixture;
}

test("unified repository registration derives a local directory record and advertises its history contract", async () => {
  const f = await setup(), fixture = await namedFixture("unified-directory");
  try {
    const capability = (await f.org.request("organization.snapshot", {}, client) as any).capabilities.plugins.skills;
    expect(capability).toMatchObject({
      endpoints: { registerRepository: "skills.registerRepository" },
      repositoryRegistration: { version: 1, sourceKinds: ["https", "server-path"], history: "preserve-v1" },
      localImportHistory: "preserve-v1",
    });
    const response = await f.org.request("skills.registerRepository", { source: fixture.path }, client) as any;
    expect(response).toMatchObject({
      name: "unified-directory", description: "unified-directory local API fixture",
      source: { kind: "local", path: fixture.path }, origin: "manual",
      history: { mode: "directory-initialized" },
    });
    expect(response.gitUrl).toBeUndefined();
    expect(response.path).toContain("local-import-staging");
    expect(response.history.selectedCommit).toMatch(/^[0-9a-f]{40}$/);
    const listing = await f.org.request("skills.list", {}, client) as any;
    expect(listing.skills.find((item: any) => item.name === "unified-directory")).toEqual(response);
    expect(f.events.some(event => event.type === "skills.catalog_added" && event.data?.name === "unified-directory")).toBe(true);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("manual catalog retirement is reversible and identity-fenced without deleting the catalog row", async () => {
  const f = await setup(), fixture = await namedFixture("retire-me");
  try {
    const capability = (await f.org.request("organization.snapshot", {}, client) as any).capabilities.plugins.skills;
    expect(capability).toMatchObject({
      catalogManagement: { version: 1, semantics: "reversible-retirement-v1", sourceIdentity: "name+source-v1" },
      endpoints: { retireRepository: "skills.retireRepository", restoreRepository: "skills.restoreRepository" },
    });
    const record = await f.org.request("skills.registerRepository", { source: fixture.path }, client) as any;
    const stale = { name: record.name, source: { ...record.source, path: `${fixture.path}-stale` }, expectedStatus: "ready" };
    await expect(f.org.request("skills.retireRepository", stale, client)).rejects.toMatchObject({ code: "CONFLICT" });
    const retired = await f.org.request("skills.retireRepository", { name: record.name, source: record.source, expectedStatus: "ready" }, client) as any;
    expect(retired.status).toBe("retired");
    expect(retired.skill).toMatchObject({ name: record.name, path: record.path, source: record.source, history: record.history });
    const retiredList = await f.org.request("skills.list", {}, client) as any;
    expect(retiredList.skills.some((item: any) => item.name === record.name)).toBe(false);
    expect(retiredList.managed.find((item: any) => item.name === record.name)).toMatchObject({ status: "retired", path: record.path, source: record.source });
    const restored = await f.org.request("skills.restoreRepository", { name: record.name, source: record.source, expectedStatus: "retired" }, client) as any;
    expect(restored.status).toBe("ready");
    expect((await f.org.request("skills.list", {}, client) as any).skills.some((item: any) => item.name === record.name)).toBe(true);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("permanent deletion clears a manual catalog entry and its central managed directory but preserves the original source", async () => {
  const f = await setup(), fixture = await namedFixture("delete-me");
  try {
    const capability = (await f.org.request("organization.snapshot", {}, client) as any).capabilities.plugins.skills;
    expect(capability.endpoints.deleteRepository).toBe("skills.deleteRepository");
    const record = await f.org.request("skills.registerRepository", { source: fixture.path }, client) as any;
    expect(existsSync(record.path)).toBe(true);
    const deleted = await f.org.request("skills.deleteRepository", { name: record.name, source: record.source, expectedStatus: "ready" }, client) as any;
    expect(deleted).toMatchObject({ name: record.name, source: record.source, status: "deleted", removedAssignments: 0, removedInstallations: 0 });
    expect(existsSync(record.path)).toBe(false);
    expect(existsSync(fixture.path)).toBe(true);
    const listing = await f.org.request("skills.list", {}, client) as any;
    expect(listing.skills.some((item: any) => item.name === record.name)).toBe(false);
    expect(listing.managed.some((item: any) => item.name === record.name)).toBe(false);
  } finally { await fixture.cleanup(); await f.cleanup(); }
});

test("unified registration validates exact params and authorization before path access", async () => {
  const f = await setup();
  try {
    await expect(f.org.request("skills.registerRepository", null, { kind: "agent", id: "not-real" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.org.request("skills.registerRepository", { source: "/definitely/missing", extra: true }, client))
      .rejects.toMatchObject({ code: "INVALID_PARAMS" });
  } finally { await f.cleanup(); }
});

test("client endpoint imports directory, SKILL.md, relative path, and OS-home tilde with consistent records/events", async () => {
  const f = await setup();
  const dirFixture = await namedFixture("directory-skill"), fileFixture = await namedFixture("file-skill"), relativeFixture = await namedFixture("relative-skill"), tildeFixture = await namedFixture("tilde-skill"), spacesFixture = await namedFixture("spaces-skill");
  const homeRoot = await mkdtemp(join(homedir(), ".agentorg-local-api-"));
  try {
    const alias = join(homeRoot, "tilde-source"); await symlink(tildeFixture.path, alias, "dir");
    const spacedAlias = join(f.root, "local source with spaces"); await symlink(spacesFixture.path, spacedAlias, "dir");
    const paths = [dirFixture.path, join(fileFixture.path, "SKILL.md"), relative(process.cwd(), relativeFixture.path), `~/${relative(homedir(), alias)}`, spacedAlias];
    for (let i = 0; i < paths.length; i++) {
      const name = ["directory-skill", "file-skill", "relative-skill", "tilde-skill", "spaces-skill"][i]!;
      const response = await f.org.request("skills.addFromPath", { path: paths[i] }, client) as any;
      expect(response).toMatchObject({ name, source: { kind: "local" }, origin: "manual" });
      expect(response.gitUrl).toBeUndefined();
      expect(response.path).toContain("local-import-staging");
      const listing = await f.org.request("skills.list", {}, client) as any;
      expect(listing.skills.find((item: any) => item.name === name)).toEqual(response);
      expect(f.events.some(event => event.type === "skills.catalog_added" && event.data?.name === name)).toBe(true);
    }
    expect((await f.org.request("organization.snapshot", {}, client) as any).capabilities.plugins.skills).toMatchObject({
      version: 1, localImport: true, endpoints: { list: "skills.list", add: "skills.add", reconcile: "skills.reconcile", addFromPath: "skills.addFromPath" },
    });
  } finally {
    await dirFixture.cleanup(); await fileFixture.cleanup(); await relativeFixture.cleanup(); await tildeFixture.cleanup(); await spacesFixture.cleanup();
    await rm(homeRoot, { recursive: true, force: true }); await f.cleanup();
  }
});

test("authorization precedes malformed params and path access; request shape is strict", async () => {
  const f = await setup();
  try {
    const storageRoot = join(f.root, ".agentorg", "skills");
    await expect(f.org.request("skills.addFromPath", null, { kind: "agent", id: "not-real" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.org.request("skills.addFromPath", { path: "/definitely/missing", extra: true }, client))
      .rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(f.org.request("skills.addFromPath", { path: "/definitely/missing" }, client))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    for (const scope of await readdir(storageRoot)) expect(existsSync(join(storageRoot, scope, "local-import-staging"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("metadata, unsafe paths, duplicates and catalogue limits map to stable API codes", async () => {
  const f = await setup(), invalid = await createLocalSkillFixture(), unsafe = await namedFixture("unsafe-skill"), first = await namedFixture("first-skill");
  try {
    await writeFile(join(invalid.path, "SKILL.md"), "---\nname: ../bad\ndescription: invalid\n---\n\nInstructions.\n");
    await expect(f.org.request("skills.addFromPath", { path: invalid.path }, client)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(f.org.request("skills.addFromPath", { path: join(invalid.root, "missing") }, client)).rejects.toMatchObject({ code: "INVALID_PATH" });
    const outside = join(f.root, "outside"); await writeFile(outside, "private"); await symlink(outside, join(unsafe.path, "linked"));
    await expect(f.org.request("skills.addFromPath", { path: unsafe.path }, client)).rejects.toMatchObject({ code: "INVALID_PATH" });
    await f.org.request("skills.addFromPath", { path: first.path }, client);
    await expect(f.org.request("skills.addFromPath", { path: first.path }, client)).rejects.toMatchObject({ code: "DUPLICATE" });
    const settings = await f.org.request("organization.settings.get", { namespace: "skills" }, client) as any;
    await f.org.request("organization.settings.update", {
      namespace: "skills", expectedRevision: settings.revision, patch: { maxCatalogEntries: 1 },
    }, client);
    const second = await namedFixture("second-skill");
    try { await expect(f.org.request("skills.addFromPath", { path: second.path }, client)).rejects.toMatchObject({ code: "LIMIT" }); }
    finally { await second.cleanup(); }
    expect((await f.org.request("skills.list", {}, client) as any).skills.map((item: any) => item.name)).toEqual(["first-skill"]);
  } finally { await invalid.cleanup(); await unsafe.cleanup(); await first.cleanup(); await f.cleanup(); }
});

test("concurrent admissions share publication uniqueness and capacity", async () => {
  const f = await setup(), a = await namedFixture("alpha-skill"), b = await namedFixture("beta-skill");
  try {
    const settings = await f.org.request("organization.settings.get", { namespace: "skills" }, client) as any;
    await f.org.request("organization.settings.update", { namespace: "skills", expectedRevision: settings.revision, patch: { maxCatalogEntries: 1 } }, client);
    const outcomes = await Promise.allSettled([
      f.org.request("skills.addFromPath", { path: a.path }, client),
      f.org.request("skills.addFromPath", { path: b.path }, client),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect((await f.org.request("skills.list", {}, client) as any).skills).toHaveLength(1);
  } finally { await a.cleanup(); await b.cleanup(); await f.cleanup(); }
});
