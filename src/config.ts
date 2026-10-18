import { z } from "zod";
import type { ServerSettingsDefinition } from "agent-organization/plugin";

const nameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const repositorySchema = z.object({ name: nameSchema, gitUrl: z.string().min(1).max(2048) }).strict();
const schema = z.object({
  repositories: z.array(repositorySchema).max(256),
  gitTimeoutMs: z.number().int().min(1_000).max(60_000),
  maxCatalogEntries: z.number().int().min(1).max(256),
}).strict();

export interface SkillsConfig extends Record<string, unknown> {
  repositories: Array<{ name: string; gitUrl: string }>;
  gitTimeoutMs: number;
  maxCatalogEntries: number;
}

/** The public settings surface deliberately excludes embedded-test source allowances. */
export function validateSkillsConfig(value: unknown): SkillsConfig {
  const parsed = schema.parse(value);
  const names = new Set<string>();
  const urls = new Set<string>();
  const repositories = parsed.repositories.map(({ name, gitUrl }) => {
    if (names.has(name)) throw new Error(`Duplicate skills repository name: ${name}`);
    names.add(name);
    if (/[\x00-\x20]/.test(gitUrl)) throw new Error("Invalid Git source");
    let url: URL;
    try { url = new URL(gitUrl); } catch { throw new Error("Use an HTTPS Git URL"); }
    // Explicit ports (including :443), credentials, redirects and non-canonical host/path forms are forbidden.
    const authority = gitUrl.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
    if (url.protocol !== "https:" || url.username || url.password || authority.includes(":") || url.search || url.hash ||
        !["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname) ||
        !/^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\/?$/.test(url.pathname) ||
        url.pathname.split("/").some(part => part === "." || part === ".."))
      throw new Error("Only HTTPS repositories on github.com, gitlab.com or bitbucket.org are supported (no credentials, ports, queries or redirects)");
    url.pathname = url.pathname.replace(/\/+$/, "");
    const canonical = url.toString();
    if (urls.has(canonical)) throw new Error(`Duplicate skills repository URL: ${canonical}`);
    urls.add(canonical);
    return { name, gitUrl: canonical };
  });
  return { repositories, gitTimeoutMs: parsed.gitTimeoutMs, maxCatalogEntries: parsed.maxCatalogEntries };
}

export const skillsStartupDefaults: SkillsConfig = Object.freeze({ repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 });

export function skillsServerSettings(): ServerSettingsDefinition {
  return {
    namespace: "skills",
    title: "Skills",
    description: "Repository seeds are imported at server startup. Removing a seed does not delete its catalog entry or installed agent data; repository changes take effect after restart.",
    version: 1,
    defaults: skillsStartupDefaults,
    fields: [
      { key: "repositories", label: "Repository seeds", editor: "list", effect: "restart", itemIdKey: "name", itemLabelKey: "name", itemDefaults: { name: "", gitUrl: "" },
        itemFields: [
          { key: "name", label: "Skill name", editor: "text", effect: "restart", description: "Lowercase letters, digits and hyphens; must match the repository SKILL.md name." },
          { key: "gitUrl", label: "HTTPS Git URL", editor: "text", effect: "restart", description: "Public HTTPS repository on github.com, gitlab.com or bitbucket.org. Restart imports missing seeds; removing a seed never deletes catalog data, clones or agent selections. Reusing a name for a different URL is a conflict." },
        ],
        description: "Repositories seeded into the persistent catalog at startup. Changes require a server restart; this is not a destructive mirror." },
      { key: "gitTimeoutMs", label: "Git timeout (ms)", editor: "number", min: 1_000, max: 60_000, effect: "immediate", description: "Timeout for subsequent Git work (1,000–60,000 ms)." },
      { key: "maxCatalogEntries", label: "Maximum catalog entries", editor: "number", min: 1, max: 256, effect: "immediate", description: "Admission limit for new catalog entries (1–256). Lowering it never removes existing entries." },
    ],
    validate: validateSkillsConfig,
  };
}
