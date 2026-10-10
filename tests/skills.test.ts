import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { cwdPlugin } from "../../agentorg/src/plugins/cwd.ts";
import type { ServerPlugin } from "../../agentorg/src/plugin.ts";
import type { AgentRecord, Operation } from "../../agentorg/src/types.ts";
import { createSkillsPlugin, installRoot, type Skill } from "../src/index.ts";
import { git } from "../src/git.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(order = false) {
  const dir = await mkdtemp(join(tmpdir(), "org-skills-"));
  const workspace = join(dir, "work");
  await mkdir(join(workspace, "child", "leaf"), { recursive: true });
  await mkdir(join(workspace, "other"));
  const paths = new Map<string, string[]>();
  const harness: ServerPlugin = { apiVersion: 1, name: "fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch(ctx) {
      paths.set(ctx.agent.id, ctx.skillPaths ?? []);
      return { command: process.execPath, args: [join(import.meta.dir, "../../agentorg/tests/fixtures/agent.ts")] };
    } });
  } };
  const plugin = () => createSkillsPlugin({ home: dir, allowLocalSources: true });
  const plugins = () => [harness, ...(order ? [plugin(), cwdPlugin] : [cwdPlugin, plugin()])];
  const options = { dataDir: join(dir, "data"), socketPath: join(dir, "data/server.sock"), plugins: plugins(), limits: { stopTimeoutMs: 2000, killTimeoutMs: 50 } };
  let server = await OrganizationServer.start(options);
  let client = await OrganizationClient.connect(server.organization.socketPath);
  cleanup.push(async () => { client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const run = async (method: string, params: unknown, caller?: any) => {
    const accepted = caller ? await server.organization.request(method, params, caller) as Operation : await client.request<Operation>(method, params);
    return client.wait(accepted);
  };
  const create = (parentId: string | null, cwd: string, skills?: Record<string, string>, caller?: any) => run("agent.create", { parentId, settings: { harness: "fixture", model: "test", cwd, ...(skills === undefined ? {} : { skills }) } }, caller);
  const root = (await create(null, workspace)).result as AgentRecord;
  async function add(name = "alpha", invalid = false) {
    const repo = join(dir, "source-" + name);
    await mkdir(repo);
    await git(repo, "init", "--initial-branch=main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "SKILL.md"), invalid ? "invalid" : `---\nname: ${name}\ndescription: ${name} fixture\n---\n# Instructions\n`);
    await git(repo, "add", "."); await git(repo, "commit", "-m", "skill");
    return client.request<Skill>("skills.add", { name, gitUrl: repo });
  }
  return { dir, workspace, root, paths, create, run, add,
    get client() { return client; }, get server() { return server; },
    async restart(enabled = true) {
      client.close(); await server.close();
      server = await OrganizationServer.start({ ...options, plugins: enabled ? plugins() : [harness, cwdPlugin] });
      client = await OrganizationClient.connect(server.organization.socketPath);
    },
  };
}

test("catalog validation, duplicate/source policy, durable catalog and scoped capability", async () => {
  const f = await fixture();
  const skill = await f.add();
  expect(skill.description).toBe("alpha fixture");
  expect((await f.client.request<any>("organization.snapshot")).capabilities.skills).toBe(true);
  await expect(f.client.request("skills.add", { name: "alpha", gitUrl: skill.gitUrl })).rejects.toThrow("already registered");
  for (const [name, gitUrl] of [["../escape", skill.gitUrl], ["bad", "https://localhost/x/y"], ["bad", "ssh://github.com/x/y"], ["bad", "https://github.com/x/y?branch=main"], ["bad", "https://u:p@github.com/x/y"]])
    await expect(f.client.request("skills.add", { name, gitUrl })).rejects.toThrow();
  await expect(f.add("broken", true)).rejects.toThrow("frontmatter");
  await f.restart();
  expect((await f.client.request<any>("skills.list")).skills.map((s: Skill) => s.name)).toEqual(["alpha"]);
  await expect(f.server.organization.request("skills.list", {}, { kind: "agent", id: f.root.id })).rejects.toThrow("client-only");
});

test("public grants, complete replacement, omission, persisted installed states and explicit launch paths", async () => {
  const f = await fixture(); await f.add(); await f.add("beta");
  const child = (await f.create(f.root.id, "child")).result as AgentRecord;
  const leaf = (await f.create(child.id, "leaf", { alpha: "installed", beta: "available" })).result as AgentRecord;
  expect(f.paths.get(leaf.id)).toEqual([join(installRoot(leaf.settings.cwd!), "alpha/SKILL.md")]);
  for (const id of [f.root.id, child.id]) {
    expect((await f.client.request<AgentRecord>("agent.get", { agentId: id })).settings.skills).toEqual({ alpha: "available", beta: "available" });
  }
  expect(await readFile(join(installRoot(leaf.settings.cwd!), "alpha/SKILL.md"), "utf8")).toContain("Instructions");
  const omitted = await f.run("agent.modify", { agentId: leaf.id, name: "renamed" });
  expect((omitted.result as AgentRecord).settings.skills).toEqual({ alpha: "installed", beta: "available" });
  await f.restart();
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: leaf.id })).settings.skills?.alpha).toBe("installed");
  const empty = await f.run("agent.modify", { agentId: leaf.id, settings: { skills: {} } });
  expect(empty.status).toBe("completed");
  expect(await readdir(installRoot(leaf.settings.cwd!))).toEqual([]);
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: f.root.id })).settings.skills?.alpha).toBe("available");
});

