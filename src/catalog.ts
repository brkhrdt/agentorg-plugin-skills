import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";

export type SkillSource = { kind: "git"; gitUrl: string } | { kind: "local"; path: string };
export interface SkillHistory {
  mode: "git-preserved" | "directory-initialized" | "legacy-snapshot" | "legacy-git";
  scope?: "branches-tags-head-v1";
  selectedCommit?: string;
  originalHead?: string;
  refCount?: number;
  refManifest?: string;
}
export interface CatalogSkill {
  name: string;
  source: SkillSource;
  /** Compatibility field: present only for Git sources. */
  gitUrl?: string;
  description: string;
  createdAt: string;
  /** Central managed checkout, never the original local source. */
  path: string;
  history: SkillHistory;
  /** Reversible retirement hides manual entries from new grants without deleting identity or files. */
  catalogStatus?: "active" | "retired";
}
export interface CatalogJournal {
  id: string;
  agentId: string;
  revision: number;
  actions: unknown[];
  path?: string;
  /** Legacy Git journal payload retained for backwards decoding. */
  repository?: { name: string; gitUrl: string };
  /** New source-neutral representation for future catalog imports. */
  source?: { name?: string; source: SkillSource };
  localImport?: { phase: "intent" | "copying" | "copied" | "initialized"; sourcePath: string; stagingPath: string; name?: string };
}

const fail = (message: string): never => { throw new Error(`Invalid skills catalog: ${message}`); };
function decodeSource(input: any, label: string): SkillSource {
  if (input?.kind === "git" && typeof input.gitUrl === "string" && input.gitUrl.length > 0) return { kind: "git", gitUrl: input.gitUrl };
  if (input?.kind === "local" && typeof input.path === "string" && input.path.length > 0) return { kind: "local", path: input.path };
  return fail(`malformed source for ${label}`);
}
function parseSkill(raw: string, url: string | null): CatalogSkill {
  let value: any;
  try { value = JSON.parse(raw); } catch { return fail("malformed catalog JSON"); }
  if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.description !== "string" ||
      typeof value.createdAt !== "string" || typeof value.path !== "string") return fail("malformed catalog record");
  const source = decodeSource(value.source ?? (typeof value.gitUrl === "string" ? { kind: "git", gitUrl: value.gitUrl } :
    typeof url === "string" ? { kind: "git", gitUrl: url } : undefined), value.name);
  if (value.catalogStatus === undefined) value.catalogStatus = "active";
  if (value.catalogStatus !== "active" && value.catalogStatus !== "retired") return fail(`malformed catalog status for ${value.name}`);
  if (!value.history) value.history = source.kind === "local" ? { mode: "legacy-snapshot" } : { mode: "legacy-git" };
  const history = value.history;
  if (!history || typeof history !== "object" || !["git-preserved", "directory-initialized", "legacy-snapshot", "legacy-git"].includes(history.mode)) return fail(`malformed history for ${value.name}`);
  const oid = (item: unknown) => typeof item === "string" && /^[0-9a-f]{40}$/.test(item);
  if (history.mode === "git-preserved" && (history.scope !== "branches-tags-head-v1" || !oid(history.selectedCommit) ||
      history.originalHead !== undefined && !oid(history.originalHead) || !Number.isInteger(history.refCount) || history.refCount < 1 || history.refCount > 4097 ||
      typeof history.refManifest !== "string" || !/^[0-9a-f]{64}$/.test(history.refManifest))) return fail(`malformed preserved history for ${value.name}`);
  if (history.mode === "directory-initialized" && !oid(history.selectedCommit)) return fail(`malformed initialized history for ${value.name}`);
  if (source.kind === "git") {
    if (value.gitUrl !== undefined && value.gitUrl !== source.gitUrl) return fail(`Git source mismatch for ${value.name}`);
    value.source = source;
    value.gitUrl = source.gitUrl;
  } else {
    if (value.gitUrl !== undefined) return fail(`local source has Git URL for ${value.name}`);
    value.source = source;
    delete value.gitUrl;
  }
  if (typeof url !== "string" || url !== sourceIdentity(source)) return fail(`catalog identity mismatch for ${value.name}`);
  return value as CatalogSkill;
}

