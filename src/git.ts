import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, writeFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
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

/** Initialize a local-only, one-commit repository without source remotes/history or executing repository content. */
export async function cloneRemoteRepository(source: string, destination: string, timeoutMs = 60_000): Promise<void> {
  await safeSnapshotGit(dirname(destination), timeoutMs, "clone", "--no-checkout", "--no-hardlinks", "--no-single-branch", "--", source, destination);
  await configureSnapshotWorktree(destination, timeoutMs, false);
  await snapshotGit(destination, timeoutMs, "fetch", "--force", "--no-tags", "origin", "+refs/tags/*:refs/tags/*");
  await snapshotGit(destination, timeoutMs, "checkout", "--force", "HEAD");
  await snapshotGit(destination, timeoutMs, "config", "--local", "--unset", "core.hooksPath");
  await checkCheckoutStatus(destination, timeoutMs);
  await validateSnapshotIndex(destination, timeoutMs);
}

async function checkCheckoutStatus(path: string, timeoutMs: number) {
  if (await snapshotGit(path, timeoutMs, "status", "--porcelain", "--untracked-files=all") !== "")
    throw new Error("Cloned Git worktree differs from its index");
}

export async function cloneManagedRepository(source: string, destination: string, timeoutMs = 60_000): Promise<void> {
  // Preserve every managed supported branch/tag in independent agent clones too.
  await safeSnapshotGit(dirname(destination), timeoutMs, "clone", "--no-checkout", "--no-hardlinks", "--no-local", "--no-single-branch", "--tags", "--", source, destination);
  await configureSnapshotWorktree(destination, timeoutMs, false);
  await snapshotGit(destination, timeoutMs, "checkout", "--force", "HEAD");
  await snapshotGit(destination, timeoutMs, "config", "--local", "--unset", "core.hooksPath");
  await checkCheckoutStatus(destination, timeoutMs);
  await validateSnapshotIndex(destination, timeoutMs);
}

