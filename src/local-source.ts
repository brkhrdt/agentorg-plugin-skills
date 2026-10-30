import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LocalSourceOptions {
  baseDir?: string;
  home?: string;
  centralRoot?: string;
  /** Test seam for classifying root metadata lookup failures deterministically. */
  rootSkillLstat?: (path: string) => ReturnType<typeof lstat>;
}
export interface ResolvedLocalSource { directory: string; skillFile: string; device: number; inode: number }
const fail = (message: string, code = "INVALID_PATH"): never => { throw Object.assign(new Error(message), { code }); };
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
  let skillInfo: Awaited<ReturnType<typeof lstat>>;
  try { skillInfo = await (options.rootSkillLstat ?? lstat)(skillFile); }
  catch (error: any) {
    if (error?.code === "ENOENT")
      throw Object.assign(new Error("Local skill directory must contain a root SKILL.md"), { code: "INVALID_PARAMS", cause: error });
    throw Object.assign(new Error(`Cannot inspect root SKILL.md${error?.code ? ` (${error.code})` : ""}: ${error?.message ?? error}`),
      { code: "INVALID_PATH", cause: error });
  }
  if (!skillInfo.isFile() || skillInfo.isSymbolicLink()) fail("Root SKILL.md must be a regular non-symlink file", "INVALID_PATH");
  if (options.centralRoot) {
    const central = await realpath(options.centralRoot);
    if (overlaps(central, directory)) fail("Local source must not overlap the managed central skills directory");
  }
  return { directory, skillFile, device: directoryInfo!.dev, inode: directoryInfo!.ino };
}
