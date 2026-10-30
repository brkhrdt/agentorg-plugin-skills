import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { git } from "../src/git.ts";

async function repository(path: string, name: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} discovered skill\n---\nInstructions\n`);
  await git(path, "init", "--initial-branch=main"); await git(path, "config", "user.name", "Fixture"); await git(path, "config", "user.email", "fixture@example.invalid");
  await git(path, "add", "."); await git(path, "commit", "-m", "committed skill");
}

test("catalog discovery is immediate-child, Git-only, and reads committed repositories in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-store-discovery-"));
  const dataDir = join(root, "data"), store = join(dataDir, "skills");
  await mkdir(store, { recursive: true }); await mkdir(join(root, "home"));
  await repository(join(store, "repository-one"), "discovered-one");
  await repository(join(store, "nested", "not-discovered"), "nested-skill");
  await mkdir(join(store, "plain-directory"));
  await writeFile(join(store, "plain-directory", "SKILL.md"), "---\nname: plain\ndescription: plain skill\n---\nInstructions\n");
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start({ dataDir, socketPath: join(dataDir, "org.sock"), plugins: [createSkillsPlugin({ home: join(root, "home") })] });
    client = await OrganizationClient.connect(join(dataDir, "org.sock"));
    const catalog = await client.request<any>("skills.list");
    expect(catalog.skills.map((item: any) => item.name)).toEqual(["discovered-one"]);
    expect(catalog.skills[0].path).toBe(join(store, "repository-one"));
    expect(catalog.skills[0]).not.toHaveProperty("history");
    expect(await git(join(store, "repository-one"), "status", "--porcelain")).toBe("");
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("catalog is a filesystem projection and removes entries whose store checkout disappeared", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-store-authority-"));
  const dataDir = join(root, "data"), store = join(dataDir, "skills"), repo = join(store, "temporary");
  await mkdir(store, { recursive: true }); await mkdir(join(root, "home")); await repository(repo, "temporary");
  const socketPath = join(dataDir, "org.sock"), options = { dataDir, socketPath, plugins: [createSkillsPlugin({ home: join(root, "home") })] };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    expect((await client.request<any>("skills.list")).skills).toHaveLength(1);
    client.close(); client = undefined; await server.close(); server = undefined;
    await rm(repo, { recursive: true, force: true });
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    expect((await client.request<any>("skills.list")).skills).toEqual([]);
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("custom store setting is restart-required and new root is scanned after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-custom-store-"));
  const dataDir = join(root, "data"), home = join(root, "home"), custom = join(root, "custom-store");
  await mkdir(home); await mkdir(dataDir, { recursive: true });
  const options = { dataDir, socketPath: join(dataDir, "org.sock"), plugins: [createSkillsPlugin({ home })] };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options);
    client = await OrganizationClient.connect(options.socketPath);
    const updated = await client.request<any>("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: custom } });
    expect(updated.restartRequired).toContain("directory");
    await repository(join(custom, "future-skill"), "future-skill");
    client.close(); client = undefined; await server.close(); server = undefined;
    server = await OrganizationServer.start(options);
    client = await OrganizationClient.connect(options.socketPath);
    const catalog = await client.request<any>("skills.list");
    expect(catalog.skills.map((item: any) => item.name)).toEqual(["future-skill"]);
    expect(catalog.skills[0].path).toBe(join(custom, "future-skill"));
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});
