import { expect, test } from "bun:test";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Organization } from "../../agentorg/src/organization.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { createLocalSkillFixture } from "./helpers/local-skill.ts";

function advertisesLocalImport(descriptor: any): boolean {
  return descriptor?.repositoryRegistration?.version === 2 && descriptor.repositoryRegistration.semantics === "committed-head-v2" &&
    descriptor.repositoryRegistration.sourceKinds?.includes("server-path") && descriptor.endpoints?.registerRepository === "skills.registerRepository";
}

test("plain fixture contains otherwise-valid skill metadata but no Git repository", async () => {
  const fixture = await createLocalSkillFixture();
  try {
    expect(await readFile(join(fixture.path, "SKILL.md"), "utf8")).toContain("name: fixture-skill");
    expect((await stat(join(fixture.path, "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(fixture.path, "asset.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
    expect(await readFile(join(fixture.path, ".gitignore"), "utf8")).toContain("ignored-payload.txt");
    await access(join(fixture.path, "ignored-payload.txt"));
    await expect(access(join(fixture.path, ".git"))).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});

test("registration advertises the committed-HEAD contract and rejects a plain directory", async () => {
  const fixture = await createLocalSkillFixture();
  const org = new Organization(join(fixture.root, "server.sock"), join(fixture.root, "data"));
  try {
    await org.use(createSkillsPlugin({ home: fixture.root }));
    const snapshot = await org.request("organization.snapshot", {}, { kind: "client", id: "test" }) as any;
    const descriptor = snapshot.capabilities.plugins.skills;
    expect(descriptor).toMatchObject({ version: 1, settingsNamespace: "skills", serverSettingsNamespace: "skills",
      repositoryRegistration: { version: 2, semantics: "committed-head-v2", sourceKinds: ["https", "server-path"] },
      endpoints: { list: "skills.list", registerRepository: "skills.registerRepository" } });
    expect(advertisesLocalImport(descriptor)).toBe(true);
    expect(descriptor.endpoints).not.toHaveProperty("updateAgent");
    await expect(org.request("skills.registerRepository", { source: fixture.path }, { kind: "client", id: "test" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    await expect(org.request("skills.addFromPath", { path: fixture.path }, { kind: "client", id: "test" }))
      .rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  } finally { await org.close(); await fixture.cleanup(); }
});
