import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { indexImportedPack, initializeLocalSnapshot, preserveImportedHistory } from "./git.ts";

const fail = (message: string, code = "UNSUPPORTED_SOURCE"): never => { throw Object.assign(new Error(message), { code }); };
const OID = /^[0-9a-f]{40}$/;
const REF = /^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/;
const MAX_REFS = 4096, MAX_OBJECT_FILES = 100_000, MAX_PACK_FILES = 1024, MAX_RAW_BYTES = 256 * 1024 * 1024, MAX_META = 4 * 1024 * 1024;
const MAX_TRAVERSAL_ENTRIES = 100_000, MAX_TRAVERSAL_MS = 60_000, READ_CHUNK = 64 * 1024;
interface TraversalBudget { entries: number; deadline: number }
function checkBudget(budget: TraversalBudget) {
  if (Date.now() > budget.deadline) fail("Git metadata traversal exceeded its 60-second deadline", "LIMIT");
}
function chargeEntry(budget: TraversalBudget) {
  checkBudget(budget);
  if (++budget.entries > MAX_TRAVERSAL_ENTRIES) fail("Git metadata traversal exceeds 100,000 entries", "LIMIT");
}

export interface LocalGitCapture {
  root: string; gitDir: string; head: { ref?: string; oid?: string }; refs: Map<string, string>;
  gitIdentity: { dev: number | bigint; ino: number | bigint };
  objectsIdentity: { dev: number | bigint; ino: number | bigint };
  objectManifest: string;
}

async function regularText(path: string, max: number, budget?: TraversalBudget): Promise<string> {
  const info = await lstat(path).catch((error: any) => { if (error.code === "ENOENT") throw error; return fail(`Cannot inspect Git metadata ${path}: ${error.message}`, "INVALID_PATH"); });
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail(`Unsafe or oversized Git metadata: ${path}`, "UNSUPPORTED_SOURCE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size > max) fail(`Git metadata changed: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= max) {
      if (budget) checkBudget(budget);
      const buffer = Buffer.alloc(Math.min(READ_CHUNK, max + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) fail(`Git metadata grew beyond ${max} bytes: ${path}`, "LIMIT");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const text = Buffer.concat(chunks, total).toString("utf8");
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== after.size) fail(`Git metadata changed: ${path}`);
    return text;
  } finally { await handle.close(); }
}

function validRef(name: string) {
  return REF.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") &&
    !name.endsWith(".") && !name.includes("@{") && !name.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
}

