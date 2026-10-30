import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../../agentorg/src/server.ts";
import { OrganizationClient } from "../../../agentorg/src/client.ts";
import type { AgentRecord, Operation } from "../../../agentorg/src/types.ts";
import type { ServerPlugin } from "../../../agentorg/src/plugin.ts";
import { createSkillsPlugin, type Skill } from "../../src/index.ts";
import { git } from "../../src/git.ts";

export async function createLocalLifecycle(options: { disabled?: boolean; corruptSkillEnv?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "skills-local-lifecycle-"));
  const dataDir = join(dir, "data"), socketPath = join(dataDir, "server.sock"), home = join(dir, "home"), workspace = join(dir, "work");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const launches = new Map<string, string[]>();
  const harness: ServerPlugin = { apiVersion: 1, name: "local-lifecycle-harness", setup(host) {
    host.registerHarness({ name: "skill-consumer", listModels: () => [{ provider: "fixture", id: "test" }], launch(context) {
      const files = JSON.parse(context.env.AGENTORG_SKILL_FILES ?? "[]");
      launches.set(context.agent.id, files);
      return { command: process.execPath, args: [join(import.meta.dir, "../fixtures/skill-consumer.ts")], cwd: context.agent.settings.cwd ?? process.cwd(),
        env: { ...context.env }, consumesEnv: ["AGENTORG_SKILL_FILES"] };
    } });
    host.registerHarness({ name: "unsupported-skill-consumer", listModels: () => [{ provider: "fixture", id: "test" }], launch() {
      return { command: process.execPath, args: [join(import.meta.dir, "../fixtures/skill-consumer.ts")] };
    } });
  } };
  const corrupt: ServerPlugin = { apiVersion: 1, name: "corrupt-skill-env", setup(host) {
    host.prepareLaunch(context => { context.env.AGENTORG_SKILL_FILES = "[]"; });
  } };
  const plugins = (enabled: boolean, corruptEnv = false) => [harness, ...(enabled ? [createSkillsPlugin({ home }), ...(corruptEnv ? [corrupt] : [])] : [])];
  let server = await OrganizationServer.start({ dataDir, socketPath, plugins: plugins(!options.disabled, !!options.corruptSkillEnv),
    limits: { startTimeoutMs: 10_000, stopTimeoutMs: 2_000, killTimeoutMs: 50 } });
  let client = await OrganizationClient.connect(socketPath);
  const run = async (method: string, params: unknown) => client.wait(await client.request<Operation>(method, params));
  async function addSkill(name = "local-alpha", marker = "local-source-marker") {
    const source = join(dir, `source-${name}`);
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} local lifecycle fixture\n---\n\nRead and report marker: ${marker}\n`);
    await writeFile(join(source, "identity.marker"), marker + "\n");
    await git(source, "init", "--initial-branch=main"); await git(source, "config", "user.name", "Local Fixture"); await git(source, "config", "user.email", "fixture@example.invalid");
    await git(source, "add", "."); await git(source, "commit", "-m", "local skill fixture");
    const record = await client.request<Skill>("skills.registerRepository", { source });
    return { source, marker, record };
  }
  async function createAgent(name: string, skills?: Record<string, "unavailable" | "available" | "installed">, harnessName = "skill-consumer") {
    const cwd = join(workspace, name);
    await mkdir(cwd, { recursive: true });
    const op = await run("agent.create", { parentId: null, name, settings: { harness: harnessName, model: "test", cwd,
      ...(skills === undefined ? {} : { extensions: { skills } }) } });
    return { operation: op, agent: op.result as AgentRecord, cwd };
  }
  function token(agentId: string) { return (server.organization as any).runtimes.get(agentId).token as string; }
  async function restart(enabled = true, corruptEnv = false) {
    client.close(); await server.close();
    server = await OrganizationServer.start({ dataDir, socketPath, plugins: plugins(enabled, corruptEnv),
      limits: { startTimeoutMs: 10_000, stopTimeoutMs: 2_000, killTimeoutMs: 50 } });
    client = await OrganizationClient.connect(socketPath);
  }
  return { dir, dataDir, socketPath, home, workspace, launches, harness, run, addSkill, createAgent, token,
    get server() { return server; }, get client() { return client; }, restart,
    cleanup: async () => { client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); } };
}
