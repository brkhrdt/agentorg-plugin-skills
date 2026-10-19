import type { Database } from "bun:sqlite";

export type SkillSource = { kind: "git"; gitUrl: string } | { kind: "local"; path: string };
export interface CatalogSkill {
  name: string;
  source: SkillSource;
  /** Compatibility field: present only for Git sources. */
  gitUrl?: string;
  description: string;
  createdAt: string;
  /** Central managed checkout, never the original local source. */
  path: string;
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
  source?: { name: string; source: SkillSource };
}

const fail = (message: string): never => { throw new Error(`Invalid skills catalog: ${message}`); };
function parseSkill(raw: string, url: string | null): CatalogSkill {
  let value: any;
  try { value = JSON.parse(raw); } catch { return fail("malformed catalog JSON"); }
  if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.description !== "string" ||
      typeof value.createdAt !== "string" || typeof value.path !== "string") return fail("malformed catalog record");
  const source: SkillSource = value.source ?? (typeof value.gitUrl === "string" ? { kind: "git", gitUrl: value.gitUrl } :
    typeof url === "string" ? { kind: "git", gitUrl: url } : fail(`record ${value.name} has no source`));
  if (source?.kind === "git") {
    if (typeof source.gitUrl !== "string" || source.gitUrl.length === 0 || (value.gitUrl !== undefined && value.gitUrl !== source.gitUrl)) return fail(`invalid Git source for ${value.name}`);
    value.source = { kind: "git", gitUrl: source.gitUrl };
    value.gitUrl = source.gitUrl;
  } else if (source?.kind === "local") {
    if (typeof source.path !== "string" || !source.path) return fail(`invalid local source for ${value.name}`);
    value.source = { kind: "local", path: source.path };
    delete value.gitUrl;
  } else return fail(`unknown source kind for ${value.name}`);
  return value as CatalogSkill;
}

/** Transactional, idempotent schema upgrade. It only rewrites ledger JSON; it never probes or mutates filesystem paths. */
export function migrateCatalog(db: Database): number {
  const versionRows = db.query("SELECT version FROM meta").all() as Array<{ version: number }>;
  if (versionRows.length !== 1 || !Number.isInteger(versionRows[0]!.version) || versionRows[0]!.version < 1) return fail("invalid schema version");
  const version = versionRows[0]!.version;
  if (version > 3) return fail(`unsupported schema version ${version}`);
  try {
    db.transaction(() => {
      for (const row of db.query("SELECT name,url,data FROM catalog ORDER BY name").all() as Array<{ name: string; url: string | null; data: string }>) {
        const value = parseSkill(row.data, row.url);
        if (value.name !== row.name) fail(`catalog key/name mismatch for ${row.name}`);
        db.query("UPDATE catalog SET data=? WHERE name=?").run(JSON.stringify(value), row.name);
      }
      // Accept and preserve both current journal shape and pre-provenance Git journal payloads.
      for (const row of db.query("SELECT id,data FROM journal").all() as Array<{ id: string; data: string }>) {
        let journal: any;
        try { journal = JSON.parse(row.data); } catch { return fail(`malformed journal ${row.id}`); }
        if (!journal || typeof journal !== "object" || typeof journal.id !== "string" || !Array.isArray(journal.actions)) fail(`malformed journal ${row.id}`);
      }
      if (version < 3) db.query("UPDATE meta SET version=3").run();
    })();
  } catch (error) { throw error; }
  return 3;
}

/** Identity encoded in catalog.url; JSON tuple avoids separator and prefix collisions. */
export const sourceIdentity = (source: SkillSource): string => source.kind === "git"
  ? source.gitUrl
  : `local:${JSON.stringify([source.path])}`;
