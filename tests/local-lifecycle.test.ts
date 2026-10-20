import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentRecord, Operation } from "../../agentorg/src/types.ts";
import { installRoot, states, type Skill } from "../src/index.ts";
import { git } from "../src/git.ts";
import { createLocalLifecycle } from "./helpers/local-lifecycle.ts";

const resultText = (result: any) => JSON.parse(result.content.find((item: any) => item.type === "text").text);
async function connectMcp(f: Awaited<ReturnType<typeof createLocalLifecycle>>, agentId: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../../agentorg/src/mcp-bridge.ts")],
    env: { ...(process.env as Record<string, string>), ORG_SOCKET: f.socketPath, ORG_TOKEN: f.token(agentId) } });
  const client = new Client({ name: "local-skills-lifecycle", version: "1" });
  await client.connect(transport);
  return client;
}
async function waitMcp(client: Client, accepted: any) {
  const deadline = Date.now() + 10_000;
  let operation = accepted;
  while (!["completed", "failed", "stopped"].includes(operation.status)) {
    if (Date.now() >= deadline) throw new Error(`MCP operation ${accepted.id} timed out`);
    operation = resultText(await client.callTool({ name: "operation_wait", arguments: { operationId: operation.id, waitMs: 1_000 } }));
  }
  return operation;
}

 test("local registration is inert; public lifecycle selections clone for ACP, enforce revisions, and propagate availability", async () => {
  const f = await createLocalLifecycle();
  try {
    const root = (await f.createAgent("root")).agent;
    const before = await f.client.request<AgentRecord>("agent.get", { agentId: root.id });
    const alpha = await f.addSkill("alpha", "alpha-local-proof");
    const beta = await f.addSkill("beta", "beta-local-proof");
    expect(alpha.record).toMatchObject({ name: "alpha", source: { kind: "local", path: alpha.source }, origin: "manual" });
    expect(alpha.record.gitUrl).toBeUndefined();
    const afterAdd = await f.client.request<AgentRecord>("agent.get", { agentId: root.id });
    expect(afterAdd.revision).toBe(before.revision);
    expect(states(afterAdd.settings)).toBeUndefined();
    expect(await readdir(installRoot(root.settings.cwd!)).catch(() => [])).toEqual([]);

    const rootGrant = await f.run("agent.modify", { agentId: root.id, settings: { extensions: { skills: { alpha: "available" } } } });
    expect(rootGrant.status).toBe("completed");
    expect((rootGrant.result as AgentRecord).revision).toBe(before.revision + 1);
    expect(await readdir(installRoot(root.settings.cwd!)).catch(() => [])).toEqual([]);
    const childCwd = join(f.workspace, "child"); await mkdir(childCwd);
    const childOp = await f.run("agent.create", { parentId: root.id, name: "new-child", settings: { harness: "skill-consumer", model: "test", cwd: childCwd } });
    expect(childOp.status).toBe("completed");
    const child = childOp.result as AgentRecord;
    expect(states(child.settings)).toBeUndefined(); // New children never inherit or auto-install.
    expect(f.launches.get(child.id)).toEqual([]);

    const grant = await f.run("agent.modify", { agentId: child.id, settings: { extensions: { skills: { alpha: "available" } } } });
    expect(grant.status).toBe("completed");
    expect((grant.result as AgentRecord).revision).toBe(child.revision + 1);
    expect(states((grant.result as AgentRecord).settings)).toEqual({ alpha: "available" });
    const rootAfterGrant = await f.client.request<AgentRecord>("agent.get", { agentId: root.id });
    expect(rootAfterGrant.revision).toBe((rootGrant.result as AgentRecord).revision);
    expect(states(rootAfterGrant.settings)).toEqual({ alpha: "available" });
    expect(await readdir(installRoot(child.settings.cwd!))).toEqual([]); // available does not install.

    const rootInstall = await f.run("agent.modify", { agentId: root.id, settings: { extensions: { skills: { alpha: "installed" } } } });
    expect(rootInstall.status).toBe("completed");
    const rootInstalled = rootInstall.result as AgentRecord;
    expect(rootInstalled.revision).toBe(rootAfterGrant.revision + 1);
    expect(await Bun.file(join(installRoot(root.settings.cwd!), "alpha", "SKILL.md")).exists()).toBe(true);

    const install = await f.run("agent.modify", { agentId: child.id, expectedRevision: (grant.result as AgentRecord).revision,
      settings: { extensions: { skills: { alpha: "installed", beta: "available" } } } });
    expect(install.status).toBe("completed");
    const installed = install.result as AgentRecord;
    expect(installed.revision).toBe((grant.result as AgentRecord).revision + 1);
    const rootAfterReplacement = await f.client.request<AgentRecord>("agent.get", { agentId: root.id });
    expect(rootAfterReplacement.revision).toBe(rootInstalled.revision + 1);
    expect(states(rootAfterReplacement.settings)).toEqual({ alpha: "installed", beta: "available" });
    const childInstallRoot = installRoot(child.settings.cwd!);
    const alphaFile = join(childInstallRoot, "alpha", "SKILL.md");
    expect(await readFile(alphaFile, "utf8")).toContain("alpha-local-proof");
    expect(await readdir(childInstallRoot)).toEqual(["alpha"]);
    await expect(lstat(join(childInstallRoot, "beta"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.launches.get(child.id)).toEqual([alphaFile]);
    const prompt = await f.run("agent.prompt", { agentId: child.id, text: "read the managed skill" });
    expect(prompt.status).toBe("completed");
    expect((prompt.result as any).text).toContain("alpha-local-proof"); // ACP fixture reads the installed file from AGENTORG_SKILL_FILES.

    const omitted = await f.run("agent.modify", { agentId: child.id, name: "omitted-selection" });
    expect(states((omitted.result as AgentRecord).settings)).toEqual({ alpha: "installed", beta: "available" });
    const stale = await f.run("agent.modify", { agentId: child.id, expectedRevision: installed.revision - 1,
      settings: { extensions: { skills: {} } } });
    expect(stale.status).toBe("failed"); expect(stale.error?.code).toBe("CONFLICT");
    const unchanged = await f.client.request<AgentRecord>("agent.get", { agentId: child.id });
    expect(unchanged.revision).toBe((omitted.result as AgentRecord).revision);
    expect(states(unchanged.settings)).toEqual({ alpha: "installed", beta: "available" });
    expect(await Bun.file(alphaFile).exists()).toBe(true);

    const cleared = await f.run("agent.modify", { agentId: child.id, settings: { extensions: { skills: {} } } });
    expect(cleared.status).toBe("completed"); expect(states((cleared.result as AgentRecord).settings)).toEqual({});
    expect(await readdir(installRoot(child.settings.cwd!))).toEqual([]);
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: root.id })).settings)).toEqual({ alpha: "installed", beta: "available" });
  } finally { await f.cleanup(); }
});

