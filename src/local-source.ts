import { constants, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { MAX_SKILL_ENTRIES, MAX_SKILL_MD_BYTES, MAX_SKILL_PAYLOAD_BYTES, readSkillMetadata } from "./skill-content.ts";

export interface LocalSourceOptions { baseDir?: string; home?: string; centralRoot?: string }
export interface ResolvedLocalSource { directory: string; skillFile: string }
export interface LocalCopyOptions extends LocalSourceOptions {
  /** Test seam for deterministic mid-copy failures; a failed stage is deliberately retained. */
  beforeCopyFile?: (source: string, destination: string) => void | Promise<void>;
}
export interface LocalCopyResult { sourcePath: string; destinationPath: string; name: string; description: string; entries: number; bytes: number }
const fail = (message: string, code = "INVALID_PARAMS"): never => { throw Object.assign(new Error(message), { code }); };
const MAX_PATH_LENGTH = 4096;

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function overlaps(a: string, b: string): boolean { return within(a, b) || within(b, a); }

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
  if (suppliedInfo!.isSymbolicLink() && expanded.split(sep).at(-1) === "SKILL.md") fail("Root SKILL.md must not be a symlink");
  let canonical = "";
  try { canonical = await realpath(expanded); } catch (error) { fail(`Cannot resolve local skill path: ${(error as Error).message}`); }
  let info;
  try { info = await lstat(canonical); } catch (error) { fail(`Cannot inspect local skill path: ${(error as Error).message}`); }
  let directory = "";
  if (info!.isDirectory()) directory = canonical;
  else if (info!.isFile() && !info!.isSymbolicLink() && canonical.split(sep).at(-1) === "SKILL.md") directory = dirname(canonical);
  else fail("Local source must be a directory or its root SKILL.md");
  const skillFile = join(directory, "SKILL.md");
  const skillInfo = await lstat(skillFile).catch(() => undefined);
  if (!skillInfo?.isFile() || skillInfo.isSymbolicLink()) fail("Root SKILL.md must be a regular non-symlink file");
  if (options.centralRoot) {
    const central = await realpath(options.centralRoot);
    if (overlaps(central, directory)) fail("Local source must not overlap the managed central skills directory");
  }
  return { directory, skillFile };
}

function sameSnapshot(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Copy to a fresh, exclusive private stage. Partial owned stages are intentionally retained on errors. */
export async function copyLocalSkill(input: unknown, destination: string, options: LocalCopyOptions = {}): Promise<LocalCopyResult> {
  const source = await resolveLocalSource(input, options);
  const targetParent = await realpath(dirname(resolve(destination))).catch((error) => fail(`Destination parent must exist: ${(error as Error).message}`));
  const target = join(targetParent, resolve(destination).split(sep).at(-1)!);
  if (overlaps(source.directory, target)) fail("Source and destination directories must not overlap");
  if (options.centralRoot && overlaps(await realpath(options.centralRoot), target)) fail("Destination must not overlap the managed central skills directory");
  try { await mkdir(target, { mode: 0o700 }); } catch (error: any) {
    if (error.code === "EEXIST") fail(`Destination already exists: ${target}`, "DUPLICATE");
    throw error;
  }
  await chmod(target, 0o700);

  let entries = 0, bytes = 0;
  const walk = async (from: string, to: string): Promise<void> => {
    const beforeDir = await lstat(from);
    if (!beforeDir.isDirectory() || beforeDir.isSymbolicLink()) fail(`Unsafe source directory: ${from}`);
    const children = await readdir(from);
    for (const name of children) {
      if (name === ".git") continue;
      const sourcePath = join(from, name), destinationPath = join(to, name);
      const before = await lstat(sourcePath);
      if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) fail(`Unsupported source entry: ${sourcePath}`);
      if (++entries > MAX_SKILL_ENTRIES) fail("Local skill exceeds 20,000 entries", "LIMIT");
      if (before.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await walk(sourcePath, destinationPath);
        if (!sameSnapshot(before, await lstat(sourcePath))) fail(`Source directory changed during copy: ${sourcePath}`);
      } else {
        if (name === "SKILL.md" && from === source.directory && before.size > MAX_SKILL_MD_BYTES) fail("Root SKILL.md exceeds 128 KiB", "LIMIT");
        bytes += before.size;
        if (bytes > MAX_SKILL_PAYLOAD_BYTES) fail("Local skill exceeds 256 MiB", "LIMIT");
        await options.beforeCopyFile?.(sourcePath, destinationPath);
        const outputMode = before.mode & 0o111 ? 0o700 : 0o600;
        const sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        await pipeline(sourceHandle.createReadStream(), createWriteStream(destinationPath, { flags: "wx", mode: outputMode }));
        await chmod(destinationPath, outputMode);
        const after = await lstat(sourcePath);
        if (!sameSnapshot(before, after)) fail(`Source file changed during copy: ${sourcePath}`);
      }
    }
    if (!sameSnapshot(beforeDir, await lstat(from))) fail(`Source directory changed during copy: ${from}`);
  };
  await walk(source.directory, target);
  const metadata = await readSkillMetadata(target);
  return { sourcePath: source.directory, destinationPath: target, name: metadata.name, description: metadata.description, entries, bytes };
}