/** Transactional, idempotent schema upgrade. It only rewrites ledger JSON; it never probes or mutates filesystem paths. */
export function migrateCatalog(db: Database): number {
  const versionRows = db.query("SELECT version FROM meta").all() as Array<{ version: number }>;
  if (versionRows.length !== 1 || !Number.isInteger(versionRows[0]!.version) || versionRows[0]!.version < 1) return fail("invalid schema version");
  const version = versionRows[0]!.version;
  if (version > 5) return fail(`unsupported schema version ${version}`);
  try {
    db.transaction(() => {
      const identities = new Map<string, string>();
      for (const row of db.query("SELECT name,url,data FROM catalog ORDER BY name").all() as Array<{ name: string; url: string | null; data: string }>) {
        const value = parseSkill(row.data, row.url);
        if (value.name !== row.name) fail(`catalog key/name mismatch for ${row.name}`);
        const identity = sourceIdentity(value.source);
        const prior = identities.get(identity);
        if (prior) fail(`duplicate source identity shared by ${prior} and ${row.name}`);
        identities.set(identity, row.name);
        db.query("UPDATE catalog SET data=? WHERE name=?").run(JSON.stringify(value), row.name);
      }
      // Validate all recovery-addressing fields before startup can act on any journal.
      for (const row of db.query("SELECT id,data FROM journal").all() as Array<{ id: string; data: string }>) {
        let journal: any;
        try { journal = JSON.parse(row.data); } catch { return fail(`malformed journal ${row.id}`); }
        if (!journal || typeof journal !== "object" || Array.isArray(journal) || journal.id !== row.id ||
            typeof journal.agentId !== "string" || !journal.agentId || !Number.isSafeInteger(journal.revision) || journal.revision < 0 || !Array.isArray(journal.actions))
          fail(`malformed journal identity/recovery header ${row.id}`);
        for (const action of journal.actions) {
          if (!action || typeof action !== "object" || Array.isArray(action) || typeof action.generation !== "string" ||
              !action.generation || typeof action.from !== "string" || !isAbsolute(action.from) || typeof action.to !== "string" || !isAbsolute(action.to) || typeof action.old !== "boolean")
            fail(`malformed recovery action in journal ${row.id}`);
        }
        if (journal.path !== undefined && (typeof journal.path !== "string" || !isAbsolute(journal.path))) fail(`malformed journal path ${row.id}`);
        if (journal.repository !== undefined && (!journal.repository || typeof journal.repository.name !== "string" || !journal.repository.name ||
            typeof journal.repository.gitUrl !== "string" || !journal.repository.gitUrl)) fail(`malformed legacy repository journal ${row.id}`);
        if (journal.source !== undefined) {
          if (!journal.source || (journal.source.name !== undefined && (typeof journal.source.name !== "string" || !journal.source.name))) fail(`malformed source journal ${row.id}`);
          decodeSource(journal.source.source, `journal ${row.id}`);
        }
        if (journal.localImport !== undefined) {
          const local = journal.localImport;
          if (!local || !["intent", "copying", "copied", "initialized"].includes(local.phase) ||
              typeof local.sourcePath !== "string" || !isAbsolute(local.sourcePath) || typeof local.stagingPath !== "string" || !isAbsolute(local.stagingPath) ||
              (local.name !== undefined && (typeof local.name !== "string" || !local.name))) fail(`malformed local import journal ${row.id}`);
          if (journal.path !== local.stagingPath) fail(`local import journal path mismatch ${row.id}`);
        }
        if (journal.canonicalPublication !== undefined) {
          const publication = journal.canonicalPublication;
          if (!publication || publication.phase !== "prepared" || publication.operationId !== journal.id ||
              typeof publication.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publication.name) ||
              ![publication.canonicalPath, publication.stage, publication.backup].every(value => typeof value === "string" && isAbsolute(value)) ||
              typeof publication.oldHead !== "string" || !/^[0-9a-f]{40}$/.test(publication.oldHead) ||
              typeof publication.head !== "string" || !/^[0-9a-f]{40}$/.test(publication.head) ||
              !publication.oldCatalog || publication.oldCatalog.name !== publication.name ||
              !publication.newCatalog || publication.newCatalog.name !== publication.name)
            fail(`malformed canonical-publication journal ${row.id}`);
        }
        if (journal.agentUpdate !== undefined) {
          const update = journal.agentUpdate;
          if (!update || !["staging", "swapping"].includes(update.phase) || typeof update.generation !== "string" || !update.generation ||
              typeof update.oldGeneration !== "string" || !update.oldGeneration || typeof update.destination !== "string" || !isAbsolute(update.destination) ||
              typeof update.backup !== "string" || !isAbsolute(update.backup) ||
              update.phase === "staging" && (typeof journal.path !== "string" || !isAbsolute(journal.path)) ||
              update.phase === "swapping" && journal.path !== undefined)
            fail(`malformed agent-update journal ${row.id}`);
        }
      }
      if (version < 5) db.query("UPDATE meta SET version=5").run();
    })();
  } catch (error) { throw error; }
  return 5;
}

/** Notifications cannot turn a committed catalog change into a reported mutation failure. */
export function notifyAfterCatalogCommit(emit: () => void, report: (error: unknown) => void): void {
  try { emit(); }
  catch (error) {
    try { report(error); }
    catch { /* Diagnostic delivery is also best-effort after publication. */ }
  }
}

/** Identity encoded in catalog.url; JSON tuple avoids separator and prefix collisions. */
export const sourceIdentity = (source: SkillSource): string => source.kind === "git"
  ? source.gitUrl
  : `local:${JSON.stringify([source.path])}`;
