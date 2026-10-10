import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the actual installed Pi CLI without a prompt, credentials or model/network calls.
test.skipIf(!Bun.which("pi"))("Pi --no-skills retains explicit files and excludes ambient skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-pi-"));
  await mkdir(join(dir, ".agents/skills/ambient"), { recursive: true });
  const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\nInstructions\n`;
  await writeFile(join(dir, ".agents/skills/ambient/SKILL.md"), skill("ambient"));
  await writeFile(join(dir, "SKILL.md"), skill("explicit"));
  await mkdir(join(dir, "pi-home"));
  const child = spawn("pi", ["--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--skill", join(dir, "SKILL.md"), "--model", "openai/gpt-4.1", "--api-key", "unused-test-key"], {
    cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "pi-home"), PI_OFFLINE: "1" }, stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  try {
    const response: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi startup timeout: ${stderr}`)), 20_000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
      lines.on("line", line => {
        const value = JSON.parse(line);
        if (value.id === "skills") { clearTimeout(timer); resolve(value); }
      });
      child.stdin.write(JSON.stringify({ id: "skills", type: "get_commands" }) + "\n");
    });
    expect(response.success).toBe(true);
    expect(response.data.commands.filter((c: any) => c.name.startsWith("skill:")).map((c: any) => c.name)).toEqual(["skill:explicit"]);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 25_000);
