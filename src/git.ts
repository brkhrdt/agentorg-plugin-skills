import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readlink, writeFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** No shell interpolation, interactive auth, redirects, submodules or ambient Git cwd. */
function gitEnvironment(isolate: boolean) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_NOSYSTEM: "1" };
  const ambient = isolate
    ? /^GIT_/
    : /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/;
  for (const key of Object.keys(env)) if ((ambient.test(key) && !(isolate && ["GIT_ASKPASS", "GIT_TERMINAL_PROMPT"].includes(key))) || (isolate && key === "EMAIL")) delete (env as any)[key];
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
export const git = (cwd: string, ...args: string[]) => gitWithTimeout(cwd, 60_000, ...args);
/** Run read-only validation with ambient Git variables/config removed (for untrusted source worktrees). */
export function safeSourceGitWithTimeout(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  return runGit(cwd, timeoutMs, true, ...args);
}
function safeSnapshotGit(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  return runGit(cwd, timeoutMs, true, ...args);
}

const snapshotConfig = [
  "core.autocrlf=false", "core.safecrlf=false", "core.filemode=true", "core.symlinks=true",
  "core.attributesFile=/dev/null", "core.excludesFile=/dev/null", "core.hooksPath=/dev/null",
  "commit.gpgsign=false", "tag.gpgsign=false",
] as const;
async function snapshotGit(path: string, timeoutMs: number, ...args: string[]) {
  const config = snapshotConfig.flatMap(value => ["-c", value]);
  return safeSnapshotGit(path, timeoutMs, ...config, ...args);
}

async function validateConfinedSymlink(root: string, relativePath: string): Promise<void> {
  const components = relativePath.split("/");
  if (!relativePath || relativePath.startsWith("/") || components.some(part => !part || part === "." || part === ".."))
    throw new Error("Git index contains an unsafe symlink path");
  const linkPath = resolve(root, ...components), lexical = relative(root, linkPath);
  if (!lexical || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error("Git index symlink path escapes its checkout");
  const info = await lstat(linkPath);
  if (!info.isSymbolicLink()) throw new Error("Git symlink changed during checkout validation");
  const target = await readlink(linkPath);
  if (isAbsolute(target)) throw new Error("Absolute Git symlink targets are not portable and are rejected");
  const resolved = await realpath(linkPath);
  const targetRelative = relative(root, resolved);
  if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative))
    throw new Error("Git symlink target escapes its managed checkout");
}

/** Validate index modes incrementally; raw -z paths avoid Git's potentially huge C-style quoting. */
async function validateSnapshotIndex(path: string, timeoutMs: number): Promise<number> {
  const config = snapshotConfig.flatMap(value => ["-c", value]);
  const args = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always",
    "-c", "http.followRedirects=false", "-C", path, ...config, "ls-files", "--stage", "-z"];
  const child = spawn("git", args, { env: gitEnvironment(true), stdio: ["ignore", "pipe", "pipe"] });
  return await new Promise<number>((resolve, reject) => {
    let header = Buffer.alloc(0), inHeader = true, pathBytes = 0, pathBuffer = Buffer.alloc(0), mode = "", entries = 0, stderrBytes = 0, stderr = "", failure: Error | undefined;
    const symlinks: string[] = [];
    let pathBytesTotal = 0;
    const timeout = setTimeout(() => abort(new Error(`Git index validation timed out after ${timeoutMs}ms`)), timeoutMs);
    const abort = (error: Error) => { if (!failure) { failure = error; child.kill("SIGKILL"); } };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      for (const byte of chunk) {
        if (inHeader) {
          if (byte === 9) {
            const prefix = header.toString("ascii");
            const parsed = /^(100(?:644|755)|120000) [0-9a-f]+ 0$/.exec(prefix);
            if (!parsed) { abort(new Error("Git index contains a gitlink or unsupported entry mode")); break; }
            mode = parsed[1]!;
            header = Buffer.alloc(0); inHeader = false; pathBytes = 0; pathBuffer = Buffer.alloc(0);
          } else {
            if (header.byteLength >= 128) { abort(new Error("Malformed Git index record")); break; }
            header = Buffer.concat([header, Buffer.from([byte])]);
          }
        } else if (byte === 0) {
          if (++entries > 20_000) { abort(new Error("Git index exceeds 20,000 entries")); break; }
          pathBytesTotal += pathBytes;
          // Bound aggregate raw paths at 64 MiB (about 3.2 KiB per entry
          // at the 20,000-entry cap), while separately bounding each path at 4 KiB.
          if (pathBytesTotal > 64 * 1024 * 1024) { abort(new Error("Git index paths exceed 64 MiB")); break; }
          if (mode === "120000") {
            const relativePath = pathBuffer.toString("utf8");
            if (!Buffer.from(relativePath, "utf8").equals(pathBuffer)) { abort(new Error("Git symlink path is not valid UTF-8")); break; }
            symlinks.push(relativePath);
          }
          inHeader = true; header = Buffer.alloc(0); pathBytes = 0; pathBuffer = Buffer.alloc(0); mode = "";
        } else {
          if (++pathBytes > 4096) { abort(new Error("Git index path exceeds OS bounds")); break; }
          pathBuffer = Buffer.concat([pathBuffer, Buffer.from([byte])]);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1024) abort(new Error("Git index validation diagnostics exceeded 64 KiB"));
      else stderr += chunk.toString("utf8");
    });
    child.once("error", error => abort(error));
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`Git index validation failed (${signal ?? code}): ${stderr.trim()}`)); return; }
      if (!inHeader || header.byteLength !== 0 || entries === 0) { reject(new Error("Malformed or empty Git index")); return; }
      try {
        const root = await realpath(path);
        for (const relativePath of symlinks) await validateConfinedSymlink(root, relativePath);
        resolve(entries);
      } catch (error) { reject(error); }
    });
  });
}