test("MCP delegation is checked inside queue, transforms compose in either plugin order, omitted selections aren't regrants", async () => {
  const f = await fixture(true); await f.add(); await f.add("beta"); await f.add("constructor");
  await f.run("agent.modify", { agentId: f.root.id, settings: { skills: { alpha: "available" } } });
  const caller = { kind: "agent", id: f.root.id } as const;
  const tools = await f.server.organization.request("mcp.list", {}, caller) as any;
  expect(tools.tools.find((t: any) => t.name === "child_create").inputSchema.properties.settings.properties.skills).toBeDefined();
  expect(tools.tools.find((t: any) => t.name === "child_create").inputSchema.required).toContain("cwd");
  const mcp = await f.server.organization.request("mcp.call", { name: "child_create", arguments: { cwd: "child", settings: { harness: "fixture", model: "test", skills: { alpha: "installed" } } } }, caller) as any;
  const op = await f.client.wait(JSON.parse(mcp.content[0].text));
  expect(op.status).toBe("completed"); const child = op.result as AgentRecord;
  const denied = await f.run("agent.modify", { agentId: child.id, settings: { skills: { beta: "available" } } }, caller);
  expect(denied.error?.code).toBe("FORBIDDEN");
  expect((await f.run("agent.modify", { agentId: child.id, settings: { skills: { constructor: "available" } } }, caller)).error?.code).toBe("FORBIDDEN");
  await f.run("agent.modify", { agentId: child.id, settings: { skills: { alpha: "installed", constructor: "available" } } });
  expect(Object.entries((await f.client.request<AgentRecord>("agent.get", { agentId: f.root.id })).settings.skills ?? {})).toContainEqual(["constructor", "available"]);
  await f.run("agent.modify", { agentId: f.root.id, settings: { skills: {} } });
  expect((await f.run("agent.modify", { agentId: child.id, name: "unchanged-skills" }, caller)).status).toBe("completed");
  expect((await f.run("agent.modify", { agentId: child.id, settings: { skills: { alpha: "installed" } } }, caller)).error?.code).toBe("FORBIDDEN");
  const list = await f.server.organization.request("mcp.call", { name: "skills_list", arguments: {} }, caller) as any;
  expect(JSON.parse(list.content[0].text).skills[0].state).toBe("unavailable");
});