test("local installations are independent, retain identity/remotes and recover work after source deletion and restart", async () => {
  const f = await createLocalLifecycle();
  try {
    const alpha = await f.addSkill("alpha", "source-proof");
    const root = (await f.createAgent("root")).agent;
    const aCwd = join(f.workspace, "agent-a"), bCwd = join(f.workspace, "agent-b"); await mkdir(aCwd); await mkdir(bCwd);
    const aOp = await f.run("agent.create", { parentId: root.id, settings: { harness: "skill-consumer", model: "test", cwd: aCwd, extensions: { skills: { alpha: "installed" } } } });
    const bOp = await f.run("agent.create", { parentId: root.id, settings: { harness: "skill-consumer", model: "test", cwd: bCwd, extensions: { skills: { alpha: "installed" } } } });
    expect(aOp.status).toBe("completed"); expect(bOp.status).toBe("completed");
    const a = aOp.result as AgentRecord, b = bOp.result as AgentRecord;
    const aDir = join(installRoot(aCwd), "alpha"), bDir = join(installRoot(bCwd), "alpha"), central = alpha.record.path;
    expect(aDir).not.toBe(bDir); expect(await git(aDir, "rev-parse", "--show-toplevel")).not.toBe(await git(bDir, "rev-parse", "--show-toplevel"));
    const markerA = JSON.parse(await readFile(join(aDir, ".git", "agentorg-skills.json"), "utf8"));
    const markerB = JSON.parse(await readFile(join(bDir, ".git", "agentorg-skills.json"), "utf8"));
    expect(markerA).toMatchObject({ agentId: a.id, skill: "alpha" }); expect(markerB).toMatchObject({ agentId: b.id, skill: "alpha" });
    expect(markerA.generation).not.toBe(markerB.generation);
    expect(await readFile(join(aDir, "identity.marker"), "utf8")).toContain("source-proof");
    await writeFile(join(aDir, "identity.marker"), "agent-a-only\n");
    expect(await readFile(join(bDir, "identity.marker"), "utf8")).toContain("source-proof");
    expect(await readFile(join(alpha.source, "identity.marker"), "utf8")).toContain("source-proof");
    expect(await readFile(join(central, "identity.marker"), "utf8")).toContain("source-proof");
    expect(await git(central, "remote")).toContain(`agent-${a.id}-`);

    await git(aDir, "config", "user.email", "fixture@example.test"); await git(aDir, "config", "user.name", "Fixture");
    await writeFile(join(aDir, "committed-work.txt"), "recover this commit\n"); await git(aDir, "add", "."); await git(aDir, "commit", "-m", "agent work");
    const commit = await git(aDir, "rev-parse", "HEAD");
    await writeFile(join(aDir, "dirty-work.txt"), "retain dirty work\n");
    expect((await f.run("agent.remove", { agentId: a.id })).status).toBe("completed");
    const deadline = Date.now() + 5_000;
    let refs = "";
    while (Date.now() < deadline) {
      refs = await git(central, "for-each-ref", "--format=%(objectname)", "refs/agentorg-recovery");
      if (refs.includes(commit)) break;
      await Bun.sleep(20);
    }
    expect(refs).toContain(commit);
    const remoteName = (await git(central, "remote")).split("\n").find(name => name.startsWith(`agent-${a.id}-`));
    expect(remoteName).toBeTruthy();
    expect(await git(central, "remote", "get-url", remoteName!)).toBe(aDir); // Recovery remote points to the retained workspace.
    expect(await readFile(join(aDir, "dirty-work.txt"), "utf8")).toContain("retain dirty work"); // Removed workspaces stay archived.
    expect(await readFile(join(bDir, "identity.marker"), "utf8")).toContain("source-proof");

    await rm(alpha.source, { recursive: true, force: true });
    await f.restart();
    const persisted = await f.client.request<any>("skills.list");
    expect(persisted.skills.find((skill: Skill) => skill.name === "alpha").path).toBe(central);
    expect(await readFile(join(central, "SKILL.md"), "utf8")).toContain("source-proof");
    const freshCwd = join(f.workspace, "after-source-delete"); await mkdir(freshCwd);
    const fresh = await f.run("agent.create", { parentId: root.id, settings: { harness: "skill-consumer", model: "test", cwd: freshCwd, extensions: { skills: { alpha: "installed" } } } });
    expect(fresh.status).toBe("completed");
    expect(await readFile(join(installRoot(freshCwd), "alpha/SKILL.md"), "utf8")).toContain("source-proof");
  } finally { await f.cleanup(); }
});

