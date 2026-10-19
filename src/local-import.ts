import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { copyLocalSkill, resolveLocalSource } from "./local-source.ts";
import { initializeLocalSnapshot } from "./git.ts";
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
  gitTimeoutMs?: number;
  maxCatalogEntries: number;
  putJournal: (journal: LocalImportJournal) => void;
  publish: (record: CatalogSkill, identity: string, journalId: string) => Promise<void>;
  report?: (error: Error) => void;
  emit?: (record: CatalogSkill) => void;
}

/** Internal durable local-snapshot import primitive; deliberately has no request/auth/API surface. */
export class LocalSkillImporter {
  private readonly claims = new Set<string>();
  constructor(private readonly deps: LocalImporterDependencies) {}

  async import(input: unknown, pathOptions: { baseDir?: string; home?: string } = {}): Promise<CatalogSkill> {
    const centralRoot = await realpath(this.deps.centralRoot);
    const stageRoot = this.deps.stagingRoot;
    // Source resolution and canonicalization happen before creating any destination artifact.
    const source = await resolveLocalSource(input, { ...pathOptions, centralRoot });
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
    try {
      // Persist intent before creating the staging parent or destination tree.
      this.deps.putJournal(journal);
      await ensurePrivateStageRoot(stageRoot);
      journal.localImport.phase = "copying";
      this.deps.putJournal(journal);
      const copied = await copyLocalSkill(source.directory, stagingPath, {
        centralRoot, managedStagingRoot: stageRoot,
      });
      journal.localImport = { ...journal.localImport, phase: "copied", name: copied.name };
      this.deps.putJournal(journal);
      const before = await lstat(stagingPath);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Local snapshot stage identity is invalid");
      await initializeLocalSnapshot(stagingPath, this.deps.gitTimeoutMs ?? 60_000);
      const initialized = await lstat(stagingPath);
      if (!initialized.isDirectory() || initialized.isSymbolicLink() || before.dev !== initialized.dev || before.ino !== initialized.ino)
        throw new Error("Local snapshot stage changed during repository initialization");
      await checkCheckoutLimits(stagingPath);
      const after = await lstat(stagingPath);
      if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
        throw new Error("Local snapshot stage changed during repository validation");
      // Re-read copied metadata after Git initialized; name and instructions remain mandatory.
      const metadata = await readSkillMetadata(stagingPath);
      if (metadata.name !== copied.name || metadata.description !== copied.description) throw new Error("Local snapshot metadata changed during initialization");
      const record: CatalogSkill = {
        name: metadata.name, source: sourceRecord, description: metadata.description,
        path: stagingPath, createdAt: new Date().toISOString(),
      };
      journal.localImport = { ...journal.localImport, phase: "initialized", name: metadata.name };
      this.deps.putJournal(journal);
      await this.deps.publish(record, identity, id);
      this.deps.emit?.(record);
      return record;
    } catch (error) {
      const failure = new Error(`Local skill import retained at ${stagingPath}: ${(error as Error).message}`);
      this.deps.report?.(failure);
      throw failure;
    } finally { this.claims.delete(identity); }
  }
}

async function ensurePrivateStageRoot(path: string) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Local import staging root must be process-owned and private");
}