test("canonical cwd uniqueness includes stopped agents, symlink aliases, launches and unknown selection validation", async () => {
  const f = await fixture(); await f.add();
  const child = (await f.create(f.root.id, "child")).result as AgentRecord;
  await f.run("agent.stop", { agentId: child.id });
  await symlink(join(f.workspace, "child"), join(f.workspace, "alias"));
  expect((await f.create(f.root.id, "alias")).error?.code).toBe("CWD_CONFLICT");
  expect((await f.run("agent.modify", { agentId: child.id, settings: { skills: { missing: "unavailable" } } })).error?.code).toBe("INVALID_PARAMS");
  const other = (await f.create(f.root.id, "other")).result as AgentRecord;
  expect((await f.run("agent.modify", { agentId: other.id, settings: { cwd: "alias" } })).error?.code).toBe("CWD_CONFLICT");
});

test("dirty checkout preservation, committed recovery refs, cwd change and every reinstall generation", async () => {
  const f = await fixture(); const s = await f.add();
  const child = (await f.create(f.root.id, "child", { alpha: "installed" })).result as AgentRecord;
  const checkout = join(installRoot(child.settings.cwd!), "alpha");
  await git(checkout, "config", "user.email", "test@example.com"); await git(checkout, "config", "user.name", "Test");
  await writeFile(join(checkout, "committed"), "work"); await git(checkout, "add", "."); await git(checkout, "commit", "-m", "agent work");
  const commit = await git(checkout, "rev-parse", "HEAD");
  await writeFile(join(checkout, "dirty"), "untracked preserved");
  await writeFile(join(checkout, "SKILL.md"), "dirty tracked instructions");
  const moved = await f.run("agent.modify", { agentId: child.id, settings: { cwd: "other" } });
  expect(moved.status).toBe("completed");
  expect(await git(s.path, "for-each-ref", "--format=%(objectname)", "refs/agentorg-recovery")).toContain(commit);
  const recovery = join(child.settings.cwd!, ".agents/agentorg-recovery");
  const scope = (await readdir(recovery))[0]!;
  const generations = await readdir(join(recovery, scope));
  const retained = await Promise.all(generations.map(async g => readFile(join(recovery, scope, g, "dirty"), "utf8").catch(() => "")));
  expect(retained).toContain("untracked preserved");
  const tracked = await Promise.all(generations.map(g => readFile(join(recovery, scope, g, "SKILL.md"), "utf8").catch(() => "")));
  expect(tracked).toContain("dirty tracked instructions");
  const newCwd = (moved.result as AgentRecord).settings.cwd!;
  await f.run("agent.modify", { agentId: child.id, settings: { skills: {} } });
  await f.run("agent.modify", { agentId: child.id, settings: { skills: { alpha: "installed" } } });
  expect((await git(s.path, "remote")).split("\n").filter(r => r.startsWith("agent-")).length).toBe(3);
  await f.run("agent.remove", { agentId: child.id });
  await f.restart(); // drains asynchronous removal recovery and retries after restart
  expect(await readFile(join(installRoot(newCwd), "alpha/SKILL.md"), "utf8")).toContain("Instructions");
});

test("collision and staged failure compensate without changing settings or ancestor grants", async () => {
  const f = await fixture(); await f.add();
  const child = (await f.create(f.root.id, "child")).result as AgentRecord;
  await mkdir(join(installRoot(child.settings.cwd!), "alpha"));
  await writeFile(join(installRoot(child.settings.cwd!), "alpha/keep"), "unrelated");
  const op = await f.run("agent.modify", { agentId: child.id, settings: { skills: { alpha: "installed" } } });
  expect(op.error?.code).toBe("COLLISION");
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).revision).toBe(child.revision);
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: f.root.id })).settings.skills).toBeUndefined();
  expect(await readFile(join(installRoot(child.settings.cwd!), "alpha/keep"), "utf8")).toBe("unrelated");
});

