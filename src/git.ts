import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** No shell interpolation, interactive auth, redirects, submodules or ambient Git cwd. */
async function runGit(cwd: string, timeoutMs: number, isolate: boolean, ...args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_NOSYSTEM: "1" };
  const ambient = isolate
    ? /^GIT_(DIR|WORK_TREE|COMMON_DIR|NAMESPACE|PREFIX|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|SHALLOW_FILE|TEMPLATE_DIR|AUTHOR_.*|COMMITTER_.*|CONFIG|CONFIG_SYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/
    : /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/;
  for (const key of Object.keys(env)) if (ambient.test(key) || (isolate && key === "EMAIL")) delete (env as any)[key];
  // Disable ambient URL rewrites/helpers. Operators may provide a noninteractive GIT_ASKPASS.
  const safeEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...(isolate ? { GIT_ATTR_NOSYSTEM: "1" } : {}) };
  try {
    const result = await exec("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "-c", "http.followRedirects=false", "-C", cwd, ...args], {
      env: safeEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: isolate ? 128 * 1024 * 1024 : 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (cause.killed || cause.signal === "SIGKILL" || cause.code === "ETIMEDOUT")
      throw new Error(`Git ${args[0]} timed out after ${timeoutMs}ms`);
    throw new Error(`Git ${args[0]} failed: ${(error as Error).message}`);
  }
}

export function gitWithTimeout(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  return runGit(cwd, timeoutMs, false, ...args);
}
function safeSnapshotGit(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  return runGit(cwd, timeoutMs, true, ...args);
}

const snapshotConfig = [
  "core.autocrlf=false", "core.safecrlf=false", "core.filemode=true", "core.symlinks=true",
  "core.attributesFile=/dev/null", "core.excludesFile=/dev/null", "core.hooksPath=/dev/null",
  "commit.gpgsign=false", "tag.gpgsign=false", "user.name=AgentOrg Skills Snapshot", "user.email=skills@agentorg.invalid",
] as const;
async function snapshotGit(path: string, timeoutMs: number, ...args: string[]) {
  const config = snapshotConfig.flatMap(value => ["-c", value]);
  return safeSnapshotGit(path, timeoutMs, ...config, ...args);
}

/** Initialize a local-only, one-commit repository without source remotes/history or executing repository content. */
export async function cloneLocalSnapshot(source: string, destination: string, timeoutMs = 60_000): Promise<void> {
  await safeSnapshotGit(source, timeoutMs, "clone", "--no-checkout", "--no-hardlinks", "--template=", "--", source, destination);
  await configureSnapshotWorktree(destination, timeoutMs, false);
  await snapshotGit(destination, timeoutMs, "checkout", "--force", "HEAD");
  await snapshotGit(destination, timeoutMs, "config", "--local", "--unset", "core.hooksPath");
  if (await snapshotGit(destination, timeoutMs, "status", "--porcelain", "--untracked-files=all") !== "")
    throw new Error("Cloned local snapshot worktree differs from its index");
}

async function configureSnapshotWorktree(path: string, timeoutMs: number, includeSnapshotIdentity: boolean) {
  const info = join(path, ".git", "info");
  await mkdir(info, { recursive: true, mode: 0o700 });
  await chmod(info, 0o700);
  await writeFile(join(info, "attributes"), "* -text -filter -ident -working-tree-encoding\n", { mode: 0o600, flag: "wx" });
  for (const value of snapshotConfig) {
    if (!includeSnapshotIdentity && value.startsWith("user.")) continue;
    const separator = value.indexOf("=");
    await snapshotGit(path, timeoutMs, "config", "--local", value.slice(0, separator), value.slice(separator + 1));
  }
}

export async function initializeLocalSnapshot(path: string, timeoutMs = 60_000): Promise<void> {
  await snapshotGit(path, timeoutMs, "init", "--quiet", "--template=", "--initial-branch=main");
  await configureSnapshotWorktree(path, timeoutMs, true);
  const info = join(path, ".git", "info");
  await snapshotGit(path, timeoutMs, "add", "--force", "--all", "--", ".");
  await snapshotGit(path, timeoutMs, "commit", "--quiet", "--no-gpg-sign", "-m", "Import local skill snapshot");

  const top = await snapshotGit(path, timeoutMs, "rev-parse", "--show-toplevel");
  if (top !== await realpath(path)) throw new Error("Local snapshot Git root mismatch");
  const parents = await snapshotGit(path, timeoutMs, "rev-list", "--parents", "-n", "1", "HEAD");
  if (parents.trim().split(/\s+/).length !== 1) throw new Error("Local snapshot unexpectedly has parent history");
  if (await snapshotGit(path, timeoutMs, "remote") !== "") throw new Error("Local snapshot unexpectedly has Git remotes");
  if (await snapshotGit(path, timeoutMs, "status", "--porcelain", "--untracked-files=all") !== "") throw new Error("Local snapshot worktree differs from its index");
  const stage = await readFile(join(path, ".git", "index"));
  if (stage.byteLength === 0) throw new Error("Local snapshot Git index is empty");
  // Reject symlinks/gitlinks even if a hostile or malformed index somehow contains one.
  const modes = await snapshotGit(path, timeoutMs, "ls-files", "--stage");
  if (/^(?!100644 |100755 )\d{6} /m.test(modes)) throw new Error("Local snapshot contains a non-regular Git entry");
  const infoStat = await lstat(info);
  if (!infoStat.isDirectory() || infoStat.isSymbolicLink()) throw new Error("Local snapshot Git metadata is invalid");
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWithTimeout(cwd, 60_000, ...args);
}
