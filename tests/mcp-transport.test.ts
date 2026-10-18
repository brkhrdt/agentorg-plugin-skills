import { afterEach, expect, test } from "bun:test";
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

const roots: string[] = [];
const servers: OrganizationServer[] = [];
const clients: OrganizationClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createFixture(withSkills = true) {
  const dir = await mkdtemp(join(tmpdir(), "skills-mcp-transport-"));
  roots.push(dir);
  const workspace = join(dir, "work"), source = join(dir, "source-alpha");
  await Promise.all([mkdir(join(workspace, "child"), { recursive: true }), mkdir(source)]);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test");
  await writeFile(join(source, "SKILL.md"), "---\nname: alpha\ndescription: Alpha MCP fixture\n---\n# Instructions\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "skill fixture");

  const harness: ServerPlugin = { apiVersion: 1, name: "mcp-fixture", setup(host) {
    host.transformTool("child_create", tool => {
      const properties = { ...tool.inputSchema.properties };
      const settings = properties.settings as { properties?: Record<string, any> };
      const extensions = (settings.properties?.extensions ?? { type: "object" }) as { type?: string; properties?: Record<string, unknown> };
      properties.settings = { ...settings, properties: { ...settings.properties, extensions: { ...extensions, properties: { ...extensions.properties, siblingMarker: { type: "string" } } } } };
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    });
    host.registerHarness({ name: "fixture", launch(context) {
      return {
        command: process.execPath,
        args: [join(import.meta.dir, "../../agentorg/tests/fixtures/agent.ts")],
        cwd: context.agent.settings.cwd ?? process.cwd(),
        env: { ...process.env, ORG_SOCKET: context.socketPath, ORG_TOKEN: context.token },
        consumesEnv: ["AGENTORG_SKILL_FILES"],
      };
    } });
  } };
  const server = await OrganizationServer.start({
    dataDir: join(dir, "data"), socketPath: join(dir, "data/server.sock"),
    plugins: [harness, ...(withSkills ? [createSkillsPlugin({ home: dir, allowLocalSources: true })] : [])],
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
  const skill = withSkills ? await client.request<Skill>("skills.add", { name: "alpha", gitUrl: source }) : undefined;
  if (withSkills) await run("agent.modify", { agentId: root.id, settings: { extensions: { skills: { alpha: "available" } } } });
  const runtime = (server.organization as any).runtimes.get(root.id);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../../agentorg/src/mcp-bridge.ts")],
    env: { ...(process.env as Record<string, string>), ORG_SOCKET: server.organization.socketPath, ORG_TOKEN: runtime.token },
  });
  const mcp = new Client({ name: "skills-transport-test", version: "1" });
  await mcp.connect(transport);
  return { dir, workspace, root, skill, client, server, mcp };
}

const resultText = (result: any) => JSON.parse(result.content.find((item: any) => item.type === "text").text);

test("MCP without the skills plugin preserves opaque selections and exposes no skills tools", async () => {
  const f = await createFixture(false);
  try {
    const tools = await f.mcp.listTools();
    expect(tools.tools.some(tool => tool.name === "skills_list")).toBe(false);
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: f.root.id })).settings)).toEqual({ alpha: "available" });
    await expect(f.mcp.callTool({ name: "skills_list", arguments: {} })).rejects.toThrow(/Unknown MCP tool/);
  } finally { await f.mcp.close(); }
});

test("authenticated MCP discovers skills tools, composes transformed schemas, and enforces selection/caller rules", async () => {
  const f = await createFixture();
  try {
    const tools = await f.mcp.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain("skills_list");
    const createTool = tools.tools.find(tool => tool.name === "child_create") as any;
    const modifyTool = tools.tools.find(tool => tool.name === "descendant_modify") as any;
    expect(createTool.inputSchema.properties.settings.properties.extensions.properties.skills).toBeDefined();
    expect(modifyTool.inputSchema.properties.settings.properties.extensions.properties.skills).toBeDefined();
    expect(createTool.inputSchema.properties.settings.properties.extensions.properties.siblingMarker).toBeDefined();
    expect(createTool.inputSchema.required).toContain("settings");

    const listing = await f.mcp.callTool({ name: "skills_list", arguments: {} });
    expect(resultText(listing).skills.map((item: any) => ({ name: item.name, state: item.state }))).toEqual([
      { name: "alpha", state: "available" },
    ]);

    const created = await f.mcp.callTool({ name: "child_create", arguments: {
      settings: { harness: "fixture", model: "test", cwd: join(f.workspace, "child"), extensions: { skills: { alpha: "installed" } } },
    } });
    expect(created.isError).not.toBe(true);
    const operation = resultText(created);
    const completed = await f.client.wait(operation);
    expect(completed.status).toBe("completed");
    const child = completed.result as AgentRecord;
    expect(states(child.settings)).toEqual({ alpha: "installed" });
    expect(await Bun.file(join(installRoot(child.settings.cwd!), "alpha/SKILL.md")).exists()).toBe(true);

    const omitted = await f.mcp.callTool({ name: "descendant_modify", arguments: { agentId: child.id, name: "retains-selection" } });
    expect(omitted.isError).not.toBe(true);
    await f.client.wait(resultText(omitted));
    expect(states((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).settings)).toEqual({ alpha: "installed" });

    const denied = await f.mcp.callTool({ name: "descendant_modify", arguments: {
      agentId: child.id, settings: { extensions: { skills: { unavailable: "available" } } },
    } });
    expect(denied.isError).not.toBe(true);
    expect((await f.client.wait(resultText(denied))).status).toBe("failed");

    const self = await f.mcp.callTool({ name: "descendant_modify", arguments: { agentId: f.root.id, name: "forbidden-self-target" } });
    expect(self.isError).toBe(true);

    const invalidTransport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "../../agentorg/src/mcp-bridge.ts")],
      env: { ...(process.env as Record<string, string>), ORG_SOCKET: f.server.organization.socketPath, ORG_TOKEN: "forged-token" },
    });
    const invalidClient = new Client({ name: "invalid-capability-test", version: "1" });
    await invalidClient.connect(invalidTransport);
    try { await expect(invalidClient.listTools()).rejects.toThrow(); }
    finally { await invalidClient.close(); }
  } finally { await f.mcp.close(); }
});
