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
    const fileAlias = join(root, "skill-alias"); await symlink(join(fixture.path, "SKILL.md"), fileAlias);
    await expect(resolveLocalSource(fileAlias)).rejects.toThrow(/must not be a symlink/);
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
    expect(Bun.spawnSync(["truncate", "-s", String(256 * 1024 * 1024 + 1), payload]).exitCode).toBe(0);
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

    await writeFile(join(fixture.path, "SKILL.md"), "---\nname: ../unsafe\ndescription: Unsafe name\n---\n\nInstructions\n");
    await expect(copyLocalSkill(fixture.path, join(root, "bad-name"))).rejects.toThrow(/name must match/);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test("streaming byte limits catch deterministic source growth before oversized writes", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const skill = join(fixture.path, "SKILL.md");
    await writeFile(skill, `---\nname: fixture-skill\ndescription: ${"x".repeat(110_000)}\n---\n\n${"i".repeat(10_000)}`);
    const stage = join(root, "growth");
    await expect(copyLocalSkill(fixture.path, stage, {
      afterSourceOpen: async source => { if (source === skill) await writeFile(skill, `${await readFile(skill)}${"z".repeat(20_000)}`); },
    })).rejects.toMatchObject({ code: "LIMIT" });
    const copied = await readFile(join(stage, "SKILL.md"));
    expect(copied.byteLength).toBeLessThanOrEqual(128 * 1024);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test("nofollow nonblocking opens reject deterministic source symlink and FIFO swaps", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const sourceFile = join(fixture.path, "asset.bin");
    const outside = join(root, "secret"); await writeFile(outside, "external secret");
    await expect(copyLocalSkill(fixture.path, join(root, "symlink-swap"), {
      beforeOpenEntry: async entry => {
        if (entry === sourceFile) { await rm(sourceFile); await symlink(outside, sourceFile); }
      },
    })).rejects.toThrow();
    await expect(readFile(join(root, "symlink-swap", "asset.bin"))).rejects.toThrow();

    await rm(sourceFile, { force: true });
    const fifo = Bun.spawnSync(["mkfifo", sourceFile]);
    expect(fifo.exitCode).toBe(0);
    const started = Date.now();
    await expect(copyLocalSkill(fixture.path, join(root, "fifo-swap"), {
      beforeOpenEntry: async entry => {
        if (entry === sourceFile) { await rm(sourceFile); expect(Bun.spawnSync(["mkfifo", sourceFile]).exitCode).toBe(0); }
      },
    })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test("opened source directory handles reject symlinked-parent swaps without reading outside", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const outside = join(root, "outside"); await mkdir(outside);
    await writeFile(join(outside, "secret"), "external secret");
    const nested = join(fixture.path, "nested"); await mkdir(nested);
    await writeFile(join(nested, "ordinary"), "original");
    const saved = join(fixture.path, "nested-saved");
    const stage = join(root, "stage");
    await expect(copyLocalSkill(fixture.path, stage, {
      beforeOpenEntry: async entry => {
        if (entry === nested) { await (await import("node:fs/promises")).rename(nested, saved); await symlink(outside, nested, "dir"); }
      },
    })).rejects.toThrow();
    await expect(readFile(join(stage, "nested", "secret"))).rejects.toThrow();
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test("destination stage swaps to symlink are detected before writes reach redirected paths", async () => {
  const fixture = await createLocalSkillFixture();
  const root = await temporary();
  try {
    const stage = join(root, "stage"), moved = join(root, "moved"), external = join(root, "external");
    await mkdir(external);
    await expect(copyLocalSkill(fixture.path, stage, {
      beforeCopyFile: async source => {
        if (source.endsWith("asset.bin")) { await (await import("node:fs/promises")).rename(stage, moved); await symlink(external, stage, "dir"); }
      },
    })).rejects.toThrow(/Destination stage .*changed/);
    expect(await (await import("node:fs/promises")).readdir(external)).toEqual([]);

    const parent = join(root, "parent"), movedParent = join(root, "moved-parent"), outsideParent = join(root, "outside-parent");
    await mkdir(parent); await mkdir(outsideParent);
    await expect(copyLocalSkill(fixture.path, join(parent, "child"), {
      beforeCopyFile: async source => {
        if (source.endsWith("asset.bin")) { await (await import("node:fs/promises")).rename(parent, movedParent); await symlink(outsideParent, parent, "dir"); }
      },
    })).rejects.toThrow(/Destination parent changed/);
    expect(await (await import("node:fs/promises")).readdir(outsideParent)).toEqual([]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});
