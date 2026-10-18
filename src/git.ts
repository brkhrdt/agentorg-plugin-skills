import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** No shell interpolation, interactive auth, redirects, submodules or ambient Git cwd. */
export async function gitWithTimeout(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/.test(key)) delete (env as any)[key];
  }
  // Disable ambient URL rewrites/helpers. Operators may provide a noninteractive GIT_ASKPASS.
  const safeEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  try {
    const result = await exec("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "-c", "http.followRedirects=false", "-C", cwd, ...args], {
      env: safeEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (cause.killed || cause.signal === "SIGKILL" || cause.code === "ETIMEDOUT")
      throw new Error(`Git ${args[0]} timed out after ${timeoutMs}ms`);
    throw new Error(`Git ${args[0]} failed: ${(error as Error).message}`);
  }
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWithTimeout(cwd, 60_000, ...args);
}
