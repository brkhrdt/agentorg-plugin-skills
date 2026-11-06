import { fileExists, sleep } from "./helpers/runtime.ts";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import type { ServerPlugin } from "../../agentorg/src/plugin.ts";
import type { AgentRecord, Operation } from "../../agentorg/src/types.ts";
import { createSkillsPlugin, installRoot, states, type Skill } from "../src/index.ts";
import { git } from "../src/git.ts";

const waitFor = async (predicate: () => boolean, timeout = 3_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Condition timed out");
    await sleep(10);
  }
};

const roots: string[] = [];
const servers: OrganizationServer[] = [];
const clients: OrganizationClient[] = [];
const mcpClients: Client[] = [];
afterEach(async () => {
  for (const client of mcpClients.splice(0)) await client.close().catch(() => {});
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createFixture(withSkills = true) {
  const dir = await mkdtemp(join(tmpdir(), "skills-mcp-transport-"));
  roots.push(dir);
  const workspace = join(dir, "work"), source = join(dir, "source-alpha");
  await Promise.all([mkdir(join(workspace, "child"), { recursive: true }), mkdir(join(workspace, "other"), { recursive: true }), mkdir(source)]);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test");
  await writeFile(join(source, "SKILL.md"), "---\nname: alpha\ndescription: Alpha MCP fixture\n---\n# Instructions\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "skill fixture");

  const harness: ServerPlugin = { apiVersion: 1, name: "mcp-fixture", setup(host) {
    for (const name of ["create_subagent", "modify_subagent"]) host.transformTool(name, tool => {
      const properties = { ...tool.inputSchema.properties };
      const settings = properties.settings as { properties?: Record<string, any> };
      const extensions = (settings.properties?.extensions ?? { type: "object" }) as { type?: string; properties?: Record<string, unknown> };
      properties.settings = { ...settings, properties: { ...settings.properties, extensions: { ...extensions, properties: { ...extensions.properties, siblingMarker: { type: "string", enum: ["preserved"], description: "Sibling-plugin constraint" } } } } };
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    });
    host.registerHarness({ name: "fixture", launch(context) {
      return {
        command: process.execPath,
        args: [join(import.meta.dirname, "../../agentorg/tests/fixtures/agent.ts")],
        cwd: context.agent.settings.cwd ?? process.cwd(),
        env: { ...process.env, ORG_SOCKET: context.socketPath, ORG_TOKEN: context.token },
        consumesEnv: ["AGENTORG_SKILL_FILES"],
      };
    } });
  } };
  const server = await OrganizationServer.start({
    dataDir: join(dir, "data"), socketPath: join(dir, "data/server.sock"),
    plugins: [harness, ...(withSkills ? [createSkillsPlugin({ home: dir })] : [])],
  });
  servers.push(server);
  const client = await OrganizationClient.connect(server.organization.socketPath);
  clients.push(client);
  const run = async (method: string, params: unknown) => client.wait(await client.request<Operation>(method, params));
  const rootOp = await run("agent.create", {
    parentId: null, settings: { harness: "fixture", model: "test", cwd: workspace },
  });
  expect(rootOp.status).toBe("completed");
  const root = rootOp.result as AgentRecord;
  if (!withSkills) {
    const opaque = structuredClone(server.organization.agents.get(root.id)!);
    opaque.settings.extensions = { skills: { alpha: "available" } };
    server.organization.agents.set(root.id, opaque);
    server.organization.store.saveAgent(opaque);
  }
  const catalog: Skill[] = [];
  if (withSkills) {
    catalog.push(await client.request<Skill>("skills.registerRepository", { source }));
    for (const name of ["beta", "gamma"]) {
      const repo = join(dir, `source-${name}`);
      await mkdir(repo);
      await git(repo, "init", "--initial-branch=main");
      await git(repo, "config", "user.email", "test@example.com");
      await git(repo, "config", "user.name", "Test");
      await writeFile(join(repo, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} MCP fixture\n---\n# Instructions\n`);
      await git(repo, "add", "."); await git(repo, "commit", "-m", "skill fixture");
      catalog.push(await client.request<Skill>("skills.registerRepository", { source: repo }));
    }
    await run("agent.modify", { agentId: root.id, settings: { extensions: { skills: { alpha: "available", beta: "available" } } } });
  }
  const skill = catalog[0];
  const runtime = (server.organization as any).runtimes.get(root.id);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "../../agentorg/src/mcp-bridge.ts")],
    env: { ...(process.env as Record<string, string>), ORG_SOCKET: server.organization.socketPath, ORG_TOKEN: runtime.token },
  });
  const mcp = new Client({ name: "skills-transport-test", version: "1" });
  await mcp.connect(transport);
  mcpClients.push(mcp);
  return { dir, workspace, root, skill, catalog, harness, client, server, mcp, connectMcp: async (agentId: string) => {
    const runtime = (server.organization as any).runtimes.get(agentId);
    const peer = new Client({ name: "skills-transport-peer", version: "1" });
    await peer.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dirname, "../../agentorg/src/mcp-bridge.ts")],
      env: { ...(process.env as Record<string, string>), ORG_SOCKET: server.organization.socketPath, ORG_TOKEN: runtime.token },
    }));
    mcpClients.push(peer);
    return peer;
  } };
}

