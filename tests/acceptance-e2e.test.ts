import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import type { AgentRecord } from "../../agentorg/src/types.ts";
import type { ServerPlugin } from "../../agentorg/src/plugin.ts";
import { terminalClient } from "../../agentorg-tui/tests/terminal.ts";
import { createSkillsPlugin, installRoot } from "../src/index.ts";
import { git } from "../src/git.ts";

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 8_000) => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= until) throw new Error("Timed out waiting for end-to-end state");
    await Bun.sleep(20);
  }
};

test("TUI installs a registered Git skill, calls authenticated MCP, and leaves user work on deselection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-acceptance-e2e-"));
  const dataDir = join(dir, "data"), socketPath = join(dataDir, "server.sock");
  const home = join(dir, "home"), work = join(dir, "work"), repo = join(dir, "source");
  const launchLog = join(dir, "launches.jsonl");
  await mkdir(home); await mkdir(work); await mkdir(repo);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "SKILL.md"), "---\nname: alpha\ndescription: Alpha local acceptance fixture\n---\nUse the managed skill.\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "local acceptance skill");

  const harness: ServerPlugin = { apiVersion: 1, name: "fixture", setup(host) {
    host.registerHarness({ name: "fixture", listModels: () => [{ provider: "fixture", id: "test" }], launch(context) {
      appendFileSync(launchLog, `${JSON.stringify({ files: JSON.parse(context.env.AGENTORG_SKILL_FILES ?? "[]"), token: context.token })}\n`);
      return { command: process.execPath, args: [join(import.meta.dir, "../../agentorg/tests/fixtures/agent.ts")], consumesEnv: ["AGENTORG_SKILL_FILES"] };
    } });
  } };
  const plugins = () => [harness, createSkillsPlugin({ home })];
  let server: OrganizationServer | undefined;
  let admin: OrganizationClient | undefined;
  let ui: ReturnType<typeof terminalClient> | undefined;
  let mcp: Client | undefined;
  try {
    server = await OrganizationServer.start({ dataDir, socketPath, plugins: plugins() });
    const serverPid = process.pid;
    admin = await OrganizationClient.connect(socketPath);
    const registered = await admin.request<any>("skills.registerRepository", { source: repo });
    expect(registered).toMatchObject({ name: "alpha", description: "Alpha local acceptance fixture" });
    expect(registered).not.toHaveProperty("history");
    const catalog = await admin.request<any>("skills.list");
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]).toMatchObject({ name: "alpha", source: { kind: "local", path: repo } });
    const persisted = await admin.request<any>("organization.settings.get", { namespace: "skills" });
    expect(persisted.values.directory).toBe("skills");
    expect(persisted.restartRequired).toEqual([]);
    let snapshot: any;
    await waitFor(async () => {
      try { snapshot = await admin!.request("organization.snapshot"); return true; }
      catch (error: any) { if (error.code === "NOT_READY") return false; throw error; }
    });
    ui = terminalClient(socketPath, dir);
    await ui.visible("No active agents. Press n");
    await Bun.sleep(250); // Let the asynchronous snapshot capability/catalog discovery finish.
    ui.keys("n"); await ui.visible("Create agent · root");
    ui.keys("\r"); await ui.visible("Edit name"); ui.keys("\x15acceptance-worker\r"); await ui.visible("Create agent · root");
    ui.keys("\x1b[B\r"); await ui.visible("Select Agent"); await ui.visible("fixture"); ui.keys("\r"); await ui.visible("Create agent · root");
    ui.keys("\x1b[B\r"); await ui.visible("Select provider"); await ui.visible("fixture"); ui.keys("\r"); await ui.visible("Create agent · root");
    ui.keys("\x1b[B\r"); await ui.visible("Select model · fixture"); await ui.visible("test"); ui.keys("\r"); await ui.visible("Create agent · root");
    ui.keys("\x1b[B\r"); await ui.visible("Edit cwd"); ui.keys(`\x15${work}`); await ui.visible(work); ui.keys(" "); await ui.visible("Create agent · root");
    ui.keys("\x1b[B".repeat(5)); await ui.visible("Skills:"); ui.keys("\r"); await ui.visible("Alpha local acceptance fixture");
    ui.keys("i"); await ui.visible("installed"); ui.keys("S"); await ui.visible("Create agent · root");
    ui.keys("S");
    await waitFor(() => {
      const screen = ui!.screen();
      return screen.includes("LATEST TRACKED EVENT") && screen.includes("acceptance-worker") && screen.includes("↑↓ select") && !screen.includes("Save changes");
    });
    await waitFor(async () => {
      snapshot = await admin!.request("organization.snapshot");
      return snapshot.agents.some((agent: AgentRecord) => agent.name === "acceptance-worker");
    });
    const agent = snapshot.agents.find((item: AgentRecord) => item.name === "acceptance-worker") as AgentRecord;
    expect(agent.settings.extensions?.skills).toEqual({ alpha: "installed" });
    const activeSkill = join(installRoot(work), "alpha", "SKILL.md");
    expect(await readFile(activeSkill, "utf8")).toContain("Alpha local acceptance fixture");
    await waitFor(() => Bun.file(launchLog).exists());
    const launchRecords = () => readFile(launchLog, "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line)));
    const initialLaunch = (await launchRecords()).at(-1)!;
    expect(initialLaunch.files).toEqual([activeSkill]);
    expect(initialLaunch.token).toBeTruthy();

    // Call through the real stdio MCP bridge with the live, agent-scoped token.
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dir, "../../agentorg/src/mcp-bridge.ts")],
      env: { ...(process.env as Record<string, string>), ORG_SOCKET: socketPath, ORG_TOKEN: initialLaunch.token },
    });
    mcp = new Client({ name: "skills-acceptance", version: "1" }); await mcp.connect(transport);
    expect((await mcp.listTools()).tools.some(tool => tool.name === "skills_list")).toBe(true);
    const response = await mcp.callTool({ name: "skills_list", arguments: {} });
    expect(response.isError).not.toBe(true);
    const listing = JSON.parse(((response.content as Array<{ text: string }>)[0]!).text);
    expect(listing.skills).toContainEqual(expect.objectContaining({ name: "alpha", state: "installed" }));
    await mcp.close(); mcp = undefined;

    // Add user work to the managed checkout; removing the selection unloads it
    // but deliberately leaves the mutable clone in place.
    const userWork = join(installRoot(work), "alpha", "user-work.txt");
    await writeFile(userWork, "keep this local work\n");
    ui.keys("e");
    const editForm = () => {
      const screen = ui!.screen();
      return screen.includes("revision 1") && screen.includes("Save changes") && screen.includes("acceptance-worker") && screen.includes("Skills");
    };
    await waitFor(editForm);
    // The form title changes with its selected row; use the ordinary-form
    // fields/save row above, then navigate from the known first field to Skills.
    ui.keys("\x1b[B".repeat(9)); await ui.visible("1 selected");
    ui.keys("\r"); await ui.visible("Alpha local acceptance fixture");
    ui.keys("d"); ui.keys("S"); await ui.visible("None selected"); ui.keys("S");
    await waitFor(async () => {
      const current = await admin!.request<AgentRecord>("agent.get", { agentId: agent.id });
      return Object.keys(current.settings.extensions?.skills ?? {}).length === 0 && current.revision > agent.revision;
    });
    expect(ui.screen()).toContain("acceptance-worker");
    await waitFor(async () => (await launchRecords()).at(-1)?.files.length === 0);
    expect(await Bun.file(activeSkill).exists()).toBe(true);
    expect(await readFile(userWork, "utf8")).toBe("keep this local work\n");
    const after = await admin.request<any>("skills.list");
    expect(after.skills).toHaveLength(1);
    expect(after.skills[0]).not.toHaveProperty("history");
    expect(await git(join(installRoot(work), "alpha"), "remote")).toBe("");
  } finally {
    if (mcp) await mcp.close().catch(() => {});
    if (ui) await ui.close().catch(() => {});
    admin?.close(); await server?.close(); await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
