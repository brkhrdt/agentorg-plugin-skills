import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyLocalSkill, resolveLocalSource } from "../src/local-source.ts";
import { createLocalSkillFixture } from "./helpers/local-skill.ts";

async function temporary() { return mkdtemp(join(tmpdir(), "skills-copy-test-")); }

test("resolve accepts directory or root SKILL.md; relative paths need explicit base and ~ needs supplied home", async () => {
  const fixture = await createLocalSkillFixture();
  try {
    expect((await resolveLocalSource(fixture.path)).directory).toBe(fixture.path);
    expect((await resolveLocalSource(join(fixture.path, "SKILL.md"))).directory).toBe(fixture.path);
    expect((await resolveLocalSource("local-skill", { baseDir: fixture.root })).directory).toBe(fixture.path);
    expect((await resolveLocalSource("~/local-skill", { home: fixture.root })).directory).toBe(fixture.path);
    await expect(resolveLocalSource("local-skill")).rejects.toThrow(/explicit base/);
    await expect(resolveLocalSource("~/local-skill")).rejects.toThrow(/home directory/);
    for (const bad of ["", "\0", "x".repeat(4097)]) await expect(resolveLocalSource(bad)).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});

test("top-level directory aliases canonicalize; source copy includes ignored, untracked and .agents but excludes .git at every depth", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const alias = join(root, "alias");
    await symlink(fixture.path, alias, "dir");
    const stage = join(root, "stage");
    await mkdir(join(fixture.path, "nested", ".git"), { recursive: true });
    await writeFile(join(fixture.path, "nested", ".git", "data"), "exclude");
    await writeFile(join(fixture.path, "untracked.txt"), "untracked");
    const resolved = await resolveLocalSource(alias);
    expect(resolved.directory).toBe(fixture.path);
    const result = await copyLocalSkill(alias, stage);
    expect(result).toMatchObject({ sourcePath: fixture.path, name: "fixture-skill", description: "Local import contract fixture" });
    expect(await readFile(join(stage, "ignored-payload.txt"), "utf8")).toContain("ignored");
    expect(await readFile(join(stage, ".agents", "keep.txt"), "utf8")).toContain("include");
    expect(await readFile(join(stage, "untracked.txt"), "utf8")).toBe("untracked");
    expect(await readFile(join(stage, "asset.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
    expect(await readFile(join(stage, "scripts", "run.sh"), "utf8")).toContain("echo fixture");
    expect((await lstat(join(stage, "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
    await expect(lstat(join(stage, "nested", ".git"))).rejects.toThrow();
    expect(await readFile(join(fixture.path, "nested", ".git", "data"), "utf8")).toBe("exclude");
    expect(await readFile(join(fixture.path, "asset.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test("reject unsafe entries, symlinked root SKILL.md, source overlap, central overlap and occupied destinations", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const external = join(root, "outside"); await writeFile(external, "outside");
    await symlink(external, join(fixture.path, "linked-file"));
    await expect(copyLocalSkill(fixture.path, join(root, "unsafe"))).rejects.toThrow(/Unsupported source entry/);
    await rm(join(fixture.path, "linked-file"));
    await expect(copyLocalSkill(fixture.path, join(fixture.path, "child"))).rejects.toThrow(/overlap/);
    await expect(copyLocalSkill(fixture.path, join(root, "central-child"), { centralRoot: root })).rejects.toThrow(/central/);
    const occupied = join(root, "occupied"); await mkdir(occupied);
    await expect(copyLocalSkill(fixture.path, occupied)).rejects.toMatchObject({ code: "DUPLICATE" });

    const badRoot = join(root, "bad"); await mkdir(badRoot);
    await symlink(join(fixture.path, "SKILL.md"), join(badRoot, "SKILL.md"));
    await expect(resolveLocalSource(badRoot)).rejects.toThrow(/non-symlink/);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test("enforce metadata, payload and admitted-entry limits", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const original = await readFile(join(fixture.path, "SKILL.md"));
    await writeFile(join(fixture.path, "SKILL.md"), Buffer.alloc(128 * 1024 + 1, 32));
    await expect(copyLocalSkill(fixture.path, join(root, "large-md"))).rejects.toThrow(/128 KiB/);
    await writeFile(join(fixture.path, "SKILL.md"), original);
    const payload = join(fixture.path, "large-payload.bin");
    const { open } = await import("node:fs/promises");
    const handle = await open(payload, "w");
    await handle.truncate(256 * 1024 * 1024 + 1);
    await handle.close();
    await expect(copyLocalSkill(fixture.path, join(root, "large-payload"))).rejects.toMatchObject({ code: "LIMIT" });
    await rm(payload);
    const many = join(fixture.path, "many"); await mkdir(many);
    for (let i = 0; i <= 20_000; i += 500)
      await Promise.all(Array.from({ length: Math.min(500, 20_001 - i) }, (_, offset) => writeFile(join(many, `f${i + offset}`), "x")));
    await expect(copyLocalSkill(fixture.path, join(root, "many-files"))).rejects.toMatchObject({ code: "LIMIT" });
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("copy failure retains only its own partial private stage and metadata is revalidated", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const stage = join(root, "partial");
    await expect(copyLocalSkill(fixture.path, stage, {
      beforeCopyFile: source => { if (source.endsWith("asset.bin")) throw new Error("injected copy failure"); },
    })).rejects.toThrow("injected copy failure");
    expect((await lstat(stage)).mode & 0o077).toBe(0);
    expect(await readFile(join(fixture.path, "asset.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));

    const invalid = join(root, "invalid");
    await writeFile(join(fixture.path, "SKILL.md"), "---\nname: invalid\ndescription: missing instructions\n---\n");
    await expect(copyLocalSkill(fixture.path, invalid)).rejects.toThrow(/instructions/);
    expect(await lstat(invalid)).toBeDefined(); // Partial owned stage is preserved for diagnosis.
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});
