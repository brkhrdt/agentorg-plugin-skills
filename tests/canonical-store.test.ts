import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { migrateCanonicalCheckout } from "../src/canonical-store.ts";
import { revertCleanRepository } from "../src/git.ts";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("canonical migration atomically copies and verifies full history while retaining legacy data", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-canonical-"));
  const legacy = join(root, "legacy"), source = join(legacy, "hashed-old"), canonical = join(root, "data", "skills");
  try {
    await mkdir(source, { recursive: true });
    git(source, "init", "-q"); git(source, "config", "user.email", "test@example.invalid"); git(source, "config", "user.name", "test");
    await writeFile(join(source, "SKILL.md"), "---\nname: sample\ndescription: test\n---\n\nInstructions\n");
    git(source, "add", "."); git(source, "commit", "-qm", "initial");
    await writeFile(join(source, "extra"), "history\n"); git(source, "add", "."); git(source, "commit", "-qm", "second");
    const before = git(source, "rev-parse", "HEAD");
    const path = await migrateCanonicalCheckout({ name: "sample", source, legacyRoot: legacy, canonicalRoot: canonical });
    expect(path).toBe(join(canonical, "sample"));
    expect(git(path, "rev-parse", "HEAD")).toBe(before);
    expect(git(path, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(source, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(source, "extra"), "utf8")).toBe("history\n");
    expect(await migrateCanonicalCheckout({ name: "sample", source, legacyRoot: legacy, canonicalRoot: canonical })).toBe(path);
    await expect(migrateCanonicalCheckout({ name: "../evil", source, legacyRoot: legacy, canonicalRoot: canonical })).rejects.toThrow(/name/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner revert is explicit, compare-and-swap fenced, and refuses dirty worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-revert-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.email", "x@y.invalid"); git(root, "config", "user.name", "x");
    await writeFile(join(root, "SKILL.md"), "one\n"); git(root, "add", "."); git(root, "commit", "-qm", "one");
    const first = git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "SKILL.md"), "two\n"); git(root, "commit", "-qam", "two");
    const second = git(root, "rev-parse", "HEAD");
    expect(await revertCleanRepository(root, second, first)).toBe(first);
    expect(await readFile(join(root, "SKILL.md"), "utf8")).toBe("one\n");
    await expect(revertCleanRepository(root, second, first)).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(join(root, "untracked"), "keep\n");
    await expect(revertCleanRepository(root, first, second)).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect(await readFile(join(root, "untracked"), "utf8")).toBe("keep\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical migration refuses a conflicting destination without touching either tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-canonical-conflict-"));
  const legacy = join(root, "legacy"), source = join(legacy, "old"), canonical = join(root, "skills");
  try {
    await mkdir(source, { recursive: true }); await mkdir(join(canonical, "sample"), { recursive: true });
    git(source, "init", "-q"); git(source, "config", "user.email", "x@y.invalid"); git(source, "config", "user.name", "x");
    await writeFile(join(source, "SKILL.md"), "---\nname: sample\ndescription: a\n---\na\n"); git(source, "add", "."); git(source, "commit", "-qm", "source");
    await writeFile(join(canonical, "sample", "keep"), "collision\n");
    await expect(migrateCanonicalCheckout({ name: "sample", source, legacyRoot: legacy, canonicalRoot: canonical })).rejects.toThrow();
    expect(await readFile(join(canonical, "sample", "keep"), "utf8")).toBe("collision\n");
    expect(await lstat(join(source, ".git"))).toBeTruthy();
  } finally { await rm(root, { recursive: true, force: true }); }
});