test("post-staging collision compensates, retains staged clone and preserves records", async () => {
  const f = await fixture(); await f.add();
  const child = (await f.create(f.root.id, "child")).result as AgentRecord;
  const destination = join(installRoot(child.settings.cwd!), "alpha");
  let sabotaged = false;
  f.server.organization.onEvent(event => {
    if (!sabotaged && event.agentId === child.id && event.type === "agent.state" && (event.data as any).state === "stopped") {
      sabotaged = true; mkdirSync(destination); writeFileSync(join(destination, "keep"), "collision");
    }
  });
  const op = await f.run("agent.modify", { agentId: child.id, settings: { skills: { alpha: "installed" } } });
  expect(op.status).toBe("failed");
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).revision).toBe(child.revision);
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: f.root.id })).settings.skills).toBeUndefined();
  expect(await readFile(join(destination, "keep"), "utf8")).toBe("collision");
  const recovery = join(child.settings.cwd!, ".agents/agentorg-recovery");
  const scopes = await readdir(recovery);
  expect(await readdir(join(recovery, scopes[0]!))).not.toHaveLength(0);
});

test("removal fetch failures are durable and retried without deleting the original", async () => {
  const f = await fixture(); const s = await f.add();
  const child = (await f.create(f.root.id, "child", { alpha: "installed" })).result as AgentRecord;
  const saved = s.path + "-saved";
  await rename(s.path, saved);
  await f.run("agent.remove", { agentId: child.id });
  let pending: any[] = [];
  for (let n = 0; n < 100 && !pending.length; n++) {
    pending = (await f.client.request<any>("skills.list")).recovery;
    if (!pending.length) await new Promise(r => setTimeout(r, 10));
  }
  expect(pending[0]?.agentId).toBe(child.id);
  expect(await readFile(join(installRoot(child.settings.cwd!), "alpha/SKILL.md"), "utf8")).toContain("Instructions");
  // Ensure the observer's failed fetch has settled before restoring central checkout.
  await f.server.close();
  await rename(saved, s.path);
  await f.restart();
  expect((await f.client.request<any>("skills.list")).recovery).toHaveLength(0);
  expect(await git(s.path, "for-each-ref", "refs/agentorg-recovery")).not.toBe("");
});

test("disabled plugin preserves selections and rejects launches, damaged repositories stay visible", async () => {
  const f = await fixture(); await f.add();
  const child = (await f.create(f.root.id, "child", { alpha: "installed" })).result as AgentRecord;
  await f.restart(false);
  expect((await f.client.request<any>("organization.snapshot")).capabilities.skills).toBe(false);
  expect((await f.run("agent.restart", { agentId: child.id })).error?.message).toContain("Enable the skills plugin");
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).settings.skills?.alpha).toBe("installed");
  await rename(join(installRoot(child.settings.cwd!), "alpha"), join(child.settings.cwd!, "saved"));
  await f.restart();
  expect((await f.run("agent.restart", { agentId: child.id })).status).toBe("failed");
  expect(await readFile(join(child.settings.cwd!, "saved/SKILL.md"), "utf8")).toContain("Instructions");
});

test("durable interrupted move journal is compensated at startup without losing dirty files", async () => {
  const f = await fixture(); const s = await f.add();
  const child = (await f.create(f.root.id, "child", { alpha: "installed" })).result as AgentRecord;
  await f.run("agent.stop", { agentId: child.id });
  const path = join(installRoot(child.settings.cwd!), "alpha");
  await writeFile(join(path, "dirty"), "preserve me");
  // Inject an interrupted pre-commit move using the plugin's own DB, never core DB.
  const db = new Database(join(s.path, "../skills.sqlite"));
  const row = db.query("SELECT data FROM installations").get() as any;
  const i = JSON.parse(row.data);
  const to = join(child.settings.cwd!, ".agents/agentorg-recovery/interrupted");
  db.query("INSERT INTO journal VALUES (?,?)").run("interrupted", JSON.stringify({ id: "interrupted", agentId: child.id, revision: child.revision + 1, actions: [{ generation: i.generation, from: path, to, old: true }] }));
  await rename(path, to);
  db.close();
  await f.restart();
  expect(await readFile(join(path, "dirty"), "utf8")).toBe("preserve me");
  expect((await f.run("agent.restart", { agentId: child.id })).status).toBe("completed");
});
