import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentRecord, Operation } from "../../agentorg/src/types.ts";
import { installRoot, type Skill } from "../src/index.ts";
import { createLocalE2E, type E2EMode } from "./helpers/local-e2e.ts";

async function expectAbsent(path: string) { await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" }); }
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${message}`);
}
async function runMode(mode: E2EMode) {
  const f = await createLocalE2E(mode);
  let mcp: Client | undefined;
  try {
    const events: any[] = [];
    f.client.onEvent(event => { events.push(event); });
    const descriptor = (await f.client.request<any>("organization.snapshot")).capabilities.plugins.skills;
    expect(descriptor).toEqual({
      settingsNamespace: "skills", serverSettingsNamespace: "skills",
      endpoints: { list: "skills.list", add: "skills.add", reconcile: "skills.reconcile", addFromPath: "skills.addFromPath" },
      localImport: true, version: 1,
    });

    const existingCwd = join(f.workspace, "existing"); await mkdir(existingCwd);
    const existingOp = await f.run("agent.create", { parentId: null, name: "existing", settings: { harness: "skill-consumer", model: "test", cwd: existingCwd } });
    expect(existingOp.status).toBe("completed");
    const existing = existingOp.result as AgentRecord;
    const beforeRegistration = await f.client.request<AgentRecord>("agent.get", { agentId: existing.id });
    const marker = `local-e2e-${mode}-proof`;
    const source = join(f.root, "user-skill"); await mkdir(source);
    await writeFile(join(source, "SKILL.md"), `---\nname: e2e-skill\ndescription: Deterministic ${mode} fixture\n---\n\nRead and return exact marker: ${marker}\n`);
    await writeFile(join(source, "identity.marker"), `${marker}\n`);
    const added = await f.client.request<Skill>("skills.addFromPath", { path: source });
    expect(added).toMatchObject({ name: "e2e-skill", source: { kind: "local", path: source }, origin: "manual" });
    expect(added.gitUrl).toBeUndefined();
    const afterRegistration = await f.client.request<AgentRecord>("agent.get", { agentId: existing.id });
    expect(afterRegistration.revision).toBe(beforeRegistration.revision);
    expect(afterRegistration.generation).toBe(beforeRegistration.generation);
    expect(afterRegistration.settings.extensions?.skills).toBeUndefined();
    await expectAbsent(join(installRoot(existingCwd), "e2e-skill"));
    expect((await f.client.request<any>("skills.list")).skills).toContainEqual(expect.objectContaining({ name: "e2e-skill", path: added.path, source: added.source, origin: "manual" }));
    await waitFor(async () => events, found => found.some(event => event.type === "skills.catalog_added" && event.data?.name === "e2e-skill"), "catalog_added event");
    expect(events.find(event => event.type === "skills.catalog_added" && event.data?.name === "e2e-skill").data).toMatchObject({ source: added.source, path: added.path, origin: "manual" });
    await expect(f.client.request("skills.addFromPath", { path: source, extra: true })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(f.client.request("skills.addFromPath", { path: join(f.root, "missing") })).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(f.client.request("skills.addFromPath", { path: source })).rejects.toMatchObject({ code: "DUPLICATE" });

    const installedExisting = await f.run("agent.modify", { agentId: existing.id, settings: { extensions: { skills: { "e2e-skill": "installed" } } } });
    expect(installedExisting.status).toBe("completed");
    const newCwd = join(f.workspace, "new-selected"); await mkdir(newCwd);
    const createdSelected = await f.run("agent.create", { parentId: existing.id, name: "new-selected", settings: { harness: "skill-consumer", model: "test", cwd: newCwd, extensions: { skills: { "e2e-skill": "installed" } } } });
    expect(createdSelected.status, JSON.stringify(createdSelected.error)).toBe("completed");
    const newSelected = createdSelected.result as AgentRecord;
    const existingSkillPath = join(installRoot(existingCwd), "e2e-skill");
    const newSkillPath = join(installRoot(newCwd), "e2e-skill");
    expect(existingSkillPath).not.toBe(newSkillPath);
    expect(JSON.parse(await readFile(join(existingSkillPath, ".git", "agentorg-skills.json"), "utf8")).agentId).toBe(existing.id);
    expect(JSON.parse(await readFile(join(newSkillPath, ".git", "agentorg-skills.json"), "utf8")).agentId).toBe(newSelected.id);
    await writeFile(join(existingSkillPath, "identity.marker"), "existing-agent-only\n");
    expect(await readFile(join(newSkillPath, "identity.marker"), "utf8")).toContain(marker);
    expect(await readFile(join(source, "identity.marker"), "utf8")).toContain(marker);
    expect(await readFile(join(added.path, "identity.marker"), "utf8")).toContain(marker);

    const availableCwd = join(f.workspace, "available-only"); await mkdir(availableCwd);
    const availableOp = await f.run("agent.create", { parentId: existing.id, name: "available-only", settings: { harness: "skill-consumer", model: "test", cwd: availableCwd, extensions: { skills: { "e2e-skill": "available" } } } });
    expect(availableOp.status).toBe("completed");
    const available = availableOp.result as AgentRecord;
    await expectAbsent(join(installRoot(availableCwd), "e2e-skill"));
    const availablePrompt = await f.run("agent.prompt", { agentId: available.id, text: "report available-only state" });
    expect(availablePrompt.status).toBe("completed");
    expect((availablePrompt.result as any).text).not.toContain(marker);
    const promptExisting = await f.run("agent.prompt", { agentId: existing.id, text: "read my installed skill" });
    const promptNew = await f.run("agent.prompt", { agentId: newSelected.id, text: "read my installed skill" });
    expect(promptExisting.status).toBe("completed"); expect(promptNew.status).toBe("completed");
    expect((promptExisting.result as any).text).toContain(marker); expect((promptNew.result as any).text).toContain(marker);
    const proofs = await f.proofs();
    expect(proofs.findLast(item => item.event === "prompt" && item.agentId === available.id)?.paths).toEqual([]);
    expect(proofs.findLast(item => item.event === "prompt" && item.agentId === existing.id)?.paths).toEqual([join(existingSkillPath, "SKILL.md")]);
    expect(proofs.findLast(item => item.event === "prompt" && item.agentId === newSelected.id)?.paths).toEqual([join(newSkillPath, "SKILL.md")]);

    const availableLaunch = proofs.findLast(item => item.event === "launch" && item.agentId === available.id)!;
    expect(availableLaunch.token).toBeTruthy();
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../../agentorg/src/mcp-bridge.ts")],
      env: { ...(process.env as Record<string, string>), ORG_SOCKET: f.socketPath, ORG_TOKEN: availableLaunch.token! } });
    mcp = new Client({ name: `local-e2e-${mode}`, version: "1" }); await mcp.connect(transport);
    const toolNames = (await mcp.listTools()).tools.map(tool => tool.name);
    expect(toolNames).toContain("skills_list"); expect(toolNames).not.toContain("skills.addFromPath");
    await mcp.close(); mcp = undefined;

    await rm(source, { recursive: true, force: true });
    await f.restart();
    const afterRestart = await f.client.request<any>("skills.list");
    expect(afterRestart.skills.find((skill: Skill) => skill.name === "e2e-skill")).toMatchObject({ path: added.path, source: added.source });
    expect(await readFile(join(added.path, "SKILL.md"), "utf8")).toContain(marker);
    const afterRestartCwd = join(f.workspace, "after-host-restart"); await mkdir(afterRestartCwd);
    const afterRestartCreate = await f.run("agent.create", { parentId: existing.id, name: "after-restart", settings: { harness: "skill-consumer", model: "test", cwd: afterRestartCwd, extensions: { skills: { "e2e-skill": "installed" } } } });
    expect(afterRestartCreate.status).toBe("completed");
    const afterRestartAgent = afterRestartCreate.result as AgentRecord;
    const afterRestartPrompt = await f.run("agent.prompt", { agentId: afterRestartAgent.id, text: "read the preserved central copy" });
    expect(afterRestartPrompt.status).toBe("completed"); expect((afterRestartPrompt.result as any).text).toContain(marker);
  } finally { await mcp?.close().catch(() => {}); await f.cleanup(); }
}

test("local import works in source mode and the relocated bundled mode when ORG_BINARY is supplied", async () => {
  const modes: E2EMode[] = process.env.ORG_BINARY ? ["source", "bundled"] : ["source"];
  for (const mode of modes) await runMode(mode);
}, 120_000);
