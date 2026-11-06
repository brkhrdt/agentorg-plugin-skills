import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalSource } from "../src/local-source.ts";

test("local Git source paths resolve directories and root SKILL.md with explicit bases", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-local-source-"));
  const skill = join(root, "local-skill");
  try {
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), "---\nname: local-skill\ndescription: test\n---\nInstructions\n");
    expect((await resolveLocalSource(skill)).directory).toBe(skill);
    expect((await resolveLocalSource(join(skill, "SKILL.md"))).directory).toBe(skill);
    expect((await resolveLocalSource("local-skill", { baseDir: root })).directory).toBe(skill);
    expect((await resolveLocalSource("~/local-skill", { home: root })).directory).toBe(skill);
    await expect(resolveLocalSource("local-skill")).rejects.toThrow(/explicit base/);
    await expect(resolveLocalSource("~/local-skill")).rejects.toThrow(/home directory/);
    for (const bad of ["", "\0", "x".repeat(4097)]) await expect(resolveLocalSource(bad)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local path admission requires a real root SKILL.md and rejects overlap with the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-local-source-"));
  const plain = join(root, "plain"), store = join(root, "store"), stored = join(store, "skill");
  try {
    await mkdir(plain); await mkdir(stored, { recursive: true });
    await writeFile(join(stored, "SKILL.md"), "metadata");
    await expect(resolveLocalSource(join(root, "missing"))).rejects.toThrow();
    await expect(resolveLocalSource(plain)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await writeFile(join(plain, "SKILL.md"), "metadata");
    const alias = join(root, "alias.md"); await symlink(join(plain, "SKILL.md"), alias);
    await expect(resolveLocalSource(alias)).rejects.toThrow(/must not be a symlink/);
    await expect(resolveLocalSource(stored, { centralRoot: store })).rejects.toThrow(/overlap/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
