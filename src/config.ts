import { z } from "zod";
import type { ServerSettingsDefinition } from "agent-organization/plugin";

const schema = z.object({
  directory: z.string().min(1).max(4096).refine(value => !value.includes("\0"), "Directory path contains NUL").default("skills"),
  gitTimeoutMs: z.number().int().min(1_000).max(60_000),
  maxCatalogEntries: z.number().int().min(1).max(256),
}).strict();

export interface SkillsConfig extends Record<string, unknown> {
  /** Server-side repository container; relative paths resolve against host.dataDir. */
  directory: string;
  gitTimeoutMs: number;
  maxCatalogEntries: number;
}

export function canonicalSkillRepositoryUrl(gitUrl: string): string {
  if (gitUrl.length > 2048 || /[\x00-\x20]/.test(gitUrl)) throw new Error("Invalid Git source");
  let url: URL;
  try { url = new URL(gitUrl); } catch { throw new Error("Use an HTTPS Git URL"); }
  const authority = gitUrl.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || url.protocol !== "https:" || url.username || url.password || authority.includes(":") || url.search || url.hash ||
      !["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname) ||
      !/^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\/?$/.test(url.pathname) ||
      url.pathname.split("/").some(part => part === "." || part === ".."))
    throw new Error("Only HTTPS repositories on github.com, gitlab.com or bitbucket.org are supported (no credentials, ports, queries or redirects)");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function validateSkillsConfig(value: unknown): SkillsConfig {
  const parsed = schema.parse(value);
  return { directory: parsed.directory, gitTimeoutMs: parsed.gitTimeoutMs, maxCatalogEntries: parsed.maxCatalogEntries };
}

export const skillsStartupDefaults: SkillsConfig = Object.freeze({ directory: "skills", gitTimeoutMs: 60_000, maxCatalogEntries: 256 });

export function skillsServerSettings(): ServerSettingsDefinition {
  return {
    namespace: "skills", title: "Skills",
    description: "A server-side directory of immediate-child Git repositories. Store path changes require restart; installations remain independent.",
    version: 2, defaults: skillsStartupDefaults,
    fields: [
      { key: "directory", label: "Skills store directory", editor: "text", effect: "restart", description: "Server-side container of immediate-child Git skill repositories. Relative paths resolve against the server data directory; default: <dataDir>/skills." },
      { key: "gitTimeoutMs", label: "Git timeout (ms)", editor: "number", min: 1_000, max: 60_000, effect: "immediate", description: "Timeout for bounded Git operations (1,000–60,000 ms)." },
      { key: "maxCatalogEntries", label: "Maximum catalog entries", editor: "number", min: 1, max: 256, effect: "immediate", description: "Maximum number of discovered/admitted skills (1–256)." },
    ],
    validate: value => validateSkillsConfig(value),
  };
}