test("agent MCP token lists and delegates local skills; authorization rejects unavailable catalog entries", async () => {
  const f = await createLocalLifecycle();
  let mcp: Client | undefined;
  try {
    await f.addSkill("alpha", "alpha-mcp"); await f.addSkill("beta", "beta-mcp");
    const root = (await f.createAgent("root")).agent;
    await f.run("agent.modify", { agentId: root.id, settings: { extensions: { skills: { alpha: "available" } } } });
    mcp = await connectMcp(f, root.id);
    const listed = resultText(await mcp.callTool({ name: "skills_list", arguments: {} }));
    expect(listed.skills.find((skill: any) => skill.name === "alpha").state).toBe("available");
    expect(listed.skills.find((skill: any) => skill.name === "beta").state).toBe("unavailable");

    const childCwd = join(f.workspace, "delegated-child"); await mkdir(childCwd);
    const accepted = resultText(await mcp.callTool({ name: "child_create", arguments: { settings: { harness: "skill-consumer", model: "test", cwd: childCwd,
      extensions: { skills: { alpha: "installed" } } } } }));
    const childOp = await waitMcp(mcp, accepted);
    expect(childOp.status).toBe("completed");
    const child = childOp.result as AgentRecord;
    expect(states(child.settings)).toEqual({ alpha: "installed" });
    expect(await Bun.file(join(installRoot(childCwd), "alpha/SKILL.md")).exists()).toBe(true);

    const denied = resultText(await mcp.callTool({ name: "descendant_modify", arguments: { agentId: child.id, settings: { extensions: { skills: { beta: "available" } } } } }));
    const deniedOp = await waitMcp(mcp, denied);
    expect(deniedOp.status).toBe("failed"); expect(deniedOp.error?.code).toBe("FORBIDDEN");
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).settings)).toEqual({ alpha: "installed" });
    const omitted = resultText(await mcp.callTool({ name: "descendant_modify", arguments: { agentId: child.id, name: "still-installed" } }));
    expect((await waitMcp(mcp, omitted)).status).toBe("completed");
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).settings)).toEqual({ alpha: "installed" });

    const siblingCwd = join(f.workspace, "delegated-sibling"); await mkdir(siblingCwd);
    const siblingAccepted = resultText(await mcp.callTool({ name: "child_create", arguments: { settings: { harness: "skill-consumer", model: "test", cwd: siblingCwd } } }));
    const siblingOp = await waitMcp(mcp, siblingAccepted); const sibling = siblingOp.result as AgentRecord;
    expect(siblingOp.status).toBe("completed");
    const childMcp = await connectMcp(f, child.id);
    try {
      expect((await childMcp.callTool({ name: "descendant_modify", arguments: { agentId: root.id, name: "forbidden-ancestor" } })).isError).toBe(true);
      expect((await childMcp.callTool({ name: "descendant_modify", arguments: { agentId: sibling.id, name: "forbidden-sibling" } })).isError).toBe(true);
    } finally { await childMcp.close(); }
  } finally { await mcp?.close(); await f.cleanup(); }
});

