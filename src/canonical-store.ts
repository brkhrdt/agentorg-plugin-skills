import { cp, lstat, mkdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { gitWithTimeout } from "./git.ts";
import { readSkillMetadata, checkCheckoutLimits } from "./skill-content.ts";

const contained = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Copy a legacy checkout to its stable name without changing/deleting the source.
 * Destination publication is atomic; an existing destination is accepted only if
 * it is a valid repository at the exact same commit with matching skill metadata. */
export async function migrateCanonicalCheckout(args: {
  name: string; source: string; legacyRoot: string; canonicalRoot: string; timeoutMs?: number;
}): Promise<string> {
  const { name } = args;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("Invalid canonical skill name");
  const legacyRoot = await realpath(args.legacyRoot), source = await realpath(args.source);
  const canonicalRoot = resolve(args.canonicalRoot);
  const destination = join(canonicalRoot, name);
  const alreadyCanonical = source === resolve(destination);
  if (!alreadyCanonical && !contained(legacyRoot, source)) throw new Error("Legacy checkout is outside the verified plugin-owned root");
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Legacy checkout is not a real directory");
  await mkdir(canonicalRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(canonicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Canonical skills root must be a real directory");
  const timeout = args.timeoutMs ?? 60_000;
  const sourceHead = await gitWithTimeout(source, timeout, "rev-parse", "HEAD");
  const verify = async (path: string) => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Canonical checkout is not a real directory");
    if (await gitWithTimeout(path, timeout, "rev-parse", "--show-toplevel") !== await realpath(path)) throw new Error("Canonical checkout root mismatch");
    if (await gitWithTimeout(path, timeout, "rev-parse", "HEAD") !== sourceHead) throw new Error("Canonical destination conflicts with legacy HEAD");
    await gitWithTimeout(path, timeout, "fsck", "--full", "--strict", "--no-reflogs", "--no-dangling");
    await checkCheckoutLimits(path);
    const metadata = await readSkillMetadata(path, name);
    if (metadata.name !== name) throw new Error("Canonical skill metadata name mismatch");
  };
  if (alreadyCanonical) { await verify(destination); return destination; }
  try {
    await lstat(destination);
    await verify(destination);
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stage = join(canonicalRoot, `.migration-${name}-${randomUUID()}`);
  try {
    await cp(source, stage, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    await verify(stage);
    await rename(stage, destination);
    await verify(destination);
    return destination;
  } catch (error) {
    // Keep failed staging data for diagnosis; never remove the legacy source.
    throw new Error(`Canonical migration for ${name} failed; legacy checkout remains at ${source}: ${(error as Error).message}`);
  }
}
