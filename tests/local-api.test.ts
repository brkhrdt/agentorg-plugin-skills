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