async function readMaybe(path: string, max = MAX_META, budget?: TraversalBudget): Promise<string | undefined> {
  try { return await regularText(path, max, budget); } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/** Parse a real, self-contained ordinary worktree without invoking Git or following metadata symlinks. */
export async function captureLocalGit(rootInput: string): Promise<LocalGitCapture | undefined> {
  const root = await realpath(rootInput);
  const budget: TraversalBudget = { entries: 0, deadline: Date.now() + MAX_TRAVERSAL_MS };
  const gitDir = join(root, ".git");
  let stat: Awaited<ReturnType<typeof lstat>> | undefined;
  try { stat = await lstat(gitDir); } catch (error: any) { if (error.code !== "ENOENT") fail(`Cannot inspect .git: ${error.message}`, "INVALID_PATH"); }
  if (!stat) {
    // A parent Git root means this is an unsupported monorepo subdirectory, not a non-Git skill.
    let parent = root;
    while (parent !== parseRoot(parent)) {
      chargeEntry(budget);
      parent = join(parent, "..");
      const marker = await lstat(join(parent, ".git")).catch(() => undefined);
      if (marker) fail("Skill path is inside a Git worktree; use the worktree root", "UNSUPPORTED_SOURCE");
    }
    const bareMarkers = await Promise.all(["objects", "refs", "HEAD"].map(name => { chargeEntry(budget); return lstat(join(root, name)).catch(() => undefined); }));
    if (bareMarkers.every(Boolean)) fail("Bare Git repositories are not supported; provide a materialized worktree root", "UNSUPPORTED_SOURCE");
    return undefined;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Local Git sources require a real .git directory (gitfiles and linked worktrees are unsupported)");
  const gitIdentity = { dev: stat.dev, ino: stat.ino };
  let metadataBytes = 0;
  const accountMetadata = (text: string) => { metadataBytes += Buffer.byteLength(text); if (metadataBytes > MAX_META) fail("Git ref/config metadata exceeds 4 MiB", "LIMIT"); return text; };
  for (const marker of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "shallow"]){
    chargeEntry(budget);
    const found = await lstat(join(gitDir, marker)).catch(() => undefined);
    if (found) fail(`Unsupported Git layout marker: ${marker}`);
  }
  const config = await readMaybe(join(gitDir, "config"), MAX_META, budget);
  if (config !== undefined) accountMetadata(config);
  const repositoryConfig = config ?? fail("Malformed Git repository: .git/config is missing");
  if (/^\s*\[include(?:if)?\s/m.test(repositoryConfig)) fail("Git config includes are unsupported");
  const extensionSection = /^\s*\[extensions\]\s*([\s\S]*?)(?=^\s*\[|$)/im.exec(repositoryConfig)?.[1];
  if (extensionSection && extensionSection.split(/\r?\n/).some(line => line.trim() && !/^objectformat\s*=\s*sha1\s*$/i.test(line.trim())))
    fail("Only SHA-1 Git object format without other Git extensions is supported");
  if (/^\s*bare\s*=\s*true\s*$/im.test(repositoryConfig) || /^\s*(promisor|partialclone|worktree)\s*=/im.test(repositoryConfig)) fail("Bare, partial clones and linked worktrees are unsupported");
  const headText = accountMetadata(await regularText(join(gitDir, "HEAD"), 1024, budget)).trim();
  const head: LocalGitCapture["head"] = {};
  if (headText.startsWith("ref: ")) {
    const ref = headText.slice(5);
    if (!validRef(ref) || !ref.startsWith("refs/heads/")) fail("HEAD must select a local branch");
    head.ref = ref;
  } else if (OID.test(headText)) head.oid = headText;
  else fail("Malformed Git HEAD");

  const refs = new Map<string, string>();
  const refsRoot = join(gitDir, "refs");
  async function visit(dir: string): Promise<void> {
    chargeEntry(budget);
    const dirInfo = await lstat(dir).catch((error: any) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!dirInfo) return;
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) fail("Git ref directories must be real directories");
    for await (const entry of await opendir(dir)) {
      chargeEntry(budget);
      const name = entry.name;
      if (refs.size > MAX_REFS) fail("Git source exceeds 4,096 supported refs", "LIMIT");
      const path = join(dir, name), info = await lstat(path);
      if (info.isSymbolicLink()) fail("Git refs must not be symlinks");
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const ref = `refs/${relative(refsRoot, path).split(sep).join("/")}`;
        if (ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) {
          if (!validRef(ref)) fail(`Invalid supported Git ref: ${ref}`);
          const value = accountMetadata(await regularText(path, 1024, budget)).trim();
          if (!OID.test(value)) fail(`Malformed Git ref: ${ref}`);
          refs.set(ref, value);
        }
      } else fail("Git ref store contains a special file");
    }
  }
  await visit(refsRoot);
  const packed = await readMaybe(join(gitDir, "packed-refs"), MAX_META, budget);
  if (packed !== undefined) accountMetadata(packed);
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const match = /^(\S+) (\S+)$/.exec(line) ?? fail("Malformed packed-refs metadata");
      const oid = match[1] ?? fail("Malformed packed-refs metadata"), ref = match[2] ?? fail("Malformed packed-refs metadata");
      if (!OID.test(oid)) fail("Malformed packed-refs metadata");
      if (ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) {
        if (!validRef(ref)) fail("Malformed supported packed ref");
        if (!refs.has(ref)) refs.set(ref, oid);
      }
    }
  }
  if (head.ref && refs.has(head.ref)) head.oid = refs.get(head.ref);
  if (head.ref && !head.oid && refs.has(head.ref)) fail("Could not resolve Git HEAD");
  for (const ref of refs.keys()) if (refs.size > MAX_REFS) fail("Git source exceeds 4,096 supported refs", "LIMIT");
  const objectDir = join(gitDir, "objects");
  chargeEntry(budget);
  const objectStat = (await lstat(objectDir).catch(() => undefined)) ?? fail("Git object store must be a real directory");
  if (!objectStat.isDirectory() || objectStat.isSymbolicLink()) fail("Git object store must be a real directory");
  const objectManifest = await scanObjectStore(objectDir, budget);
  return { root, gitDir, head, refs, gitIdentity, objectsIdentity: { dev: objectStat.dev, ino: objectStat.ino }, objectManifest };
}

