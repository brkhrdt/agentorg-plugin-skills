import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** No shell interpolation, interactive auth, redirects, submodules or ambient Git cwd. */
function gitEnvironment(isolate: boolean) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_NOSYSTEM: "1" };
  const ambient = isolate
    ? /^GIT_(DIR|WORK_TREE|COMMON_DIR|NAMESPACE|PREFIX|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|SHALLOW_FILE|TEMPLATE_DIR|AUTHOR_.*|COMMITTER_.*|CONFIG|CONFIG_SYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/
    : /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/;
  for (const key of Object.keys(env)) if (ambient.test(key) || (isolate && key === "EMAIL")) delete (env as any)[key];
  // Disable ambient URL rewrites/helpers. Operators may provide a noninteractive GIT_ASKPASS.
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...(isolate ? { GIT_ATTR_NOSYSTEM: "1" } : {}) };
}
async function runGit(cwd: string, timeoutMs: number, isolate: boolean, ...args: string[]): Promise<string> {
  const safeEnv = gitEnvironment(isolate);
  try {
    const result = await exec("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "-c", "http.followRedirects=false", "-C", cwd, ...args], {
      env: safeEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: isolate ? 4 * 1024 * 1024 : 1024 * 1024,
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

/** Validate index modes incrementally; raw -z paths avoid Git's potentially huge C-style quoting. */
async function validateSnapshotIndex(path: string, timeoutMs: number): Promise<number> {
  const config = snapshotConfig.flatMap(value => ["-c", value]);
  const args = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always",
    "-c", "http.followRedirects=false", "-C", path, ...config, "ls-files", "--stage", "-z"];
  const child = spawn("git", args, { env: gitEnvironment(true), stdio: ["ignore", "pipe", "pipe"] });
  return await new Promise<number>((resolve, reject) => {
    let header = Buffer.alloc(0), inHeader = true, pathBytes = 0, entries = 0, stderrBytes = 0, stderr = "", failure: Error | undefined;
    const timeout = setTimeout(() => abort(new Error(`Git index validation timed out after ${timeoutMs}ms`)), timeoutMs);
    const abort = (error: Error) => { if (!failure) { failure = error; child.kill("SIGKILL"); } };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      for (const byte of chunk) {
        if (inHeader) {
          if (byte === 9) {
            const prefix = header.toString("ascii");
            if (!/^100(?:644|755) [0-9a-f]+ 0$/.test(prefix)) { abort(new Error("Local snapshot index contains a non-regular Git entry")); break; }
            header = Buffer.alloc(0); inHeader = false; pathBytes = 0;
          } else {
            if (header.byteLength >= 128) { abort(new Error("Malformed Git index record")); break; }
            header = Buffer.concat([header, Buffer.from([byte])]);
          }
        } else if (byte === 0) {
          if (++entries > 20_000) { abort(new Error("Local snapshot index exceeds 20,000 entries")); break; }
          inHeader = true; header = Buffer.alloc(0); pathBytes = 0;
        } else if (++pathBytes > 4096) { abort(new Error("Local snapshot index path exceeds OS path bounds")); break; }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1024) abort(new Error("Git index validation diagnostics exceeded 64 KiB"));
      else stderr += chunk.toString("utf8");
    });
    child.once("error", error => abort(error));
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Git index validation failed (${signal ?? code}): ${stderr.trim()}`));
      else if (!inHeader || header.byteLength !== 0 || entries === 0) reject(new Error("Malformed or empty local snapshot index"));
      else resolve(entries);
    });
  });
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
  await validateSnapshotIndex(path, timeoutMs);
  const infoStat = await lstat(info);
  if (!infoStat.isDirectory() || infoStat.isSymbolicLink()) throw new Error("Local snapshot Git metadata is invalid");
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWithTimeout(cwd, 60_000, ...args);
}
