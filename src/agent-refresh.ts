import { lstat, rename, rm } from "node:fs/promises";

export interface GenerationMove { from: string; to: string; generation: string }
export async function removeVerifiedStage(path: string, identity: { device: number; inode: number }, verify: (path: string) => Promise<void>): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.device || info.ino !== identity.inode)
    throw new Error(`Unverified staged checkout retained: ${path}`);
  await verify(path);
  await rm(path, { recursive: true, force: false });
}

/** Replay one journaled generation move. A destination already owned by that
 * generation is the committed state even if the source path is now occupied by
 * another generation (the normal state after both refresh renames). */
export async function replayGenerationMove(
  action: GenerationMove,
  exists: (path: string) => Promise<boolean>,
  verify: (path: string, generation: string) => Promise<void>,
  ensureParent: (path: string) => Promise<void>,
): Promise<void> {
  if (await exists(action.to)) {
    await verify(action.to, action.generation);
    return;
  }
  if (!await exists(action.from)) throw new Error(`Missing generation ${action.generation} at both move paths`);
  await verify(action.from, action.generation);
  await ensureParent(action.to);
  await rename(action.from, action.to);
  await verify(action.to, action.generation);
}
