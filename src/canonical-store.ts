import { cp, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { gitWithTimeout, validateManagedCheckout, validateRemoteHistory } from "./git.ts";
import { readSkillMetadata, checkCheckoutLimits } from "./skill-content.ts";

const contained = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Copy a legacy checkout to its stable name without changing/deleting the source.
 * Destination publication is atomic; an existing destination is accepted only if
 * it is a valid repository at the exact same commit with matching skill metadata. */
export async function rollbackCanonicalUpdate(canonicalPath: string, backup: string): Promise<void> {
  const canonical = resolve(canonicalPath), saved = resolve(backup);
  if (dirname(canonical) !== dirname(saved) || !basename(saved).startsWith(`.skills-backup-${basename(canonical)}-`))
    throw new Error("Refusing to restore an unverified canonical backup");
  const failed = join(dirname(canonical), `.skills-failed-${basename(canonical)}-${randomUUID()}`);
  await rename(canonical, failed);
  try { await rename(saved, canonical); }
  catch (error) { await rename(failed, canonical); throw error; }
}

async function withCanonicalLock<T>(path: string, work: (canonicalPath: string) => Promise<T>): Promise<T> {
  const canonicalPath = await realpath(path), lock = join(dirname(canonicalPath), `.skills-lock-${basename(canonicalPath)}`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("Canonical repository is being updated; retry later"), { code: "LOCKED" }); throw error; }
  try { return await work(canonicalPath); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function fastForwardCanonicalCheckout(args: { canonicalPath: string; source: string; expectedHead: string; timeoutMs?: number }, publish?: (result: { head: string; backup: string }) => Promise<void>): Promise<{ head: string; backup: string }> {
  return withCanonicalLock(args.canonicalPath, canonicalPath => fastForwardCanonicalCheckoutLocked({ ...args, canonicalPath }, publish));
}

async function fastForwardCanonicalCheckoutLocked(args: { canonicalPath: string; source: string; expectedHead: string; timeoutMs?: number }, publish?: (result: { head: string; backup: string }) => Promise<void>): Promise<{ head: string; backup: string }> {
  const timeout = args.timeoutMs ?? 60_000;
  if (!/^[0-9a-f]{40}$/.test(args.expectedHead)) throw new Error("Expected HEAD must be a full commit ID");
  const canonicalPath = await realpath(args.canonicalPath);
  const head = await gitWithTimeout(canonicalPath, timeout, "rev-parse", "HEAD");
  if (head !== args.expectedHead) throw Object.assign(new Error("Canonical HEAD changed; refresh before updating"), { code: "CONFLICT" });
  if (await gitWithTimeout(canonicalPath, timeout, "status", "--porcelain", "--untracked-files=all")) throw Object.assign(new Error("Canonical worktree is dirty; commit or preserve changes before updating"), { code: "DIRTY_WORKTREE" });
  const parent = dirname(canonicalPath);
  const stage = join(parent, `.skills-update-${randomUUID()}`);
  const backup = join(parent, `.skills-backup-${basename(canonicalPath)}-${randomUUID()}`);
  await gitWithTimeout(parent, timeout, "clone", "--no-hardlinks", "--no-local", "--no-checkout", "--", canonicalPath, stage);
  try {
    await gitWithTimeout(stage, timeout, "checkout", "--force", "HEAD");
    await gitWithTimeout(stage, timeout, "remote", "add", "skills-update", args.source);
    await gitWithTimeout(stage, timeout, "fetch", "--no-tags", "skills-update", "HEAD");
    const candidate = await gitWithTimeout(stage, timeout, "rev-parse", "--verify", "FETCH_HEAD^{commit}");
    const ancestor = await gitWithTimeout(stage, timeout, "merge-base", "--is-ancestor", head, candidate).then(() => true, () => false);
    if (!ancestor) throw Object.assign(new Error("Upstream update is not a fast-forward; canonical repository left unchanged"), { code: "NON_FAST_FORWARD" });
    await gitWithTimeout(stage, timeout, "merge", "--ff-only", candidate);
    await validateRemoteHistory(stage, timeout);
    await validateManagedCheckout(stage, timeout);
    await gitWithTimeout(stage, timeout, "remote", "remove", "skills-update");
    await gitWithTimeout(stage, timeout, "remote", "set-url", "origin", args.source);
    await checkCheckoutLimits(stage);
    const name = basename(canonicalPath), parsed = await readSkillMetadata(stage, name);
    if (parsed.name !== name) throw new Error("Updated skill metadata changes its canonical name");
    if (await gitWithTimeout(canonicalPath, timeout, "rev-parse", "HEAD") !== head || await gitWithTimeout(canonicalPath, timeout, "status", "--porcelain", "--untracked-files=all"))
      throw Object.assign(new Error("Canonical repository changed during update; candidate retained without publication"), { code: "CONFLICT" });
    if (await realpath(args.canonicalPath) !== canonicalPath) throw Object.assign(new Error("Canonical path identity changed during update"), { code: "CONFLICT" });
    await rename(canonicalPath, backup);
    try { await rename(stage, canonicalPath); }
    catch (error) { await rename(backup, canonicalPath); throw error; }
    const result = { head: candidate, backup };
    try { await publish?.(result); }
    catch (error) { await rollbackCanonicalUpdate(canonicalPath, backup); throw error; }
    return result;
  } catch (error) {
    // Keep the isolated stage and all fetched data for diagnosis; canonical is not changed.
    throw error;
  }
}

export async function prepareCanonicalRevert(args: { canonicalPath: string; expectedHead: string; targetCommit: string; timeoutMs?: number }, publish?: (result: { head: string; backup: string }) => Promise<void>): Promise<{ head: string; backup: string }> {
  return withCanonicalLock(args.canonicalPath, canonicalPath => prepareCanonicalRevertLocked({ ...args, canonicalPath }, publish));
}

async function prepareCanonicalRevertLocked(args: { canonicalPath: string; expectedHead: string; targetCommit: string; timeoutMs?: number }, publish?: (result: { head: string; backup: string }) => Promise<void>): Promise<{ head: string; backup: string }> {
  const timeout = args.timeoutMs ?? 60_000;
  if (!/^[0-9a-f]{40}$/.test(args.expectedHead) || !/^[0-9a-f]{40}$/.test(args.targetCommit)) throw new Error("Commit IDs must be full SHA-1 object IDs");
  const canonicalPath = await realpath(args.canonicalPath);
  if (await gitWithTimeout(canonicalPath, timeout, "rev-parse", "HEAD") !== args.expectedHead) throw Object.assign(new Error("Canonical HEAD changed; refresh before reverting"), { code: "CONFLICT" });
  if (await gitWithTimeout(canonicalPath, timeout, "status", "--porcelain", "--untracked-files=all")) throw Object.assign(new Error("Canonical worktree is dirty; commit or preserve changes before reverting"), { code: "DIRTY_WORKTREE" });
  const target = await gitWithTimeout(canonicalPath, timeout, "rev-parse", "--verify", `${args.targetCommit}^{commit}`);
  if (target !== args.targetCommit) throw new Error("Revert target is not a commit in canonical history");
  const parent = dirname(canonicalPath), name = basename(canonicalPath);
  const stage = join(parent, `.skills-revert-${name}-${randomUUID()}`);
  const backup = join(parent, `.skills-backup-${name}-revert-${randomUUID()}`);
  await gitWithTimeout(parent, timeout, "clone", "--no-hardlinks", "--no-local", "--no-checkout", "--", canonicalPath, stage);
  try {
    const upstream = await gitWithTimeout(stage, timeout, "remote", "get-url", "origin").catch(() => "");
    await gitWithTimeout(stage, timeout, "checkout", "--detach", "--force", target);
    await validateRemoteHistory(stage, timeout);
    await validateManagedCheckout(stage, timeout);
    await checkCheckoutLimits(stage);
    const metadata = await readSkillMetadata(stage, name);
    if (metadata.name !== name) throw new Error("Revert target changes canonical skill identity");
    if (upstream) await gitWithTimeout(stage, timeout, "remote", "set-url", "origin", upstream);
    if (await gitWithTimeout(canonicalPath, timeout, "rev-parse", "HEAD") !== args.expectedHead ||
        await gitWithTimeout(canonicalPath, timeout, "status", "--porcelain", "--untracked-files=all"))
      throw Object.assign(new Error("Canonical repository changed during revert; candidate retained without publication"), { code: "CONFLICT" });
    if (await realpath(args.canonicalPath) !== canonicalPath) throw Object.assign(new Error("Canonical path identity changed during revert"), { code: "CONFLICT" });
    await rename(canonicalPath, backup);
    try { await rename(stage, canonicalPath); }
    catch (error) { await rename(backup, canonicalPath); throw error; }
    const result = { head: target, backup };
    try { await publish?.(result); }
    catch (error) { await rollbackCanonicalUpdate(canonicalPath, backup); throw error; }
    return result;
  } catch (error) {
    throw error;
  }
}

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