test("unsupported harness, missing installed checkout, corrupt launch environment, and disabled plugin fail closed", async () => {
  const f = await createLocalLifecycle();
  try {
    const alpha = await f.addSkill("alpha", "failure-proof");
    const unsupportedCwd = join(f.workspace, "unsupported"); await mkdir(unsupportedCwd);
    const root = (await f.createAgent("root")).agent;
    const unsupported = await f.run("agent.create", { parentId: root.id, settings: { harness: "unsupported-skill-consumer", model: "test", cwd: unsupportedCwd, extensions: { skills: { alpha: "installed" } } } });
    expect(unsupported.status).toBe("failed"); expect(unsupported.error?.code).toBe("SKILL_NOT_READY");

    const installedCwd = join(f.workspace, "valid"); await mkdir(installedCwd);
    const installedOp = await f.run("agent.create", { parentId: root.id, settings: { harness: "skill-consumer", model: "test", cwd: installedCwd, extensions: { skills: { alpha: "installed" } } } });
    expect(installedOp.status).toBe("completed");
    const installed = installedOp.result as AgentRecord;
    const activeSkill = join(installRoot(installedCwd), "alpha", "SKILL.md");
    await f.restart(true, true);
    const corrupt = await f.run("agent.restart", { agentId: installed.id });
    expect(corrupt.status).toBe("failed"); expect(corrupt.error?.code).toBe("START_FAILED");
    await f.restart(true);
    const missingCheckout = activeSkill.slice(0, -"/SKILL.md".length);
    const retainedCheckout = join(f.workspace, "retained-after-missing-checkout");
    await rename(missingCheckout, retainedCheckout);
    const missing = await f.run("agent.restart", { agentId: installed.id });
    expect(missing.status).toBe("failed");
    await rename(retainedCheckout, missingCheckout);
    expect(await Bun.file(activeSkill).exists()).toBe(true); // Failure never destroys the agent copy.

    await f.restart(false);
    expect((await f.client.request<any>("organization.snapshot")).capabilities.plugins.skills).toBeUndefined();
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: installed.id })).settings)).toEqual({ alpha: "installed" });
    const disabled = await f.run("agent.restart", { agentId: installed.id });
    expect(disabled.status).toBe("failed"); expect(disabled.error?.message).toMatch(/Enable the skills plugin/);
    expect(await Bun.file(activeSkill).exists()).toBe(true);
  } finally { await f.cleanup(); }
});
