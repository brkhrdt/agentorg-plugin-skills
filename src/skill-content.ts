import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as yaml } from "yaml";

export const MAX_SKILL_MD_BYTES = 128 * 1024;
export const MAX_SKILL_PAYLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_SKILL_ENTRIES = 20_000;

export async function readSkillMetadata(path: string, expectedName?: string): Promise<{ name: string; description: string }> {
  const file = join(path, "SKILL.md");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_MD_BYTES) throw new Error("Root SKILL.md must be a regular file under 128 KiB");
  const text = await readFile(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || !text.slice(match[0].length).trim()) throw new Error("SKILL.md requires YAML frontmatter and instructions");
  let data: any;
  try { data = yaml(match[1], { maxAliasCount: 0 }); }
  catch (error) { throw new Error(`Invalid SKILL.md YAML frontmatter: ${(error as Error).message}`); }
  if (!data || typeof data.name !== "string" || data.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || (expectedName !== undefined && data.name !== expectedName) ||
      typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024)
    throw new Error("SKILL.md name must match catalog name and description must contain 1–1024 characters");
  return { name: data.name, description: data.description };
}

/** Existing Git checkout guard: includes every entry (including Git metadata), preserving its shipped limits. */
export async function checkCheckoutLimits(path: string) {
  const queue = [path];
  let bytes = 0, count = 0;
  while (queue.length) {
    for (const entry of await readdir(queue.pop()!, { withFileTypes: true })) {
      const file = join(entry.parentPath, entry.name);
      if (++count > MAX_SKILL_ENTRIES) throw Object.assign(new Error("Skill checkout exceeds 20,000 entries"), { code: "LIMIT" });
      if (entry.isDirectory()) queue.push(file);
      else {
        bytes += (await lstat(file)).size;
        if (bytes > MAX_SKILL_PAYLOAD_BYTES) throw Object.assign(new Error("Skill checkout exceeds 256 MiB"), { code: "LIMIT" });
      }
    }
  }
}
