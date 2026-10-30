import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { installRoot } from "../src/index.ts";
import { git } from "../src/git.ts";
import { createLocalLifecycle } from "./helpers/local-lifecycle.ts";

test("public contract omits synchronization and recovery endpoints/history payloads", async () => {
  const f = await createLocalLifecycle();
  try {
    const snapshot = await f.client.request<any>("organization.snapshot");
    expect(snapshot.capabilities.plugins.skills.endpoints).toEqual({ list: "skills.list", registerRepository: "skills.registerRepository" });
    expect(snapshot.capabilities.plugins.skills.repositoryRegistration).toMatchObject({ version: 2, semantics: "committed-head-v2" });
    for (const method of ["skills.reconcile", "skills.updateAgent", "skills.updateRepository", "skills.revertRepository", "skills.deleteRepository"])
      await expect(f.client.request(method, {})).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    const registered = await f.addSkill("api-skill", "api-proof");
    expect(registered.record).not.toHaveProperty("history");
    const list = await f.client.request<any>("skills.list");
    expect(list).toEqual({ skills: [expect.objectContaining({ name: "api-skill" })] });
  } finally { await f.cleanup(); }
});

test("agent clones are independent mutable Git repositories and deselection/restart/cwd changes preserve local work", async () => {
  const f = await createLocalLifecycle();
  try {
    const catalog = await f.addSkill("mutable", "initial");
    const root = (await f.createAgent("root")).agent;
    const aCwd = join(f.workspace, "agent-a"), bCwd = join(f.workspace, "agent-b"); await mkdir(aCwd); await mkdir(bCwd);
    const aOp = await f.run("agent.create", { parentId: root.id, settings: { harness: "skill-consumer", model: "test", cwd: aCwd, extensions: { skills: { mutable: "installed" } } } });
    const bOp = await f.run("agent.create", { parentId: root.id, settings: { harness: "skill-consumer", model: "test", cwd: bCwd, extensions: { skills: { mutable: "installed" } } } });
    expect(aOp.status).toBe("completed"); expect(bOp.status).toBe("completed");
    const a = aOp.result as any, aDir = join(installRoot(aCwd), "mutable"), bDir = join(installRoot(bCwd), "mutable"), store = catalog.record.path;
    await git(aDir, "config", "user.name", "Agent A"); await git(aDir, "config", "user.email", "a@example.invalid");
    await Bun.write(join(aDir, "agent-private.txt"), "agent-owned"); await git(aDir, "add", "."); await git(aDir, "commit", "-m", "agent change");
    expect(await Bun.file(join(bDir, "agent-private.txt")).exists()).toBe(false);
    expect(await Bun.file(join(store, "agent-private.txt")).exists()).toBe(false);
    expect(await git(aDir, "remote")).toBe(""); expect(await git(bDir, "remote")).toBe("");

    const cleared = await f.run("agent.modify", { agentId: a.id, settings: { extensions: { skills: {} } } });
    expect(cleared.status).toBe("completed");
    expect(await Bun.file(join(aDir, "agent-private.txt")).text()).toBe("agent-owned");
    await f.restart();
    expect(await Bun.file(join(aDir, "agent-private.txt")).text()).toBe("agent-owned");
    const movedCwd = join(f.workspace, "agent-a-new"); await mkdir(movedCwd);
    const moved = await f.run("agent.modify", { agentId: a.id, settings: { cwd: movedCwd, extensions: { skills: { mutable: "installed" } } } });
    expect(moved.status).toBe("completed");
    expect(await Bun.file(join(aDir, "agent-private.txt")).text()).toBe("agent-owned");
    expect(await Bun.file(join(installRoot(movedCwd), "mutable", "SKILL.md")).exists()).toBe(true);
  } finally { await f.cleanup(); }
});
