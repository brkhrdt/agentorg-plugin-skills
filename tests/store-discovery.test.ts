import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { git } from "../src/git.ts";
import { createSkillHarnessPlugin } from "./fixtures/skill-harness.ts";

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

test("verified installed clone survives a store switch without catalog fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-installed-store-switch-"));
  const dataDir = join(root, "data"), home = join(root, "home"), custom = join(root, "custom-store"), source = join(root, "source-skill"), cwd = join(root, "work");
  await mkdir(home); await mkdir(dataDir, { recursive: true }); await mkdir(cwd); await repository(source, "selected-skill");
  const proofPath = join(root, "proof.jsonl"), socketPath = join(dataDir, "org.sock");
  const options = { dataDir, socketPath, plugins: [createSkillHarnessPlugin({ bunExecutable: process.execPath, consumerPath: join(import.meta.dir, "fixtures/skill-consumer.ts"), proofPath }), createSkillsPlugin({ home })] };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    await client.request("skills.registerRepository", { source });
    const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd, extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(created.status, JSON.stringify(created)).toBe("completed");
    const installed = join(cwd, ".agents", "skills", "selected-skill");
    await writeFile(join(installed, "local-work.txt"), "keep this local work\n");
    await git(installed, "config", "user.name", "Fixture"); await git(installed, "config", "user.email", "fixture@example.invalid");
    await git(installed, "add", "."); await git(installed, "commit", "-m", "local work");
    const inode = (await stat(installed)).ino;
    const markerPath = join(installed, ".git", "agentorg-skills.json"), marker = await readFile(markerPath, "utf8");
    await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: custom } });
    await repository(join(custom, "future-skill"), "future-skill");
    client.close(); client = undefined; await server.close(); server = undefined;
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    const list = await client.request<any>("skills.list");
    expect(list.skills.map((skill: any) => skill.name)).toEqual(["future-skill"]);
    const restarted = await client.wait(await client.request<any>("agent.restart", { agentId: created.agentId }));
    expect(restarted.status).toBe("completed");
    const launched = await client.request<any>("agent.get", { agentId: created.agentId });
    expect(["running", "idle"]).toContain(launched.state);
    const proof = (await readFile(proofPath, "utf8")).trim().split("\n").map((line: string) => JSON.parse(line)).at(-1);
    expect(proof.files).toEqual([join(installed, "SKILL.md")]);
    expect(await readFile(join(installed, "local-work.txt"), "utf8")).toBe("keep this local work\n");
    expect((await stat(installed)).ino).toBe(inode);
    await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
    const unrelated = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { options: { note: "unrelated" } } }));
    expect(unrelated.status).toBe("completed");
    const sameMap = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(sameMap.status).toBe("completed");
    const movedCwd = join(root, "different-work"); await mkdir(movedCwd);
    const cwdChange = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { cwd: movedCwd } }));
    expect(cwdChange.status).toBe("failed");
    expect((await client.request<any>("agent.get", { agentId: created.agentId })).settings.cwd).toBe(cwd);
    expect(await Bun.file(join(movedCwd, ".agents", "skills", "selected-skill")).exists()).toBe(false);
    await writeFile(markerPath, JSON.stringify({ ...JSON.parse(marker), generation: "tampered" }));
    client.close(); client = undefined; await server.close(); server = undefined;
    await expect(OrganizationServer.start(options)).rejects.toThrow(/Managed checkout identity mismatch/);
    await writeFile(markerPath, marker);
    const original = join(root, "original-installed"); await rename(installed, original);
    await git(original, "clone", original, installed);
    await writeFile(join(installed, ".git", "agentorg-skills.json"), marker);
    await expect(OrganizationServer.start(options)).rejects.toThrow(/filesystem identity mismatch/);
    await rm(installed, { recursive: true, force: true }); await rename(original, installed);
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    client.close(); client = undefined; await server.close(); server = undefined;
    await rm(installed, { recursive: true, force: true });
    await expect(OrganizationServer.start(options)).rejects.toThrow(/ENOENT: no such file or directory/);
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("failed mutation compensation restores staged checkout and filesystem identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-install-compensation-"));
  const dataDir = join(root, "data"), store = join(dataDir, "skills"), home = join(root, "home"), cwd = join(root, "work");
  await mkdir(store, { recursive: true }); await mkdir(home); await mkdir(cwd); await repository(join(store, "selected-skill"), "selected-skill");
  const failurePlugin = { apiVersion: 1 as const, name: "fail-install-apply", setup(host: any) {
    host.beforeMutation((context: any) => context.method === "agent.create" ? { apply() { throw new Error("forced post-install failure"); }, rollback() {}, committed() {} } : undefined);
  } };
  const socketPath = join(dataDir, "org.sock"), options = { dataDir, socketPath, plugins: [createSkillHarnessPlugin({ bunExecutable: process.execPath, consumerPath: join(import.meta.dir, "fixtures/skill-consumer.ts"), proofPath: join(root, "proof.jsonl") }), createSkillsPlugin({ home }), failurePlugin] };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    const failed = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd, extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain("forced post-install failure");
    const destination = join(cwd, ".agents", "skills", "selected-skill");
    expect(await Bun.file(destination).exists()).toBe(false);
    const db = new Database(join(dataDir, "skills.sqlite"));
    try {
      const row = db.query("SELECT data FROM installations").get() as { data: string };
      const installation = JSON.parse(row.data);
      expect(installation.status).toBe("staged");
      expect(installation.path).toContain(".staging-");
      const info = await stat(installation.path);
      expect(installation.fsDevice).toBe(info.dev);
      expect(installation.fsInode).toBe(info.ino);
    } finally { db.close(); }
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy installation ledger rows without filesystem identity remain validated by marker and Git checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-legacy-ledger-"));
  const dataDir = join(root, "data"), store = join(dataDir, "skills"), home = join(root, "home"), cwd = join(root, "work");
  await mkdir(store, { recursive: true }); await mkdir(home); await mkdir(cwd); await repository(join(store, "selected-skill"), "selected-skill");
  const socketPath = join(dataDir, "org.sock"), options = { dataDir, socketPath, plugins: [createSkillHarnessPlugin({ bunExecutable: process.execPath, consumerPath: join(import.meta.dir, "fixtures/skill-consumer.ts"), proofPath: join(root, "proof.jsonl") }), createSkillsPlugin({ home })] };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd, extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(created.status).toBe("completed");
    await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
    client.close(); client = undefined; await server.close(); server = undefined;
    const db = new Database(join(dataDir, "skills.sqlite"));
    try {
      const rows = db.query("SELECT id, data FROM installations").all() as Array<{ id: string; data: string }>;
      expect(rows).toHaveLength(1);
      const legacy = JSON.parse(rows[0]!.data); delete legacy.fsDevice; delete legacy.fsInode;
      db.query("UPDATE installations SET data = ? WHERE id = ?").run(JSON.stringify(legacy), rows[0]!.id);
    } finally { db.close(); }
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    const record = await client.request<any>("agent.get", { agentId: created.agentId });
    expect(record.settings.extensions.skills).toEqual({ "selected-skill": "installed" });
    expect(await readFile(join(cwd, ".agents", "skills", "selected-skill", ".git", "agentorg-skills.json"), "utf8")).toContain(String(created.agentId));
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("physical store relocation preserves catalog identity and agent-owned installations", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-store-relocation-"));
  const dataDir = join(root, "data"), store = join(dataDir, "skills"), relocated = join(root, "relocated-store"), home = join(root, "home"), cwd = join(root, "work");
  await mkdir(store, { recursive: true }); await mkdir(home); await mkdir(cwd); await repository(join(store, "selected-skill"), "selected-skill");
  const socketPath = join(dataDir, "org.sock"), options = { dataDir, socketPath, plugins: [createSkillHarnessPlugin({ bunExecutable: process.execPath, consumerPath: join(import.meta.dir, "fixtures/skill-consumer.ts"), proofPath: join(root, "proof.jsonl") }), createSkillsPlugin({ home })] };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd, extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(created.status).toBe("completed");
    const installed = join(cwd, ".agents", "skills", "selected-skill");
    await writeFile(join(installed, "user.txt"), "untouched\n");
    await git(installed, "config", "user.name", "Fixture"); await git(installed, "config", "user.email", "fixture@example.invalid");
    await git(installed, "add", "."); await git(installed, "commit", "-m", "user work");
    await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
    await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: relocated } });
    client.close(); client = undefined; await server.close(); server = undefined;
    await rename(store, relocated);
    server = await OrganizationServer.start(options); client = await OrganizationClient.connect(socketPath);
    const list = await client.request<any>("skills.list");
    expect(list.skills.map((skill: any) => skill.name)).toEqual(["selected-skill"]);
    expect(list.skills[0].path).toBe(join(relocated, "selected-skill"));
    expect(await readFile(join(installed, "user.txt"), "utf8")).toBe("untouched\n");
    await client.wait(await client.request<any>("agent.remove", { agentId: created.agentId }));
    const newCwd = join(root, "new-work"); await mkdir(newCwd);
    const newAgent = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd: newCwd, extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(newAgent.status, JSON.stringify(newAgent)).toBe("completed");
    const relocatedClone = join(newCwd, ".agents", "skills", "selected-skill");
    expect(await git(relocatedClone, "rev-parse", "HEAD")).toBe(await git(join(relocated, "selected-skill"), "rev-parse", "HEAD"));
    expect(await git(relocatedClone, "status", "--porcelain")).toBe("");
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("custom store setting is restart-required and new root is scanned after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-custom-store-"));
  const dataDir = join(root, "data"), home = join(root, "home"), custom = join(root, "custom-store"), source = join(root, "source-skill"), workDir = join(root, "work");
  await mkdir(home); await mkdir(dataDir, { recursive: true }); await mkdir(workDir);
  await repository(source, "selected-skill");
  const options = { dataDir, socketPath: join(dataDir, "org.sock"), plugins: [createSkillHarnessPlugin({ bunExecutable: process.execPath, consumerPath: join(import.meta.dir, "fixtures/skill-consumer.ts"), proofPath: join(root, "proof.jsonl") }), createSkillsPlugin({ home })] };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options);
    client = await OrganizationClient.connect(options.socketPath);
    await client.request("skills.registerRepository", { source });
    const agentCwd = join(workDir, "agent");
    await mkdir(agentCwd, { recursive: true });
    const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd: agentCwd, extensions: { skills: { "selected-skill": "available" } } } }));
    expect(created.status, JSON.stringify(created)).toBe("completed");
    await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
    const updated = await client.request<any>("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: custom } });
    expect(updated.restartRequired).toContain("directory");
    await repository(join(custom, "future-skill"), "future-skill");
    client.close(); client = undefined; await server.close(); server = undefined;
    server = await OrganizationServer.start(options);
    client = await OrganizationClient.connect(options.socketPath);
    const catalog = await client.request<any>("skills.list");
    expect(catalog.skills.map((item: any) => item.name)).toEqual(["future-skill"]);
    expect(catalog.skills[0].path).toBe(join(custom, "future-skill"));
    const persisted = await client.request<any>("agent.get", { agentId: created.agentId });
    expect(persisted.state).toBe("stopped");
    expect(persisted.settings.extensions.skills).toEqual({ "selected-skill": "available" });
    const childCwd = join(workDir, "child"); await mkdir(childCwd);
    const parentBefore = await client.request<any>("agent.get", { agentId: created.agentId });
    const child = await client.wait(await client.request<any>("agent.create", { parentId: created.agentId, settings: { harness: "skill-consumer", model: "test", cwd: childCwd, extensions: { skills: { "selected-skill": "available" } } } }));
    expect(child.status).toBe("failed");
    expect(child.error?.message).toContain("Unknown skill selected-skill");
    const parentAfter = await client.request<any>("agent.get", { agentId: created.agentId });
    expect(parentAfter.revision).toBe(parentBefore.revision);
    expect(parentAfter.settings.extensions.skills).toEqual(parentBefore.settings.extensions.skills);
    const unrelated = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { options: { note: "unrelated" } } }));
    expect(unrelated.status).toBe("completed");
    const promote = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(promote.status).toBe("failed");
    expect(promote.error?.message).toContain("Unknown skill selected-skill");
    const downgraded = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { extensions: { skills: { "selected-skill": "unavailable" } } } }));
    expect(downgraded.status).toBe("completed");
    const cleared = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { extensions: { skills: {} } } }));
    expect(cleared.status).toBe("completed");
    const reassignment = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { extensions: { skills: { "selected-skill": "available" } } } }));
    expect(reassignment.status).toBe("failed");
    expect(reassignment.error?.message).toContain("Unknown skill selected-skill");
  } finally { client?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});
