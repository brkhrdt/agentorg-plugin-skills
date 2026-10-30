export type SkillSource = { kind: "git"; gitUrl: string } | { kind: "local"; path: string };
export interface CatalogSkill {
  name: string;
  source: SkillSource;
  gitUrl?: string;
  description: string;
  createdAt: string;
  path: string;
}

/** Notifications cannot turn a committed catalog change into a reported mutation failure. */
export function notifyAfterCatalogCommit(emit: () => void, report: (error: unknown) => void): void {
  try { emit(); }
  catch (error) {
    try { report(error); } catch { /* Best-effort diagnostics after publication. */ }
  }
}

export const sourceIdentity = (source: SkillSource): string => source.kind === "git"
  ? source.gitUrl
  : `local:${JSON.stringify([source.path])}`;
