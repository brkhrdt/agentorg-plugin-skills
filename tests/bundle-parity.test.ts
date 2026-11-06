import { write, bundlePlugin } from "./helpers/runtime.ts";
import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import type { ServerPlugin } from "../../agentorg/src/plugin.ts";
import { createSkillsPlugin } from "../src/index.ts";

const harness: ServerPlugin = { apiVersion: 1, name: "fixture", setup(host) {
  host.registerHarness({ name: "fixture", launch(context) {
    return { consumesEnv: ["AGENTORG_SKILL_FILES"], command: process.execPath,
      args: [join(import.meta.dirname, "../../agentorg/tests/fixtures/agent.ts")] };
  } });
} };

async function observe(plugin: ServerPlugin, dir: string) {
  const dataDir = join(dir, "data");
  const server = await OrganizationServer.start({ dataDir, socketPath: join(dataDir, "server.sock"), plugins: [harness, plugin] });
  const client = await OrganizationClient.connect(join(dataDir, "server.sock"));
  try {
    const snapshot = await client.request<any>("organization.snapshot");
    const settings = await client.request<any>("organization.settings.list");
    const caller = { kind: "agent", id: "parity-fixture" } as const;
    const mcp = await server.organization.request("mcp.list", {}, caller) as { tools: any[] };
    return {
      capability: snapshot.capabilities.plugins.skills,
      settingsCapability: snapshot.capabilities.serverSettings,
      settings: settings.groups.find((group: any) => group.namespace === "skills"),
      skillTools: mcp.tools.filter(tool => ["skills_list", "create_subagent", "modify_subagent"].includes(tool.name)),
    };
  } finally { client.close(); await server.close(); }
}

test("source and bundled plugin expose identical settings, capability and MCP contracts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-bundle-parity-"));
  try {
    const sourceDir = join(dir, "source"), bundleDir = join(dir, "bundle");
    await mkdir(sourceDir); await mkdir(bundleDir);
    const builtBundle = await bundlePlugin(resolve(import.meta.dirname, "../src/index.ts"));
    expect(builtBundle.success).toBe(true);
    const bundlePath = join(dir, "skills.js");
    await write(bundlePath, builtBundle.outputs[0]!);
    const bundled = await import(pathToFileURL(bundlePath).href) as { createSkillsPlugin(options: { home: string }): ServerPlugin };
    const source = await observe(createSkillsPlugin({ home: sourceDir }), join(dir, "source-host"));
    const compiled = await observe(bundled.createSkillsPlugin({ home: bundleDir }), join(dir, "bundle-host"));
    expect(compiled).toEqual(source);
    expect(source.capability).toMatchObject({
      settingsNamespace: "skills", serverSettingsNamespace: "skills",
      repositoryRegistration: { version: 2, sourceKinds: ["https", "server-path"], semantics: "committed-head-v2" },
      endpoints: { list: "skills.list", registerRepository: "skills.registerRepository" }, version: 1,
    });
    expect(source.settings).toMatchObject({
      namespace: "skills", version: 2,
      defaults: { directory: "skills", gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
      fields: [
        { key: "directory", effect: "restart", editor: "text" },
        { key: "gitTimeoutMs", effect: "immediate", min: 1_000, max: 60_000 },
        { key: "maxCatalogEntries", effect: "immediate", min: 1, max: 256 },
      ],
    });
    expect(source.skillTools.map(tool => tool.name).sort()).toEqual(["create_subagent", "modify_subagent", "skills_list"]);
    const childCreate = source.skillTools.find(tool => tool.name === "create_subagent");
    expect(childCreate.inputSchema.properties.settings.properties.extensions.properties.skills).toBeDefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
