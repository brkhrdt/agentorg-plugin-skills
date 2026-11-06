import { sleep, write, spawn, bundlePlugin } from "./helpers/runtime.ts";
import { expect, test } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import type { AgentRecord, Operation } from "../../agentorg/src/types.ts";
import { createPiPlugin } from "../../agentorg-plugin-pi-agent/src/index.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { git } from "../src/git.ts";

for (const mode of ["source", "compiled"] as const) test.skipIf(mode === "compiled" && !process.env.ORG_BINARY)(`${mode} host composes skills lifecycle and Pi explicit launch environment`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-pi-host-"));
  const dataDir = join(dir, "data"), cwd = join(dir, "work"), repo = join(dir, "repo");
  let server: OrganizationServer | undefined, child: ReturnType<typeof spawn> | undefined, client: OrganizationClient | undefined;
  try {
    await mkdir(cwd); await mkdir(repo);
    await git(repo, "init", "--initial-branch=main"); await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "SKILL.md"), "---\nname: alpha\ndescription: Explicit fixture\n---\nInstructions\n");
    await git(repo, "add", "."); await git(repo, "commit", "-m", "fixture");
    await mkdir(join(cwd, ".agents/skills/ambient"), { recursive: true });
    await writeFile(join(cwd, ".agents/skills/ambient/SKILL.md"), "ambient must not load");
    const socket = join(dataDir, "server.sock");
    if (mode === "source") {
      server = await OrganizationServer.start({ dataDir, socketPath: socket, plugins: [createSkillsPlugin({ home: dir }), createPiPlugin()] });
    } else {
      // Relocate the host, both plugins and native adapter; no source/module resolution at runtime.
      const binary = join(dir, "agentorg"); await copyFile(resolve(process.env.ORG_BINARY!), binary); await chmod(binary, 0o755);
      const pi = join(dir, "pi"); await mkdir(pi);
      await copyFile(join(import.meta.dirname, "../../agentorg-plugin-pi-agent/dist/index.js"), join(pi, "index.js"));
      await copyFile(join(import.meta.dirname, "../../agentorg-plugin-pi-agent/dist/pi-acp"), join(pi, "pi-acp")); await chmod(join(pi, "pi-acp"), 0o755);
      const builtBundle = await bundlePlugin(join(import.meta.dirname, "../src/index.ts")); expect(builtBundle.success).toBe(true);
      await write(join(dir, "skills.js"), builtBundle.outputs[0]!);
      await writeFile(join(dir, "load.js"), `import {createSkillsPlugin} from './skills.js';export default createSkillsPlugin({home:${JSON.stringify(dir)}});`);
      child = spawn([binary, "--data-dir", dataDir, "--plugin", join(pi, "index.js"), "--plugin", join(dir, "load.js")], { cwd: dir, stderr: "pipe", stdout: "ignore" });
    }
    for (let n = 0; n < 200 && !client; n++) { try { client = await OrganizationClient.connect(socket); } catch { await sleep(20); } }
    if (!client) throw new Error("Host failed to start");
    for (let n = 0; n < 200; n++) { try { await client.request("organization.snapshot"); break; } catch (error: any) { if (error.code !== "NOT_READY") throw error; await sleep(20); } }
    await client.request("skills.registerRepository", { source: repo });
    const fakePi = join(import.meta.dirname, "../../agentorg-plugin-pi-agent/tests/fixtures/fake-pi.ts");
    const created = await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "pi", model: "test-model", provider: "test-provider", cwd, options: { executable: fakePi }, extensions: { skills: { alpha: "installed" } } } }));
    expect(created.status, created.error?.message).toBe("completed");
    const agent = created.result as AgentRecord;
    const launch = JSON.parse(await readFile(join(dataDir, "sessions", agent.id, "1/launch.json"), "utf8"));
    expect(launch.args).toContain("--no-skills");
    expect(launch.args.filter((arg: string, i: number) => launch.args[i - 1] === "--skill")).toEqual([join(cwd, ".agents/skills/alpha/SKILL.md")]);
    expect(launch.args.join(" ")).not.toContain("ambient");
  } finally {
    client?.close(); await server?.close();
    if (child) { child.kill("SIGTERM"); await child.exited; }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
