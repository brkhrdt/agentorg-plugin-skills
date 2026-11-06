import { spawnSync, commandExists } from "./helpers/runtime.ts";
import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import type { AgentRecord, Operation } from "../../agentorg/src/types.ts";
import type { ServerPlugin } from "../../agentorg/src/plugin.ts";
import { createPiPlugin } from "../../agentorg-plugin-pi-agent/src/index.ts";
import { createSkillsPlugin } from "../src/index.ts";

// Real Pi, offline/dummy credentials, extension command only: no model calls.
test.skipIf(!commandExists("pi"))("a selected managed skill reaches Pi explicitly while organization MCP tools remain available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-pi-e2e-"));
  let server: OrganizationServer | undefined;
  let client: OrganizationClient | undefined;
  try {
    await mkdir(join(dir, "pi-home")); await mkdir(join(dir, "skills-home"));
    const repository = join(dir, "skill-repository"); await mkdir(repository);
    const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\nInstructions\n`;
    await writeFile(join(repository, "SKILL.md"), skill("explicit"));
    const git = (args: string[]) => {
      const result = spawnSync({ cmd: ["git", ...args], cwd: repository, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    };
    git(["init", "--initial-branch=main"]); git(["config", "user.email", "test@example.com"]); git(["config", "user.name", "Test"]);
    git(["add", "."]); git(["commit", "-m", "explicit skill fixture"]);
    await mkdir(join(dir, ".agents/skills/ambient"), { recursive: true });
    await writeFile(join(dir, ".agents/skills/ambient/SKILL.md"), skill("ambient"));

    const proof = join(dir, "proof.json");
    const probe: ServerPlugin = { apiVersion: 1, name: "probe", setup(host) {
      host.beforeLaunch(async spec => {
        const wrapper = join(dir, "probe-extension.ts");
        await writeFile(wrapper, `import org from ${JSON.stringify(spec.env!.ORG_PI_EXTENSION)};
import {writeFileSync} from 'node:fs';
export default function(pi){org(pi);pi.registerCommand('agentorg-probe',{description:'No-model test probe',handler:async()=>{
for(let i=0;i<200&&!pi.getAllTools().some(t=>t.name==='mcp__agentorg__create_subagent');i++)await new Promise(r=>setTimeout(r,10));
writeFileSync(${JSON.stringify(proof)},JSON.stringify({tools:pi.getAllTools().map(t=>t.name),commands:pi.getCommands().map(c=>c.name),servers:pi.getMcpServers(),argv:process.argv}));
}});}`);
        return { ...spec, env: { ...spec.env, ORG_PI_EXTENSION: wrapper } };
      });
    } };
    server = await OrganizationServer.start({
      dataDir: join(dir, "data"), socketPath: join(dir, "server.sock"),
      plugins: [createPiPlugin(), createSkillsPlugin({ home: join(dir, "skills-home") }), probe],
      limits: { startTimeoutMs: 20_000 },
    });
    client = await OrganizationClient.connect(join(dir, "server.sock"));
    await client.request("skills.registerRepository", { source: repository });
    const created = await client.wait(await client.request<Operation>("agent.create", { settings: {
      harness: "pi", model: "gpt-4.1", provider: "openai", cwd: dir,
      extensions: { skills: { explicit: "installed" } },
      env: { PI_CODING_AGENT_DIR: join(dir, "pi-home"), PI_OFFLINE: "1", OPENAI_API_KEY: "unused-test-key" },
    } }), 25_000);
    expect(created.status, created.error?.message).toBe("completed");
    const result = await client.wait(await client.request<Operation>("agent.prompt", {
      agentId: (created.result as AgentRecord).id, text: "/agentorg-probe",
    }), 10_000);
    expect(result.status, result.error?.message).toBe("completed");
    const output = JSON.parse(await readFile(proof, "utf8"));
    expect(output.tools).toContain("mcp__agentorg__create_subagent");
    expect(output.tools).toContain("mcp__agentorg__skills_list");
    expect(output.servers.some((entry: any) => entry.name === "agentorg")).toBe(true);
    expect(output.commands.filter((name: string) => name.startsWith("skill:"))).toEqual(["skill:explicit"]);
    expect(output.argv).toContain("--no-skills");
    expect(output.argv.filter((arg: string, index: number) => output.argv[index - 1] === "--skill"))
      .toEqual([join(dir, ".agents/skills/explicit/SKILL.md")]);
  } finally { client?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
}, 35_000);
