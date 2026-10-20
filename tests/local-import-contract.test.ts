import { expect, test } from "bun:test";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Organization } from "../../agentorg/src/organization.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { createLocalSkillFixture } from "./helpers/local-skill.ts";

function advertisesLocalImport(descriptor: any): boolean {
  return descriptor?.localImport === true && descriptor?.endpoints?.addFromPath === "skills.addFromPath";
}

test("plain local skill fixture has the planned import inputs and no Git metadata", async () => {
  const fixture = await createLocalSkillFixture();
  try {
    expect(await readFile(join(fixture.path, "SKILL.md"), "utf8")).toContain("name: fixture-skill");
    expect((await stat(join(fixture.path, "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(fixture.path, "asset.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
    expect(await readFile(join(fixture.path, ".gitignore"), "utf8")).toContain("ignored-payload.txt");
    await access(join(fixture.path, "ignored-payload.txt"));
    await expect(access(join(fixture.path, ".git"))).rejects.toThrow();
  } finally {
    await fixture.cleanup();
  }
});

test("local import capability is explicit while preserving the existing Git contract", async () => {
  const dir = await createLocalSkillFixture();
  const org = new Organization(join(dir.root, "server.sock"), join(dir.root, "data"));
  try {
    await org.use(createSkillsPlugin({ home: dir.root }));
    const snapshot = await org.request("organization.snapshot", {}, { kind: "client", id: "test" }) as any;
    const descriptor = snapshot.capabilities.plugins.skills;
    expect(descriptor).toMatchObject({
      version: 1,
      settingsNamespace: "skills",
      serverSettingsNamespace: "skills",
      localImport: true,
      endpoints: { list: "skills.list", add: "skills.add", reconcile: "skills.reconcile", addFromPath: "skills.addFromPath" },
    });
    expect(advertisesLocalImport({ version: descriptor.version, endpoints: { addFromPath: "skills.addFromPath" } })).toBe(false);
    expect(advertisesLocalImport(descriptor)).toBe(true);
    await expect(org.request("skills.add", { name: "local", gitUrl: dir.path }, { kind: "client", id: "test" }))
      .rejects.toMatchObject({ code: "INVALID_PARAMS" });
  } finally {
    await org.close();
    await dir.cleanup();
  }
});
