import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OrganizationClient } from "../../../agentorg/src/client.ts";
import type { Operation } from "../../../agentorg/src/types.ts";
import { createSkillHarnessPlugin } from "../fixtures/skill-harness.ts";

const coreRoot = resolve(import.meta.dir, "../../../agentorg");
const pluginRoot = resolve(import.meta.dir, "../..");
const bunExecutable = process.execPath;

export type E2EMode = "source" | "bundled";
export interface Proof { event: string; agentId: string; token?: string; files?: string[]; paths?: string[]; content?: string; requested?: string }

async function bundle(entrypoint: string, output: string) {
  const result = await Bun.build({ entrypoints: [entrypoint], target: "bun", minify: false });
  if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
  await Bun.write(output, result.outputs[0]!);
}

export async function createLocalE2E(mode: E2EMode) {
  if (mode === "bundled" && !process.env.ORG_BINARY) throw new Error("Bundled local e2e requires ORG_BINARY pointing to the feature-copy AgentOrg binary");
  const root = await mkdtemp(join(tmpdir(), `skills-local-e2e-${mode}-`));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let client: OrganizationClient | undefined;
  let stderr = "";
  async function stop() {
    client?.close(); client = undefined;
    if (!child) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(4_000).then(() => false)]);
    if (!exited) { child.kill("SIGKILL"); await child.exited; }
    child = undefined;
  }
  try {
    const runtime = join(root, "runtime"), dataDir = join(runtime, "data"), socketPath = join(dataDir, "server.sock");
    const home = join(runtime, "home"), workspace = join(runtime, "work"), proofPath = join(runtime, "proof.jsonl");
    await mkdir(runtime, { recursive: true });
    await Promise.all([mkdir(dataDir), mkdir(home), mkdir(workspace), writeFile(proofPath, "")]);
    const consumerPath = join(runtime, "skill-consumer.js");
    await bundle(join(pluginRoot, "tests/fixtures/skill-consumer.ts"), consumerPath);
    let harnessPath = join(pluginRoot, "tests/fixtures/skill-harness.ts");
    let skillsPath = join(pluginRoot, "src/index.ts");
    let binaryPath: string | undefined;
    if (mode === "bundled") {
      const compiled = process.env.ORG_BINARY!;
      binaryPath = join(runtime, "agentorg");
      await copyFile(resolve(compiled), binaryPath);
      await chmod(binaryPath, 0o700);
      harnessPath = join(runtime, "skill-harness.js");
      skillsPath = join(runtime, "skills.js");
      await bundle(join(pluginRoot, "tests/fixtures/skill-harness.ts"), harnessPath);
      await bundle(join(pluginRoot, "src/index.ts"), skillsPath);
    }
    const env = { ...process.env, HOME: home, SKILLS_E2E_BUN: bunExecutable, SKILLS_E2E_CONSUMER: consumerPath, SKILLS_E2E_PROOF: proofPath };
    const command = mode === "source" ? bunExecutable : binaryPath!;
    const args = mode === "source"
      ? [join(coreRoot, "src/cli.ts"), "--data-dir", dataDir, "--plugin", harnessPath, "--plugin", skillsPath]
      : ["--data-dir", dataDir, "--plugin", harnessPath, "--plugin", skillsPath];
    async function start() {
      stderr = "";
      child = Bun.spawn([command, ...args], { cwd: runtime, env, stdout: "ignore", stderr: "pipe" });
      const stderrStream = child.stderr;
      if (stderrStream && typeof stderrStream !== "number") void (async () => {
        const reader = stderrStream.getReader();
        const decoder = new TextDecoder();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; stderr += decoder.decode(value, { stream: true }); } }
        catch { /* Host shutdown closes stderr. */ }
      })();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !client) {
        if (child.exitCode !== null) throw new Error(`AgentOrg ${mode} host exited (${child.exitCode}): ${stderr}`);
        try { client = await OrganizationClient.connect(socketPath); }
        catch { await Bun.sleep(25); }
      }
      if (!client) throw new Error(`Timed out connecting to AgentOrg ${mode} host: ${stderr}`);
      while (Date.now() < deadline) {
        try { await client.request("organization.snapshot"); return; }
        catch (error: any) { if (error.code !== "NOT_READY") throw error; await Bun.sleep(25); }
      }
      throw new Error(`AgentOrg ${mode} host did not become ready: ${stderr}`);
    }
    await start();
    async function run(method: string, params: unknown) { return client!.wait(await client!.request<Operation>(method, params)); }
    async function addSkill(name: string, marker: string) {
      const source = join(root, `source-${name}`); await mkdir(source);
      await writeFile(join(source, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} local e2e fixture\n---\n\nRead and return exact proof: ${marker}\n`);
      await writeFile(join(source, "identity.marker"), `${marker}\n`);
      return { source, record: await client!.request<any>("skills.addFromPath", { path: source }) };
    }
    async function proofs(): Promise<Proof[]> {
      return (await readFile(proofPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    }
    async function restart() { await stop(); await start(); }
    return { mode, root, runtime, dataDir, socketPath, home, workspace, proofPath, consumerPath, run, addSkill, proofs,
      get client() { return client!; }, get process() { return child!; }, restart,
      cleanup: async () => { await stop(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
