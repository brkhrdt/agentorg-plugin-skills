import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { resolveLocalSource } from "./local-source.ts";
import { cloneRemoteRepository, safeSourceGitWithTimeout } from "./git.ts";
import { captureLocalGit } from "./local-git.ts";
import { checkCheckoutLimits, readSkillMetadata } from "./skill-content.ts";
import { sourceIdentity, type CatalogSkill, type SkillSource } from "./catalog.ts";

export interface LocalImporterDependencies {
  centralRoot: string;
  stagingRoot: string;
  gitTimeoutMs?: number | (() => number);
  publish: (record: CatalogSkill, identity: string) => Promise<void>;
  report?: (error: Error) => void;
  emit?: (record: CatalogSkill) => void;
  afterSourceResolved?: (sourcePath: string) => void | Promise<void>;
}

/** Admit a clean, committed Git worktree by cloning its current branch into private staging. */
export class LocalSkillImporter {
  private readonly claims = new Set<string>();
  constructor(private readonly deps: LocalImporterDependencies) {}

  async import(input: unknown, pathOptions: { baseDir?: string; home?: string } = {}): Promise<CatalogSkill> {
    const centralRoot = await realpath(this.deps.centralRoot);
    const source = await resolveLocalSource(input, { ...pathOptions, centralRoot });
    const capture = await captureLocalGit(source.directory);
    if (!capture) throw Object.assign(new Error("Skill source must be the root of an existing Git repository; plain directories are not accepted"), { code: "UNSUPPORTED_SOURCE" });
    const timeout = typeof this.deps.gitTimeoutMs === "function" ? this.deps.gitTimeoutMs() : this.deps.gitTimeoutMs ?? 60_000;
    const status = () => safeSourceGitWithTimeout(source.directory, timeout, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "status", "--porcelain", "--untracked-files=all");
    if (await status()) throw Object.assign(new Error("Local Git skill source must have a clean worktree; only committed content is admitted"), { code: "UNSUPPORTED_SOURCE" });
    const sourceRecord: SkillSource = { kind: "local", path: source.directory };
    const identity = sourceIdentity(sourceRecord);
    if (this.claims.has(identity)) throw Object.assign(new Error("Local source import is already in progress"), { code: "DUPLICATE" });
    this.claims.add(identity);
    const stage = join(this.deps.stagingRoot, randomUUID());
    try {
      await this.deps.afterSourceResolved?.(source.directory);
      await ensurePrivateStageRoot(this.deps.stagingRoot);
      await cloneRemoteRepository(source.directory, stage, timeout);
      if (await status()) throw Object.assign(new Error("Local Git source changed during registration"), { code: "INVALID_PATH" });
      const current = await captureLocalGit(source.directory);
      if (!current || current.gitIdentity.dev !== capture.gitIdentity.dev || current.gitIdentity.ino !== capture.gitIdentity.ino ||
          current.gitDir !== capture.gitDir || current.head !== capture.head)
        throw Object.assign(new Error("Local Git source changed during registration"), { code: "INVALID_PATH" });
      await checkCheckoutLimits(stage);
      const metadata = await readSkillMetadata(stage);
      const stageInfo = await lstat(stage);
      if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw Object.assign(new Error("Local Git clone stage identity is invalid"), { code: "INVALID_PATH" });
      const record: CatalogSkill = { name: metadata.name, source: sourceRecord, description: metadata.description, path: stage, createdAt: new Date().toISOString() };
      await this.deps.publish(record, identity);
      try { this.deps.emit?.(record); } catch (error) { this.deps.report?.(new Error(`Registered ${record.name}, but its catalog notification failed: ${(error as Error).message}`)); }
      return record;
    } catch (error) {
      const code = (error as any)?.code ?? "INTERNAL";
      const failure = Object.assign(new Error(`Local skill registration failed at ${stage}: ${(error as Error).message}`), { code });
      if (!this.deps.report || ["INVALID_PARAMS", "INVALID_PATH", "UNSUPPORTED_SOURCE", "DUPLICATE", "LIMIT"].includes(code)) throw failure;
      try { this.deps.report(failure); } catch { /* Diagnostics are best effort. */ }
      throw failure;
    } finally { this.claims.delete(identity); }
  }
}

async function ensurePrivateStageRoot(path: string) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw Object.assign(new Error("Local import staging root must be process-owned and private"), { code: "INVALID_PATH" });
}
