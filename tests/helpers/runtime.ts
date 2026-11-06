import { access, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess } from "node:child_process";
import { build } from "esbuild";

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function captureStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
export async function fileExists(path: string) { try { await access(path); return true; } catch { return false; } }
export const fileText = (path: string) => fsReadFile(path, "utf8");
export const write = fsWriteFile;
export function spawn(command: string[], options: { cwd?: string; stdout?: "ignore" | "pipe"; stderr?: "ignore" | "pipe" }) {
  const child: any = nodeSpawn(command[0]!, command.slice(1), { cwd: options.cwd, stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"] });
  const exited = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => resolve(code ?? (signal ? 1 : 0))); });
  return Object.assign(child, { exited });
}
export function spawnSync(options: { cmd: string[]; cwd?: string; stdout?: string; stderr?: string }): any {
  const result = nodeSpawnSync(options.cmd[0]!, options.cmd.slice(1), { cwd: options.cwd, encoding: options.stdout === "pipe" ? "buffer" : undefined });
  return { ...result, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
export async function bundlePlugin(entrypoint: string) {
  const result = await build({ entryPoints: [entrypoint], bundle: true, platform: "node", format: "esm", write: false });
  return { success: true, outputs: result.outputFiles.map(file => file.contents) };
}
export const commandExists = (name: string) => {
  const result = nodeSpawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
  return result.status === 0;
};
