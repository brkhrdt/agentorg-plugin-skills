import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_SKILL_ENTRIES, MAX_SKILL_MD_BYTES, MAX_SKILL_PAYLOAD_BYTES, readSkillMetadata } from "./skill-content.ts";

export interface LocalSourceOptions { baseDir?: string; home?: string; centralRoot?: string }
export interface ResolvedLocalSource { directory: string; skillFile: string; device: number; inode: number }
export interface LocalCopyOptions extends LocalSourceOptions {
  /** Deterministic fault/mutation seam; a failed stage is deliberately retained. */
  beforeCopyFile?: (source: string, destination: string) => void | Promise<void>;
  afterSourceOpen?: (source: string) => void | Promise<void>;
  beforeOpenEntry?: (source: string) => void | Promise<void>;
  afterStageMkdir?: (destination: string) => void | Promise<void>;
}
export interface LocalCopyResult { sourcePath: string; destinationPath: string; name: string; description: string; entries: number; bytes: number }
const fail = (message: string, code = "INVALID_PARAMS"): never => { throw Object.assign(new Error(message), { code }); };
const MAX_PATH_LENGTH = 4096;
const linuxFdTraversal = process.platform === "linux";
function requireFdTraversal() { if (!linuxFdTraversal) fail("Safe local skill copying requires Linux /proc/self/fd directory handles"); }
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function overlaps(a: string, b: string): boolean { return within(a, b) || within(b, a); }
function fdPath(fd: number, name = "") { return `/proc/self/fd/${fd}${name ? `/${name}` : ""}`; }
function sameIdentity(a: { dev: number | bigint; ino: number | bigint }, b: { dev: number | bigint; ino: number | bigint }) {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameSnapshot(a: any, b: any) {
  return sameIdentity(a, b) && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function assertPathIdentity(path: string, expected: { dev: number | bigint; ino: number | bigint }, label: string) {
  let actual;
  try { actual = await lstat(path); } catch { fail(`${label} path changed during copy`); }
  if (actual!.isSymbolicLink() || !sameIdentity(actual!, expected)) fail(`${label} path changed during copy`);
}

export async function resolveLocalSource(input: unknown, options: LocalSourceOptions = {}): Promise<ResolvedLocalSource> {
  if (typeof input !== "string") return fail("Invalid local skill path");
  if (input.length === 0 || input.length > MAX_PATH_LENGTH || input.includes("\0")) return fail("Invalid local skill path");
  let expanded: string = input;
  if (input === "~" || input.startsWith("~/")) {
    if (!options.home) fail("A home directory must be supplied to expand ~");
    expanded = join(options.home!, input === "~" ? "" : input.slice(2));
  } else if (!isAbsolute(input)) {
    if (!options.baseDir) fail("Relative local skill paths require an explicit base directory");
    expanded = resolve(options.baseDir!, input);
  }
  let suppliedInfo;
  try { suppliedInfo = await lstat(expanded); } catch (error) { fail(`Cannot inspect local skill path: ${(error as Error).message}`); }
  let canonical = "";
  try { canonical = await realpath(expanded); } catch (error) { fail(`Cannot resolve local skill path: ${(error as Error).message}`); }
  let info;
  try { info = await lstat(canonical); } catch (error) { fail(`Cannot inspect local skill path: ${(error as Error).message}`); }
  if (suppliedInfo!.isSymbolicLink() && !info!.isDirectory()) fail("Local skill file path must not be a symlink");
  let directory = "";
  if (info!.isDirectory()) directory = canonical;
  else if (info!.isFile() && canonical.split(sep).at(-1) === "SKILL.md") directory = dirname(canonical);
  else fail("Local source must be a directory or its root SKILL.md");
  const directoryInfo = await lstat(directory).catch(() => undefined);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) fail("Local skill root must be a regular directory");
  const skillFile = join(directory, "SKILL.md");
  const skillInfo = await lstat(skillFile).catch(() => undefined);
  if (!skillInfo?.isFile() || skillInfo.isSymbolicLink()) fail("Root SKILL.md must be a regular non-symlink file");
  if (options.centralRoot) {
    const central = await realpath(options.centralRoot);
    if (overlaps(central, directory)) fail("Local source must not overlap the managed central skills directory");
  }
  return { directory, skillFile, device: directoryInfo!.dev, inode: directoryInfo!.ino };
}

/** Copy to an exclusive private stage. Partial stages remain for diagnosis; no concurrent-writer snapshot is promised. */
export async function copyLocalSkill(input: unknown, destination: string, options: LocalCopyOptions = {}): Promise<LocalCopyResult> {
  requireFdTraversal();
  const source = await resolveLocalSource(input, options);
  const destinationAbsolute = resolve(destination);
  const targetParent = await realpath(dirname(destinationAbsolute)).catch((error) => fail(`Destination parent must exist: ${(error as Error).message}`));
  const target = join(targetParent, destinationAbsolute.split(sep).at(-1)!);
  if (overlaps(source.directory, target)) fail("Source and destination directories must not overlap");
  const central = options.centralRoot ? await realpath(options.centralRoot) : undefined;
  if (central && overlaps(central, target)) fail("Destination must not overlap the managed central skills directory");

  const parentHandle = await open(targetParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let stageHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const parentStat = await parentHandle.stat();
    if (typeof process.getuid !== "function" || parentStat.uid !== process.getuid() || (parentStat.mode & 0o022) !== 0)
      fail("Destination parent must be owned by this process and not group/world writable");
    const verifyParent = async () => {
      if (await realpath(targetParent).catch(() => "") !== targetParent) fail("Destination parent changed during copy");
      await assertPathIdentity(targetParent, parentStat, "Destination parent");
    };
    await verifyParent();
    const stagePath = join(fdPath(parentHandle.fd), target.split(sep).at(-1)!);
    try { await mkdir(stagePath, { mode: 0o700 }); }
    catch (error: any) { if (error.code === "EEXIST") fail(`Destination already exists: ${target}`, "DUPLICATE"); throw error; }
    const createdStageStat = await lstat(stagePath);
    await options.afterStageMkdir?.(target);
    stageHandle = await open(stagePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stageStat = await stageHandle.stat();
    if (!sameIdentity(createdStageStat, stageStat)) fail("New destination stage was replaced before opening");
    await assertPathIdentity(target, stageStat, "Destination stage");
    await chmod(fdPath(stageHandle.fd), 0o700);
    await verifyParent();
    const sourceHandle = await open(source.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const rootStat = await sourceHandle.stat();
      if (rootStat.dev !== source.device || rootStat.ino !== source.inode) fail("Source root changed during copy");
      await assertPathIdentity(source.directory, rootStat, "Source root");
      let entries = 0, bytes = 0;
      const walk = async (dirHandle: typeof sourceHandle, sourcePath: string, destHandle: Awaited<ReturnType<typeof open>>): Promise<void> => {
        const beforeDir = await dirHandle.stat();
        const destStat = await destHandle.stat();
        await assertPathIdentity(target, stageStat, "Destination stage");
        const directory = await opendir(fdPath(dirHandle.fd), { bufferSize: 32 });
        for await (const entry of directory) {
            const name = entry.name;
            if (name === ".git") continue;
            if (++entries > MAX_SKILL_ENTRIES) fail("Local skill exceeds 20,000 entries", "LIMIT");
            const sourceChild = join(fdPath(dirHandle.fd), name);
            const destinationChild = join(fdPath(destHandle.fd), name);
            const before = await lstat(sourceChild);
            if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) fail(`Unsupported source entry: ${join(sourcePath, name)}`);
            await options.beforeOpenEntry?.(join(sourcePath, name));
            if (before.isDirectory()) {
              const childHandle = await open(sourceChild, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              try {
                const opened = await childHandle.stat();
                if (!opened.isDirectory() || !sameIdentity(before, opened)) fail(`Source directory changed during copy: ${join(sourcePath, name)}`);
                await assertPathIdentity(sourceChild, opened, "Source directory");
                await mkdir(destinationChild, { mode: 0o700 });
                const childDest = await open(destinationChild, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                  await walk(childHandle, join(sourcePath, name), childDest);
                  if (!sameSnapshot(opened, await childHandle.stat())) fail(`Source directory changed during copy: ${join(sourcePath, name)}`);
                } finally { await childDest.close(); }
              } finally { await childHandle.close(); }
            } else {
              const sourceFile = join(sourcePath, name);
              const sourceFileHandle = await open(sourceChild, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              try {
                const opened = await sourceFileHandle.stat();
                if (!opened.isFile() || !sameIdentity(before, opened)) fail(`Source file changed during copy: ${sourceFile}`);
                await assertPathIdentity(sourceChild, opened, "Source file");
                await options.afterSourceOpen?.(sourceFile);
                await assertPathIdentity(sourceChild, opened, "Source file");
                if (name === "SKILL.md" && sourcePath === source.directory && opened.size > MAX_SKILL_MD_BYTES) fail("Root SKILL.md exceeds 128 KiB", "LIMIT");
                await options.beforeCopyFile?.(sourceFile, join(target, relative(source.directory, sourceFile)));
                await verifyParent();
                await assertPathIdentity(target, stageStat, "Destination stage");
                const outputMode = opened.mode & 0o111 ? 0o700 : 0o600;
                const destFileHandle = await open(destinationChild, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, outputMode);
                try { await destFileHandle.chmod(outputMode); } catch (error) { await destFileHandle.close(); throw error; }
                let skillBytes = 0;
                  const isRootSkill = name === "SKILL.md" && sourcePath === source.directory;
                  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                    const size = chunk.byteLength;
                    if (bytes + size > MAX_SKILL_PAYLOAD_BYTES) return callback(Object.assign(new Error("Local skill exceeds 256 MiB"), { code: "LIMIT" }));
                    if (isRootSkill && skillBytes + size > MAX_SKILL_MD_BYTES) return callback(Object.assign(new Error("Root SKILL.md exceeds 128 KiB"), { code: "LIMIT" }));
                    bytes += size;
                    if (isRootSkill) skillBytes += size;
                    callback(null, chunk);
                  } });
                try {
                  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
                    void (async () => {
                      let offset = 0;
                      while (offset < chunk.byteLength) {
                        const { bytesWritten } = await destFileHandle.write(chunk, offset, chunk.byteLength - offset, null);
                        if (bytesWritten <= 0) throw new Error("Destination write made no progress");
                        offset += bytesWritten;
                      }
                    })().then(() => callback(), callback);
                  } });
                  await pipeline(sourceFileHandle.createReadStream({ autoClose: false }), limiter, output);
                  await verifyParent();
                  await assertPathIdentity(target, stageStat, "Destination stage");
                  if (!sameSnapshot(opened, await sourceFileHandle.stat())) fail(`Source file changed during copy: ${sourceFile}`);
                } finally { await destFileHandle.close(); }
              } finally { await sourceFileHandle.close(); }
            }
            await assertPathIdentity(target, stageStat, "Destination stage");
        }
        if (!sameSnapshot(beforeDir, await dirHandle.stat())) fail(`Source directory changed during copy: ${sourcePath}`);
        await assertPathIdentity(target, stageStat, "Destination stage");
        if (!sameIdentity(destStat, await destHandle.stat())) fail("Destination directory changed during copy");
      };
      await walk(sourceHandle, source.directory, stageHandle);
      await assertPathIdentity(target, stageStat, "Destination stage");
      const metadata = await readSkillMetadata(fdPath(stageHandle.fd));
      return { sourcePath: source.directory, destinationPath: target, name: metadata.name, description: metadata.description, entries, bytes };
    } finally { await sourceHandle.close(); }
  } finally {
    await stageHandle?.close();
    await parentHandle.close();
  }
}