function parseRoot(path: string) { return path === "/" ? "/" : path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/"; }

async function scanObjectStore(root: string, budget: TraversalBudget): Promise<string> {
  const rows: string[] = []; let count = 0, bytes = 0;
  async function walk(dir: string, kind: "root" | "fanout" | "pack" | "info") {
    checkBudget(budget);
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) fail("Git object store directories must not be symlinks");
    for await (const entry of await opendir(dir)) {
      chargeEntry(budget);
      const name = entry.name;
      const path = join(dir, name), info = await lstat(path);
      if (info.isSymbolicLink()) fail("Git object store contains a symlink");
      if (info.isDirectory()) {
        if (kind !== "root" || !(name === "pack" || /^[0-9a-f]{2}$/.test(name) || name === "info")) fail("Unsupported Git object-store directory");
        await walk(path, name === "pack" ? "pack" : name === "info" ? "info" : "fanout");
      } else {
        const valid = info.isFile() && (kind === "fanout" && /^[0-9a-f]{38}$/.test(name) || kind === "pack" && /^pack-[0-9a-f]{40}\.(?:pack|idx|rev|bitmap)$/.test(name) || kind === "info" && (name === "commit-graph" || name === "packs"));
        if (!valid) fail("Unsupported Git object-store entry");
        if (++count > MAX_OBJECT_FILES) fail("Git source exceeds 100,000 object files", "LIMIT");
        bytes += info.size;
        if (bytes > MAX_RAW_BYTES) fail("Git object storage exceeds 256 MiB", "LIMIT");
        rows.push(`${relative(root, path)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
      }
    }
  }
  await walk(root, "root");
  return createHash("sha256").update(rows.sort().join("\\n")).digest("hex");
}

function fdPath(fd: number, name = "") { return `/proc/self/fd/${fd}${name ? `/${name}` : ""}`; }
async function openDirectoryAt(parentFd: number, name: string) {
  const path = fdPath(parentFd, name), before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) fail("Git object store contains a non-directory entry");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const after = await handle.stat();
  if (before.dev !== after.dev || before.ino !== after.ino) { await handle.close(); fail("Git object directory changed during import"); }
  return handle;
}
async function copyRegularAt(parentFd: number, name: string, target: string, bytes: { value: number }, budget: TraversalBudget) {
  const source = fdPath(parentFd, name), info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) fail("Git object store contains a non-regular file");
  const priorBytes = bytes.value;
  if (priorBytes + info.size > MAX_RAW_BYTES) fail("Git object storage exceeds 256 MiB", "LIMIT");
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await input.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) fail("Git object changed during import");
    const chunks: Buffer[] = [];
    const maxFileBytes = MAX_RAW_BYTES - priorBytes;
    let total = 0;
    while (total <= maxFileBytes) {
      checkBudget(budget);
      const buffer = Buffer.alloc(Math.min(READ_CHUNK, maxFileBytes + 1 - total));
      const { bytesRead } = await input.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxFileBytes) fail("Git object grew beyond the 256 MiB import budget", "LIMIT");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await input.stat();
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || total !== after.size) fail("Git object changed during import");
    bytes.value = priorBytes + total;
    const data = Buffer.concat(chunks, total);
    const packName = /\/pack\/pack-([0-9a-f]{40})\.pack$/.exec(target);
    if (packName && (data.byteLength < 20 || data.subarray(-20).toString("hex") !== packName[1])) fail("Git pack filename/checksum mismatch", "INCOMPLETE_HISTORY");
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { mode: 0o600, flag: "wx" });
  } finally { await input.close(); }
}

/** Copy only Git object bytes; refs/config are generated from the validated capture. */
export async function importLocalGitHistory(capture: LocalGitCapture, managedPath: string, timeoutMs: number): Promise<{ selected?: string; originalHead?: string; dirtyCommit?: string; refCount: number; manifest: string }> {
  await initializeLocalSnapshotShell(managedPath, timeoutMs);
  const traversal: TraversalBudget = { entries: 0, deadline: Date.now() + MAX_TRAVERSAL_MS };
  const gitDir = join(managedPath, ".git"), sourceObjects = join(capture.gitDir, "objects"), targetObjects = join(gitDir, "objects");
  const bytes = { value: 0 }, count = { value: 0 };
  const sourceGitHandle = await open(capture.gitDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let objectHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const gitStat = await sourceGitHandle.stat();
    if (gitStat.dev !== capture.gitIdentity.dev || gitStat.ino !== capture.gitIdentity.ino) fail("Source .git directory changed during import", "INVALID_PATH");
    objectHandle = await openDirectoryAt(sourceGitHandle.fd, "objects");
    const objectStat = await objectHandle.stat();
    if (objectStat.dev !== capture.objectsIdentity.dev || objectStat.ino !== capture.objectsIdentity.ino) fail("Source object store changed during import", "INVALID_PATH");
    for await (const sourceEntry of await opendir(fdPath(objectHandle.fd))) {
      chargeEntry(traversal);
      const entry = sourceEntry.name;
      const info = await lstat(fdPath(objectHandle.fd, entry));
      if (info.isSymbolicLink()) fail("Git object store contains a symlink");
      if (entry === "info") {
        const infoHandle = await openDirectoryAt(objectHandle.fd, entry);
        try {
          for await (const fileEntry of await opendir(fdPath(infoHandle.fd))) {
            chargeEntry(traversal);
            const file = fileEntry.name;
            if (file !== "commit-graph" && file !== "packs") fail("Unsupported Git object-store metadata/alternates");
            const fileStat = await lstat(fdPath(infoHandle.fd, file));
            if (!fileStat.isFile() || fileStat.isSymbolicLink()) fail("Unsafe Git object-store metadata");
          }
        } finally { await infoHandle.close(); }
      } else if (entry === "pack") {
        const packHandle = await openDirectoryAt(objectHandle.fd, entry);
        try {
          const packDir = join(targetObjects, "pack"); await mkdir(packDir, { recursive: true, mode: 0o700 });
          const importedPacks: string[] = [];
          const packFiles: string[] = [];
          for await (const file of await opendir(fdPath(packHandle.fd))) { chargeEntry(traversal); packFiles.push(file.name); }
          const packs = packFiles.filter(file => /^pack-[0-9a-f]{40}\.pack$/.test(file));
          if (packs.length > MAX_PACK_FILES) fail("Git source exceeds 1,024 pack files", "LIMIT");
          for (const file of packFiles) {
            if (/^pack-[0-9a-f]{40}\.(?:idx|rev|bitmap)$/.test(file)) {
              const sidecar = await lstat(fdPath(packHandle.fd, file));
              if (!sidecar.isFile() || sidecar.isSymbolicLink()) fail("Unsafe Git pack sidecar");
              continue;
            }
            if (!/^pack-[0-9a-f]{40}\.pack$/.test(file)) fail(`Unsupported packed-object sidecar: ${file}`);
            if (++count.value > MAX_OBJECT_FILES) fail("Git source exceeds 100,000 object files", "LIMIT");
            await copyRegularAt(packHandle.fd, file, join(packDir, file), bytes, traversal);
            importedPacks.push(join(packDir, file));
          }
          if (packs.length !== importedPacks.length) fail("Invalid Git pack manifest");
          for (const pack of importedPacks) await indexImportedPack(managedPath, pack, timeoutMs);
        } finally { await packHandle.close(); }
      } else if (/^[0-9a-f]{2}$/.test(entry) && info.isDirectory()) {
        const fanoutHandle = await openDirectoryAt(objectHandle.fd, entry);
        try {
          const targetFanout = join(targetObjects, entry); await mkdir(targetFanout, { mode: 0o700 });
          for await (const fileEntry of await opendir(fdPath(fanoutHandle.fd))) {
            chargeEntry(traversal);
            const file = fileEntry.name;
            if (!/^[0-9a-f]{38}$/.test(file)) fail("Unsupported loose object-store entry");
            if (++count.value > MAX_OBJECT_FILES) fail("Git source exceeds 100,000 object files", "LIMIT");
            await copyRegularAt(fanoutHandle.fd, file, join(targetFanout, file), bytes, traversal);
          }
        } finally { await fanoutHandle.close(); }
      } else fail(`Unsupported Git object-store entry: ${entry}`);
    }
  } finally { await objectHandle?.close(); await sourceGitHandle.close(); }
  for (const [ref, oid] of capture.refs) {
    const path = join(gitDir, ...ref.split("/")); await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, `${oid}\n`, { mode: 0o600, flag: "wx" });
  }
  if (capture.head.ref) await writeFile(join(gitDir, "HEAD"), `ref: ${capture.head.ref}\n`, { mode: 0o600 });
  else if (capture.head.oid) await writeFile(join(gitDir, "HEAD"), `${capture.head.oid}\n`, { mode: 0o600 });
  const imported = await preserveImportedHistory(managedPath, timeoutMs, capture.head.oid);
  const manifest = [["HEAD", capture.head.oid ?? capture.head.ref ?? "unborn"] as [string, string], ...capture.refs]
    .sort(([a], [b]) => a.localeCompare(b));
  return { ...imported, originalHead: capture.head.oid, refCount: capture.refs.size + 1, manifest: createHashHex(JSON.stringify(manifest)) };
}

import { createHash } from "node:crypto";
function createHashHex(value: string) { return createHash("sha256").update(value).digest("hex"); }
async function initializeLocalSnapshotShell(path: string, timeout: number) {
  // The tree was copied already. Initialize an empty managed repository without staging/committing it.
  const { initializeRepositoryShell } = await import("./git.ts");
  await initializeRepositoryShell(path, timeout);
}
