import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSkillImporter } from "../src/local-import.ts";
import { gitWithTimeout } from "../src/git.ts";
import { createLocalSkillFixture } from "./helpers/local-skill.ts";

test("admission rejects valid non-Git skill directories before creating artifacts; clean committed Git repos work", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await mkdtemp(join(tmpdir(), "skills-git-only-"));
  const central = join(root, "store"); await mkdir(central);
  const db = new Database(":memory:");
  db.exec("CREATE TABLE catalog(name TEXT PRIMARY KEY,url TEXT UNIQUE,data TEXT NOT NULL)");
  const importer = new LocalSkillImporter({
    centralRoot: central, stagingRoot: join(central, "stage"), gitTimeoutMs: 10_000,
    async publish(record, identity) { db.query("INSERT INTO catalog VALUES (?,?,?)").run(record.name, identity, JSON.stringify(record)); },
  });
  try {
    await expect(importer.import(fixture.path)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    expect(await Bun.file(join(central, "stage")).exists()).toBe(false);
    await gitWithTimeout(fixture.path, 10_000, "init");
    await gitWithTimeout(fixture.path, 10_000, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "-A");
    await gitWithTimeout(fixture.path, 10_000, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "skill");
    await writeFile(join(fixture.path, "SKILL.md"), "dirty but valid metadata");
    await expect(importer.import(fixture.path)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    await gitWithTimeout(fixture.path, 10_000, "checkout", "--", "SKILL.md");
    const result = await importer.import(fixture.path);
    expect(result.name).toBe("fixture-skill");
    expect(await gitWithTimeout(result.path, 10_000, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(await gitWithTimeout(result.path, 10_000, "branch", "--all")).toContain("master");
    expect(await gitWithTimeout(result.path, 10_000, "tag", "--list")).toBe("");
    expect(await gitWithTimeout(result.path, 10_000, "status", "--porcelain")).toBe("");
    expect(db.query("SELECT COUNT(*) AS n FROM catalog").get()).toEqual({ n: 1 });
  } finally { db.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});