const resultText = (result: any) => JSON.parse(result.content.find((item: any) => item.type === "text").text);
const waitThroughMcp = async (mcp: Client, accepted: any, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let operation = accepted;
  while (!["completed", "failed", "stopped"].includes(operation.status)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`MCP operation ${accepted.id} did not finish before deadline`);
    operation = resultText(await mcp.callTool({ name: "wait_operation", arguments: { operationId: accepted.id, waitMs: Math.min(1_000, remaining) } }));
  }
  return operation;
};

test("MCP without the skills plugin preserves opaque selections and exposes no skills tools", async () => {
  const f = await createFixture(false);
  try {
    const tools = await f.mcp.listTools();
    expect(tools.tools.some(tool => tool.name === "skills_list")).toBe(false);
    expect(tools.tools.some(tool => ["skills.list", "skills.add", "skills.reconcile", "organization.settings.list", "organization.settings.get", "organization.settings.update", "organization_settings_list", "organization_settings_get", "organization_settings_update"].includes(tool.name))).toBe(false);
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: f.root.id })).settings)).toEqual({ alpha: "available" });
    await expect(f.mcp.callTool({ name: "skills_list", arguments: {} })).rejects.toThrow(/Unknown MCP tool/);
  } finally { await f.mcp.close(); }
});

test("disabling the skills plugin preserves installed selection and managed files", async () => {
  const f = await createFixture();
  try {
    const accepted = resultText(await f.mcp.callTool({ name: "create_subagent", arguments: {
      settings: { harness: "fixture", model: "test", cwd: join(f.workspace, "child"), extensions: { skills: { alpha: "installed", beta: "installed" } } },
    } }));
    const completed = await waitThroughMcp(f.mcp, accepted);
    expect(completed.status).toBe("completed");
    const child = completed.result as AgentRecord;
    const alphaFile = join(installRoot(child.settings.cwd!), "alpha", "SKILL.md");
    const betaFile = join(installRoot(child.settings.cwd!), "beta", "SKILL.md");
    expect(await fileExists(alphaFile)).toBe(true);
    expect(await fileExists(betaFile)).toBe(true);

    await f.mcp.close(); f.client.close(); await f.server.close();
    const disabled = await OrganizationServer.start({ dataDir: join(f.dir, "data"), socketPath: join(f.dir, "data/server.sock"), plugins: [f.harness] });
    servers.push(disabled);
    const client = await OrganizationClient.connect(disabled.organization.socketPath);
    clients.push(client);
    expect((await client.request<any>("organization.snapshot")).capabilities.plugins?.skills).toBeUndefined();
    const persisted = await client.request<AgentRecord>("agent.get", { agentId: child.id });
    expect(states(persisted.settings)).toEqual({ alpha: "installed", beta: "installed" });
    expect(await fileExists(alphaFile)).toBe(true);
    expect(await fileExists(betaFile)).toBe(true);
  } finally { await f.mcp.close(); }
});

test.skipIf(!process.env.ORG_COMPILED_BRIDGE)("compiled host MCP bridge lists tools and polls skills operations", async () => {
  const f = await createFixture();
  const runtime = (f.server.organization as any).runtimes.get(f.root.id);
  const compiled = new Client({ name: "compiled-skills-transport", version: "1" });
  try {
    await compiled.connect(new StdioClientTransport({ command: process.env.ORG_COMPILED_BRIDGE!, args: ["--internal-mcp-bridge"],
      env: { ...(process.env as Record<string, string>), ORG_SOCKET: f.server.organization.socketPath, ORG_TOKEN: runtime.token },
    }));
    mcpClients.push(compiled);
    expect((await compiled.listTools()).tools.map(tool => tool.name)).toContain("skills_list");
    expect(resultText(await compiled.callTool({ name: "skills_list", arguments: {} })).skills.map((item: any) => item.name)).toEqual(["alpha", "beta", "gamma"]);
    const accepted = resultText(await compiled.callTool({ name: "create_subagent", arguments: {
      settings: { harness: "fixture", model: "test", cwd: join(f.workspace, "child"), extensions: { skills: { alpha: "installed" } } },
    } }));
    const completed = await waitThroughMcp(compiled, accepted);
    expect(completed.status).toBe("completed");
    expect(states((completed.result as AgentRecord).settings)).toEqual({ alpha: "installed" });
  } finally { await compiled.close(); await f.mcp.close(); }
});