/** Clone one source branch into an isolated store checkout; do not fetch tags or other branches. */
export async function cloneRemoteRepository(source: string, destination: string, timeoutMs = 60_000): Promise<void> {
  await safeSnapshotGit(dirname(destination), timeoutMs, "clone", "--single-branch", "--no-tags", "--no-checkout", "--no-hardlinks", "--no-local", "--", source, destination);
  await configureSnapshotWorktree(destination, timeoutMs);
  await snapshotGit(destination, timeoutMs, "checkout", "--force", "HEAD");
  await snapshotGit(destination, timeoutMs, "config", "--local", "--unset", "core.hooksPath");
  await checkCheckoutStatus(destination, timeoutMs);
  await validateSnapshotIndex(destination, timeoutMs);
}

async function checkCheckoutStatus(path: string, timeoutMs: number) {
  if (await snapshotGit(path, timeoutMs, "status", "--porcelain", "--untracked-files=all") !== "")
    throw new Error("Cloned Git worktree differs from its index");
}

/** Create an isolated, pinned, one-commit checkout. --no-local is essential: local
 * clones otherwise ignore --depth and can share objects through alternates. */
export async function clonePinnedSkill(source: string, destination: string, commit: string, timeoutMs = 60_000): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid canonical skill commit");
  await safeSnapshotGit(dirname(destination), timeoutMs, "clone", "--depth=1", "--no-tags", "--no-checkout", "--no-hardlinks", "--no-local", "--single-branch", "--", source, destination);
  await configureSnapshotWorktree(destination, timeoutMs);
  await snapshotGit(destination, timeoutMs, "checkout", "--detach", "--force", commit);
  await snapshotGit(destination, timeoutMs, "remote", "remove", "origin").catch(() => "");
  await snapshotGit(destination, timeoutMs, "config", "--local", "--unset", "core.hooksPath");
  await checkCheckoutStatus(destination, timeoutMs);
  await validateSnapshotIndex(destination, timeoutMs);
  if (await snapshotGit(destination, timeoutMs, "rev-parse", "--is-shallow-repository") !== "true" ||
      (await snapshotGit(destination, timeoutMs, "rev-list", "--count", "HEAD")) !== "1")
    throw new Error("Pinned skill checkout is not a single-commit shallow repository");
  const gitDir = await snapshotGit(destination, timeoutMs, "rev-parse", "--git-dir");
  if (await exists(join(destination, gitDir, "objects", "info", "alternates"))) throw new Error("Pinned skill checkout uses shared Git objects");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function cloneManagedRepository(source: string, destination: string, timeoutMs = 60_000): Promise<void> {
  const commit = await snapshotGit(source, timeoutMs, "rev-parse", "HEAD");
  await clonePinnedSkill(source, destination, commit, timeoutMs);
}

async function configureSnapshotWorktree(path: string, timeoutMs: number) {
  const info = join(path, ".git", "info");
  await mkdir(info, { recursive: true, mode: 0o700 });
  await chmod(info, 0o700);
  await writeFile(join(info, "attributes"), "* -text -filter -ident -working-tree-encoding\n", { mode: 0o600, flag: "wx" });
  for (const value of snapshotConfig) {
    const separator = value.indexOf("=");
    await snapshotGit(path, timeoutMs, "config", "--local", value.slice(0, separator), value.slice(separator + 1));
  }
}