export async function cloneLocalSnapshot(source: string, destination: string, timeoutMs = 60_000): Promise<void> {
  await safeSnapshotGit(source, timeoutMs, "clone", "--no-checkout", "--no-hardlinks", "--template=", "--", source, destination);
  await configureSnapshotWorktree(destination, timeoutMs, false);
  await snapshotGit(destination, timeoutMs, "checkout", "--force", "HEAD");
  await snapshotGit(destination, timeoutMs, "config", "--local", "--unset", "core.hooksPath");
  await checkCheckoutStatus(destination, timeoutMs);
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

export async function initializeRepositoryShell(path: string, timeoutMs = 60_000): Promise<void> {
  await snapshotGit(path, timeoutMs, "init", "--quiet", "--template=", "--initial-branch=main");
  await configureSnapshotWorktree(path, timeoutMs, true);
}

export async function initializeLocalSnapshot(path: string, timeoutMs = 60_000): Promise<void> {
  await initializeRepositoryShell(path, timeoutMs);
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

/** Validate full managed HTTPS clone history without modifying its selected commit. */
export async function managedHead(path: string, timeoutMs: number): Promise<string> {
  return snapshotGit(path, timeoutMs, "rev-parse", "HEAD");
}

export async function indexImportedPack(path: string, packPath: string, timeoutMs: number): Promise<void> {
  await snapshotGit(path, timeoutMs, "index-pack", "--strict", "--index-version=2", packPath);
}

export async function normalizeRemoteBranches(path: string, timeoutMs: number): Promise<Array<[string, string]>> {
  const remoteRefs = await snapshotGit(path, timeoutMs, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin");
  const manifest: Array<[string, string]> = [];
  for (const line of remoteRefs.split("\n").filter(Boolean)) {
    const [ref, oid] = line.split(" ");
    if (!ref || !oid || ref === "refs/remotes/origin/HEAD") continue;
    const branch = ref.slice("refs/remotes/origin/".length);
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.startsWith(".") || branch.endsWith(".lock")) throw new Error("Remote advertised an unsupported branch ref");
    const target = `refs/heads/${branch}`;
    await snapshotGit(path, timeoutMs, "update-ref", target, oid);
    manifest.push([target, oid]);
  }
  const tags = await snapshotGit(path, timeoutMs, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags");
  for (const line of tags.split("\n").filter(Boolean)) { const [ref, oid] = line.split(" "); if (ref && oid) manifest.push([ref, oid]); }
  return manifest;
}

export async function validateRemoteHistory(path: string, timeoutMs: number): Promise<string> {
  const output = await snapshotGit(path, timeoutMs, "for-each-ref", "--format=%(refname) %(objectname) %(objecttype) %(*objectname) %(*objecttype)");
  const rows = output.split("\n").filter(Boolean);
  if (rows.length > 12_290) throw Object.assign(new Error("Git source ref inventory exceeds supported bounds"), { code: "LIMIT" });
  let supportedRefCount = 0;
  for (const line of rows) {
    const [ref, oid, type, peeledOid, peeledType] = line.split(" ");
    const supported = ref?.startsWith("refs/heads/") || ref?.startsWith("refs/tags/") || ref?.startsWith("refs/remotes/origin/");
    if (!supported || !oid || !/^[0-9a-f]{40}$/.test(oid)) throw new Error("Cloned Git ref manifest is invalid");
    if (ref === "refs/remotes/origin/HEAD") continue;
    if (ref?.startsWith("refs/remotes/origin/") || ref?.startsWith("refs/tags/")) {
      if (++supportedRefCount > 4096) throw Object.assign(new Error("Git source exceeds 4,096 supported branch/tag refs"), { code: "LIMIT" });
    }
    const isTag = ref?.startsWith("refs/tags/");
    const pointsToCommit = type === "commit" || isTag && type === "tag" && peeledType === "commit" && /^[0-9a-f]{40}$/.test(peeledOid ?? "");
    if (!pointsToCommit) throw Object.assign(new Error(`Supported Git ref does not resolve to a commit: ${ref}`), { code: "INCOMPLETE_HISTORY" });
  }
  const head = await snapshotGit(path, timeoutMs, "rev-parse", "HEAD");
  await snapshotGit(path, timeoutMs, "fsck", "--full", "--strict", "--no-reflogs", "--no-dangling");
  await validateImportedObjectInventory(path, timeoutMs);
  return head;
}

/** Validate imported objects and append a dirty working-tree snapshot using only managed metadata. */
export async function preserveImportedHistory(path: string, timeoutMs: number, selectedHead?: string): Promise<{ selected?: string; dirtyCommit?: string }> {
  const refs = await snapshotGit(path, timeoutMs, "for-each-ref", "--format=%(refname) %(objectname) %(objecttype) %(*objectname) %(*objecttype)");
  const refRows = refs.split("\n").filter(Boolean);
  if (refRows.length > 4096) throw Object.assign(new Error("Imported Git exceeds 4,096 refs"), { code: "LIMIT" });
  for (const line of refRows) {
    const [ref, oid, type, peeledOid, peeledType] = line.split(" ");
    if (!ref || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref) || !/^[0-9a-f]{40}$/.test(oid ?? "")) throw new Error("Imported Git ref manifest is invalid");
    const isTag = ref.startsWith("refs/tags/");
    const pointsToCommit = type === "commit" || isTag && type === "tag" && peeledType === "commit" && /^[0-9a-f]{40}$/.test(peeledOid ?? "");
    if (!pointsToCommit) throw Object.assign(new Error(`Supported Git ref does not resolve to a commit: ${ref}`), { code: "INCOMPLETE_HISTORY" });
  }
  if (selectedHead) {
    const commit = await snapshotGit(path, timeoutMs, "rev-parse", "--verify", `${selectedHead}^{commit}`).catch(() => "");
    if (commit !== selectedHead) throw Object.assign(new Error("Selected Git HEAD is missing or is not a commit"), { code: "INCOMPLETE_HISTORY" });
  }
  await snapshotGit(path, timeoutMs, "fsck", "--full", "--strict", "--no-reflogs", "--no-dangling");
  await validateImportedObjectInventory(path, timeoutMs);
  if (selectedHead) await validateSelectedTreeNoGitlinks(path, selectedHead, timeoutMs);
  await snapshotGit(path, timeoutMs, "add", "--force", "--all", "--", ".");
  const worktreeTree = await snapshotGit(path, timeoutMs, "write-tree");
  let clean = false;
  if (selectedHead) {
    const sourceTree = await snapshotGit(path, timeoutMs, "rev-parse", "--verify", `${selectedHead}^{tree}`);
    clean = sourceTree === worktreeTree;
  }
  if (clean) return { selected: selectedHead };
  const args = ["commit-tree", worktreeTree];
  if (selectedHead) args.push("-p", selectedHead);
  args.push("-m", selectedHead ? "Import local skill working tree" : "Import local skill repository");
  const commit = await snapshotGit(path, timeoutMs, ...args);
  const branch = `refs/heads/agentorg-import-${randomUUID()}`;
  await snapshotGit(path, timeoutMs, "update-ref", branch, commit);
  await writeFile(join(path, ".git", "HEAD"), `ref: ${branch}\n`, { mode: 0o600 });
  const head = await snapshotGit(path, timeoutMs, "rev-parse", "HEAD");
  if (head !== commit) throw new Error("Managed import branch did not select the snapshot commit");
  await snapshotGit(path, timeoutMs, "reset", "--mixed", "HEAD");
  if (await snapshotGit(path, timeoutMs, "status", "--porcelain", "--untracked-files=all") !== "") throw new Error("Imported working tree differs from its snapshot commit");
  return { selected: commit, dirtyCommit: commit };
}

async function validateSelectedTreeNoGitlinks(path: string, head: string, timeoutMs: number): Promise<void> {
  const config = snapshotConfig.flatMap(value => ["-c", value]);
  const args = ["-c", "protocol.allow=never", "-C", path, ...config, "ls-tree", "-r", "-z", "--full-tree", head];
  const child = spawn("git", args, { env: gitEnvironment(true), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let header = Buffer.alloc(0), pathBytes = 0, readingPath = false, count = 0, stderrBytes = 0, stderr = "", failure: Error | undefined;
    const abort = (error: Error) => { if (!failure) { failure = error; child.kill("SIGKILL"); } };
    const timer = setTimeout(() => abort(new Error(`Git selected-tree validation timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      for (const byte of chunk) {
        if (!readingPath) {
          if (byte === 9) {
            const fields = header.toString("ascii").split(" ");
            if (fields[0] === "160000") { abort(Object.assign(new Error("Selected skill tree contains a gitlink/submodule"), { code: "UNSUPPORTED_SOURCE" })); break; }
            if (!/^(?:100(?:644|755)|120000)$/.test(fields[0] ?? "") || fields.length !== 3 || !/^[0-9a-f]{40}$/.test(fields[2] ?? "")) { abort(new Error("Selected skill tree contains an unsupported entry")); break; }
            readingPath = true; pathBytes = 0;
          } else { if (header.byteLength >= 128) { abort(new Error("Malformed selected Git tree entry")); break; } header = Buffer.concat([header, Buffer.from([byte])]); }
        } else if (byte === 0) {
          if (++count > 20_000) { abort(Object.assign(new Error("Selected Git tree exceeds 20,000 entries"), { code: "LIMIT" })); break; }
          header = Buffer.alloc(0); readingPath = false; pathBytes = 0;
        } else if (++pathBytes > 4096) { abort(Object.assign(new Error("Selected Git tree path exceeds OS bounds"), { code: "LIMIT" })); break; }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > 1024 * 1024) abort(new Error("Git tree diagnostics exceeded 1 MiB")); else stderr += chunk.toString("utf8"); });
    child.once("error", error => abort(error));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Git selected-tree validation failed (${signal ?? code}): ${stderr.trim()}`));
      else if (readingPath || header.byteLength) reject(new Error("Truncated selected Git tree"));
      else resolve();
    });
  });
}

async function validateImportedObjectInventory(path: string, timeoutMs: number): Promise<void> {
  const config = snapshotConfig.flatMap(value => ["-c", value]);
  const args = ["-c", "protocol.allow=never", "-C", path, ...config, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"];
  const child = spawn("git", args, { env: gitEnvironment(true), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let buffer = "", count = 0, bytes = 0, stderrBytes = 0, stderr = "", failure: Error | undefined;
    const abort = (error: Error) => { if (!failure) { failure = error; child.kill("SIGKILL"); } };
    const timer = setTimeout(() => abort(new Error(`Git object validation timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failure) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const match = /^[0-9a-f]{40} (?:blob|tree|commit|tag) ([0-9]+)$/.exec(line);
        if (!match) { abort(new Error("Malformed Git object inventory")); return; }
        if (++count > 100_000) { abort(Object.assign(new Error("Git history exceeds 100,000 objects"), { code: "LIMIT" })); return; }
        bytes += Number(match[1]);
        if (!Number.isSafeInteger(bytes) || bytes > 256 * 1024 * 1024) { abort(Object.assign(new Error("Expanded Git history exceeds 256 MiB"), { code: "LIMIT" })); return; }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 1024 * 1024) abort(new Error("Git object validation diagnostics exceeded 1 MiB"));
      else stderr += chunk.toString("utf8");
    });
    child.once("error", error => abort(error));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Git object inventory failed (${signal ?? code}): ${stderr.trim()}`));
      else if (buffer) reject(new Error("Truncated Git object inventory"));
      else resolve();
    });
  });
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWithTimeout(cwd, 60_000, ...args);
}