test("authenticated MCP discovers skills tools, composes transformed schemas, and enforces selection/caller rules", async () => {
  const f = await createFixture();
  try {
    const tools = await f.mcp.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain("skills_list");
    expect(tools.tools.map(tool => tool.name)).toContain("wait_operation");
    expect(tools.tools.some(tool => ["skills.list", "skills.add", "skills.reconcile", "organization.settings.list", "organization.settings.get", "organization.settings.update", "organization_settings_list", "organization_settings_get", "organization_settings_update"].includes(tool.name))).toBe(false);
    const createTool = tools.tools.find(tool => tool.name === "create_subagent") as any;
    const modifyTool = tools.tools.find(tool => tool.name === "modify_subagent") as any;
    const createSkills = createTool.inputSchema.properties.settings.properties.extensions.properties.skills;
    const modifySkills = modifyTool.inputSchema.properties.settings.properties.extensions.properties.skills;
    expect(createSkills).toMatchObject({ type: "object", additionalProperties: { type: "string", enum: ["unavailable", "available", "installed"] } });
    expect(modifySkills).toMatchObject({ type: "object", additionalProperties: { type: "string", enum: ["unavailable", "available", "installed"] } });
    expect(createSkills.description).toContain("Complete replacement");
    expect(modifySkills.description).toContain("Complete replacement");
    expect(createTool.inputSchema.properties.settings.properties.extensions.properties.siblingMarker).toEqual({ type: "string", enum: ["preserved"], description: "Sibling-plugin constraint" });
    expect(modifyTool.inputSchema.properties.settings.properties.extensions.properties.siblingMarker).toEqual({ type: "string", enum: ["preserved"], description: "Sibling-plugin constraint" });
    expect(createTool.inputSchema.required).toContain("settings");
    expect(modifyTool.inputSchema.required).toContain("agentId");
    expect(modifyTool.inputSchema.properties.expectedRevision).toMatchObject({ type: "integer" });
    expect(createTool.inputSchema.required).toContain("settings");

    const listing = await f.mcp.callTool({ name: "skills_list", arguments: {} });
    expect(resultText(listing).skills.map((item: any) => ({ name: item.name, state: item.state }))).toEqual([
      { name: "alpha", state: "available" }, { name: "beta", state: "available" }, { name: "gamma", state: "unavailable" },
    ]);

    const created = await f.mcp.callTool({ name: "create_subagent", arguments: {
      settings: { harness: "fixture", model: "test", cwd: join(f.workspace, "child"), extensions: { skills: { alpha: "installed", beta: "available" } } },
    } });
    expect(created.isError).not.toBe(true);
    const operation = resultText(created);
    const completed = await waitThroughMcp(f.mcp, operation);
    expect(completed.status).toBe("completed");
    const child = completed.result as AgentRecord;
    expect(states(child.settings)).toEqual({ alpha: "installed", beta: "available" });
    expect(await fileExists(join(installRoot(child.settings.cwd!), "alpha/SKILL.md"))).toBe(true);

    const omitted = await f.mcp.callTool({ name: "modify_subagent", arguments: { agentId: child.id, name: "retains-selection" } });
    expect(omitted.isError).not.toBe(true);
    const omittedOperation = resultText(omitted);
    expect((await waitThroughMcp(f.mcp, omittedOperation)).status).toBe("completed");
    const retained = await f.client.request<AgentRecord>("agent.get", { agentId: child.id });
    expect(states(retained.settings)).toEqual({ alpha: "installed", beta: "available" });

    const stale = await f.mcp.callTool({ name: "modify_subagent", arguments: {
      agentId: child.id, expectedRevision: retained.revision - 1, settings: { extensions: { skills: {} } },
    } });
    expect(stale.isError).not.toBe(true);
    const staleResult = await waitThroughMcp(f.mcp, resultText(stale));
    expect(staleResult.status).toBe("failed");
    expect(staleResult.error?.code).toBe("CONFLICT");
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).settings)).toEqual({ alpha: "installed", beta: "available" });
    expect(await fileExists(join(installRoot(child.settings.cwd!), "alpha/SKILL.md"))).toBe(true);

    const replacement = await f.mcp.callTool({ name: "modify_subagent", arguments: {
      agentId: child.id, expectedRevision: retained.revision, settings: { extensions: { skills: { beta: "available" } } },
    } });
    expect(replacement.isError).not.toBe(true);
    expect((await waitThroughMcp(f.mcp, resultText(replacement))).status).toBe("completed");
    let current = await f.client.request<AgentRecord>("agent.get", { agentId: child.id });
    expect(states(current.settings)).toEqual({ beta: "available" });
    expect(await fileExists(join(installRoot(child.settings.cwd!), "alpha/SKILL.md"))).toBe(true);

    const denied = await f.mcp.callTool({ name: "modify_subagent", arguments: {
      agentId: child.id, expectedRevision: current.revision, settings: { extensions: { skills: { gamma: "available" } } },
    } });
    expect(denied.isError).not.toBe(true);
    const deniedResult = await waitThroughMcp(f.mcp, resultText(denied));
    expect(deniedResult.status).toBe("failed");
    expect(deniedResult.error?.code).toBe("FORBIDDEN");
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).settings)).toEqual({ beta: "available" });

    const unknown = await f.mcp.callTool({ name: "modify_subagent", arguments: {
      agentId: child.id, expectedRevision: current.revision, settings: { extensions: { skills: { "not-in-catalog": "available" } } },
    } });
    const unknownResult = await waitThroughMcp(f.mcp, resultText(unknown));
    expect(unknownResult.status).toBe("failed");
    expect(unknownResult.error?.code).toBe("INVALID_PARAMS");

    const installBeta = await f.mcp.callTool({ name: "modify_subagent", arguments: {
      agentId: child.id, expectedRevision: current.revision, settings: { extensions: { skills: { beta: "installed" } } },
    } });
    expect(installBeta.isError).not.toBe(true);
    expect((await waitThroughMcp(f.mcp, resultText(installBeta))).status).toBe("completed");
    current = await f.client.request<AgentRecord>("agent.get", { agentId: child.id });
    const betaManagedFile = join(installRoot(child.settings.cwd!), "beta", "SKILL.md");
    expect(states(current.settings)).toEqual({ beta: "installed" });
    expect(await fileExists(betaManagedFile)).toBe(true);

    const cleared = await f.mcp.callTool({ name: "modify_subagent", arguments: {
      agentId: child.id, expectedRevision: current.revision, settings: { extensions: { skills: {} } },
    } });
    expect(cleared.isError).not.toBe(true);
    expect((await waitThroughMcp(f.mcp, resultText(cleared))).status).toBe("completed");
    current = await f.client.request<AgentRecord>("agent.get", { agentId: child.id });
    expect(states(current.settings)).toEqual({});
    expect(await fileExists(betaManagedFile)).toBe(true);

    const siblingOp = await f.mcp.callTool({ name: "create_subagent", arguments: {
      settings: { harness: "fixture", model: "test", cwd: join(f.workspace, "other") },
    } });
    const sibling = await waitThroughMcp(f.mcp, resultText(siblingOp));
    expect(sibling.status).toBe("completed");
    expect(states(sibling.result.settings)).toBeUndefined(); // Children do not inherit caller selections.
    const childMcp = await f.connectMcp(child.id);
    const siblingTarget = await childMcp.callTool({ name: "modify_subagent", arguments: { agentId: sibling.result.id, name: "forbidden-sibling-target" } });
    expect(siblingTarget.isError).toBe(true);
    const ancestorTarget = await childMcp.callTool({ name: "modify_subagent", arguments: { agentId: f.root.id, name: "forbidden-ancestor-target" } });
    expect(ancestorTarget.isError).toBe(true);

    const self = await f.mcp.callTool({ name: "modify_subagent", arguments: { agentId: f.root.id, name: "forbidden-self-target" } });
    expect(self.isError).toBe(true);

    const invalidTransport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "../../agentorg/src/mcp-bridge.ts")],
      env: { ...(process.env as Record<string, string>), ORG_SOCKET: f.server.organization.socketPath, ORG_TOKEN: "forged-token" },
    });
    const invalidClient = new Client({ name: "invalid-capability-test", version: "1" });
    await invalidClient.connect(invalidTransport);
    try { await expect(invalidClient.callTool({ name: "skills_list", arguments: {} })).rejects.toThrow(); }
    finally { await invalidClient.close(); }

    const missingToken = new Client({ name: "missing-capability-test", version: "1" });
    await expect(missingToken.connect(new StdioClientTransport({
      command: process.execPath, args: [join(import.meta.dirname, "../../agentorg/src/mcp-bridge.ts")],
      env: { ...(process.env as Record<string, string>), ORG_SOCKET: f.server.organization.socketPath, ORG_TOKEN: undefined as any },
    }))).rejects.toThrow(/ORG_TOKEN|closed|exited/i);

    const oldToken = (f.server.organization as any).runtimes.get(f.root.id).token;
    await f.client.request<Operation>("agent.restart", { agentId: f.root.id });
    await waitFor(() => { try { f.server.organization.callerForToken(oldToken); return false; } catch { return true; } });
    await expect(f.mcp.callTool({ name: "skills_list", arguments: {} })).rejects.toThrow();
  } finally { await f.mcp.close(); }
});
