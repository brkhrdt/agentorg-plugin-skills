import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { copyLocalSkill, resolveLocalSource } from "./local-source.ts";
import { initializeLocalSnapshot, managedHead } from "./git.ts";
import { captureLocalGit, importLocalGitHistory } from "./local-history.ts";
import { checkCheckoutLimits, readSkillMetadata } from "./skill-content.ts";
import { sourceIdentity, type CatalogSkill } from "./catalog.ts";
import type { SkillSource } from "./catalog.ts";

export interface LocalImportJournal {
  id: string; agentId: "catalog"; revision: 0; actions: [];
  path: string;
  source: { source: SkillSource };
  localImport: { phase: "intent" | "copying" | "copied" | "initialized"; sourcePath: string; stagingPath: string; name?: string };
}
export interface LocalImporterDependencies {
  centralRoot: string;
  stagingRoot: string;
  gitTimeoutMs?: number | (() => number);
  maxCatalogEntries: number;
  putJournal: (journal: LocalImportJournal) => void;
  publish: (record: CatalogSkill, identity: string, journalId: string, unified: boolean) => Promise<void>;
  report?: (error: Error) => void;
  emit?: (record: CatalogSkill) => void;
  afterSourceResolved?: (sourcePath: string) => void | Promise<void>;
}

/** Internal durable local-snapshot import primitive; deliberately has no request/auth/API surface. */
export class LocalSkillImporter {
  private readonly claims = new Set<string>();
  constructor(private readonly deps: LocalImporterDependencies) {}

  async import(input: unknown, pathOptions: { baseDir?: string; home?: string } = {}, unified = false): Promise<CatalogSkill> {
    const centralRoot = await realpath(this.deps.centralRoot);
    const stageRoot = this.deps.stagingRoot;
    // Source resolution and canonicalization happen before creating any destination artifact.
    const source = await resolveLocalSource(input, { ...pathOptions, centralRoot });
    const gitCapture = await captureLocalGit(source.directory);
    const sourceRecord: SkillSource = { kind: "local", path: source.directory };
    const identity = sourceIdentity(sourceRecord);
    if (this.claims.has(identity)) throw Object.assign(new Error("Local source import is already in progress"), { code: "DUPLICATE" });
    this.claims.add(identity);
    const id = `local-import-${randomUUID()}`;
    const stagingPath = join(stageRoot, randomUUID());
    const journal: LocalImportJournal = {
      id, agentId: "catalog", revision: 0, actions: [], path: stagingPath,
      source: { source: sourceRecord },
      localImport: { phase: "intent", sourcePath: source.directory, stagingPath },
    };
    let committedRecord: CatalogSkill | undefined;
    try {
    try {
      // Persist intent before creating the staging parent or destination tree.
      this.deps.putJournal(journal);
      await this.deps.afterSourceResolved?.(source.directory);
      await ensurePrivateStageRoot(stageRoot);
      journal.localImport.phase = "copying";
      this.deps.putJournal(journal);
      const copied = await copyLocalSkill(source.directory, stagingPath, {
        centralRoot, managedStagingRoot: stageRoot,
      });
      if (copied.sourcePath !== source.directory) throw Object.assign(new Error("Local source path changed after provenance was captured"), { code: "INVALID_PATH" });
      if (gitCapture) {
        const current = await captureLocalGit(source.directory);
        if (!current || current.gitIdentity.dev !== gitCapture.gitIdentity.dev || current.gitIdentity.ino !== gitCapture.gitIdentity.ino ||
            current.objectsIdentity.dev !== gitCapture.objectsIdentity.dev || current.objectsIdentity.ino !== gitCapture.objectsIdentity.ino || current.objectManifest !== gitCapture.objectManifest ||
            current.head.ref !== gitCapture.head.ref || current.head.oid !== gitCapture.head.oid ||
            JSON.stringify([...current.refs].sort()) !== JSON.stringify([...gitCapture.refs].sort()))
          throw Object.assign(new Error("Local Git refs changed during import"), { code: "INVALID_PATH" });
      }
      journal.localImport = { ...journal.localImport, phase: "copied", name: copied.name };
      this.deps.putJournal(journal);
      const before = await lstat(stagingPath);
      if (!before.isDirectory() || before.isSymbolicLink()) throw Object.assign(new Error("Local snapshot stage identity is invalid"), { code: "INVALID_PATH" });
      const timeout = typeof this.deps.gitTimeoutMs === "function" ? this.deps.gitTimeoutMs() : this.deps.gitTimeoutMs;
      const history = gitCapture
        ? await importLocalGitHistory(gitCapture, stagingPath, timeout ?? 60_000)
        : (await initializeLocalSnapshot(stagingPath, timeout ?? 60_000), undefined);
      const initialized = await lstat(stagingPath);
      if (!initialized.isDirectory() || initialized.isSymbolicLink() || before.dev !== initialized.dev || before.ino !== initialized.ino)
        throw Object.assign(new Error("Local snapshot stage changed during repository initialization"), { code: "INVALID_PATH" });
      await checkCheckoutLimits(stagingPath);
      const after = await lstat(stagingPath);
      if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
        throw Object.assign(new Error("Local snapshot stage changed during repository validation"), { code: "INVALID_PATH" });
      // Re-read copied metadata after Git initialized; name and instructions remain mandatory.
      const metadata = await readSkillMetadata(stagingPath);
      if (metadata.name !== copied.name || metadata.description !== copied.description) throw Object.assign(new Error("Local snapshot metadata changed during initialization"), { code: "INVALID_PATH" });
      const selectedCommit = history?.selected ?? await managedHead(stagingPath, timeout ?? 60_000);
      const record: CatalogSkill = {
        name: metadata.name, source: sourceRecord, description: metadata.description,
        path: stagingPath, createdAt: new Date().toISOString(),
        history: history ? { mode: "git-preserved", scope: "branches-tags-head-v1", selectedCommit, originalHead: history.originalHead, refCount: history.refCount, refManifest: history.manifest }
          : { mode: "directory-initialized", selectedCommit },
        catalogStatus: "active",
      };
      journal.localImport = { ...journal.localImport, phase: "initialized", name: metadata.name };
      this.deps.putJournal(journal);
      await this.deps.publish(record, identity, id, unified);
      committedRecord = record;
    } catch (error) {
      const code = (error as any)?.code ?? "INTERNAL";
      const failure = Object.assign(new Error(`Local skill import retained at ${stagingPath}: ${(error as Error).message}`), { code });
      if (!["INVALID_PARAMS", "INVALID_PATH", "UNSUPPORTED_SOURCE", "INCOMPLETE_HISTORY", "DUPLICATE", "LIMIT"].includes(code)) {
        try { this.deps.report?.(failure); } catch { /* Diagnostic failure cannot replace the import error. */ }
      }
      throw failure;
    }
    try { this.deps.emit?.(committedRecord!); }
    catch (error) {
      try { this.deps.report?.(new Error(`Local skill ${committedRecord!.name} was published, but its catalog event could not be emitted: ${(error as Error).message}`)); }
      catch { /* A post-commit notifier must not turn committed import into a reported import failure. */ }
    }
    return committedRecord!;
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
