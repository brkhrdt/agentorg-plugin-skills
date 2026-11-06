import { fileText } from "./helpers/runtime.ts";
import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Organization } from "../../agentorg/src/organization.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { git } from "../src/git.ts";

const client = { kind: "client", id: "skills-api-test" } as const;
async function createRepository(path: string, name: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} Git API fixture\n---\nInstructions\n`);
  await writeFile(join(path, "proof.txt"), "committed-content\n");
  await git(path, "init", "--initial-branch=main"); await git(path, "config", "user.name", "Fixture"); await git(path, "config", "user.email", "fixture@example.invalid");
  await git(path, "add", "."); await git(path, "commit", "-m", "skill");
}

test("registration uses committed local Git roots and exposes no history or removed lifecycle endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-local-api-"));
  const home = join(root, "home"), repo = join(root, "git-skill"), plain = join(root, "plain-skill");
  await mkdir(home); await mkdir(plain); await writeFile(join(plain, "SKILL.md"), "---\nname: plain\ndescription: plain\n---\nInstructions\n");
  await createRepository(repo, "api-skill");
  const org = new Organization(join(root, "server.sock"), join(root, "data"));
  try {
    await org.use(createSkillsPlugin({ home }));
    const snapshot = await org.request("organization.snapshot", {}, client) as any;
    expect(snapshot.capabilities.plugins.skills.endpoints).toEqual({ list: "skills.list", registerRepository: "skills.registerRepository" });
    expect(snapshot.capabilities.plugins.skills.repositoryRegistration).toMatchObject({ version: 2, semantics: "committed-head-v2" });
    for (const method of ["skills.reconcile", "skills.updateAgent", "skills.updateRepository", "skills.revertRepository", "skills.deleteRepository"])
      await expect(org.request(method, {}, client)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(org.request("skills.registerRepository", { source: plain }, client)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    await expect(org.request("skills.add", { name: "plain", gitUrl: plain }, client)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    const imported = await org.request("skills.registerRepository", { source: repo }, client) as any;
    expect(imported).toMatchObject({ name: "api-skill", source: { kind: "local", path: repo }, description: "api-skill Git API fixture" });
    expect(imported).not.toHaveProperty("history");
    expect(await fileText(join(imported.path, "proof.txt"))).toBe("committed-content\n");
    await expect(org.request("skills.registerRepository", { source: repo }, client)).rejects.toMatchObject({ code: "DUPLICATE" });
    expect(((await org.request("skills.list", {}, client) as any).skills)).toEqual([imported]);
  } finally { await org.close(); await rm(root, { recursive: true, force: true }); }
});
