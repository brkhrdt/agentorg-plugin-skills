import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { safeSourceGitWithTimeout } from "./git.ts";

export interface LocalGitCapture {
  root: string;
  gitDir: string;
  head: string;
  gitIdentity: { dev: number | bigint; ino: number | bigint };
}

/** Admit only a materialized repository root with a local .git directory and committed HEAD. */
export async function captureLocalGit(path: string, timeoutMs = 60_000): Promise<LocalGitCapture | undefined> {
  const root = await realpath(path).catch(() => undefined);
  if (!root) return undefined;
  const marker = join(root, ".git");
  const info = await lstat(marker).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return undefined;
  try {
    if (await safeSourceGitWithTimeout(root, timeoutMs, "rev-parse", "--show-toplevel") !== root) return undefined;
    if (await safeSourceGitWithTimeout(root, timeoutMs, "rev-parse", "--is-shallow-repository") !== "false") return undefined;
    const gitDir = await realpath(await safeSourceGitWithTimeout(root, timeoutMs, "rev-parse", "--absolute-git-dir"));
    if (gitDir !== marker) return undefined;
    const head = (await safeSourceGitWithTimeout(root, timeoutMs, "rev-parse", "--verify", "HEAD^{commit}")).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) return undefined;
    const after = await lstat(marker);
    if (after.dev !== info.dev || after.ino !== info.ino) return undefined;
    return { root, gitDir, head, gitIdentity: { dev: info.dev, ino: info.ino } };
  } catch { return undefined; }
}
