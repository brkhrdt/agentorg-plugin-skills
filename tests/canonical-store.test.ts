import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { migrateCanonicalCheckout, fastForwardCanonicalCheckout, prepareCanonicalRevert } from "../src/canonical-store.ts";
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

test("explicit canonical update fast-forwards from a local Git source; dirty and diverged updates leave canonical HEAD unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-ff-update-")), source = join(root, "source"), canonical = join(root, "skills", "sample");
  try {
    await mkdir(source); await mkdir(join(root, "skills")); git(source, "init", "-q"); git(source, "config", "user.email", "x@y.invalid"); git(source, "config", "user.name", "x");
    await writeFile(join(source, "SKILL.md"), "---\nname: sample\ndescription: test\n---\nfirst\n"); git(source, "add", "."); git(source, "commit", "-qm", "first");
    git(root, "clone", "--no-hardlinks", source, canonical);
    const first = git(canonical, "rev-parse", "HEAD");
    await writeFile(join(source, "extra"), "second\n"); git(source, "add", "."); git(source, "commit", "-qm", "second");
    const updated = await fastForwardCanonicalCheckout({ canonicalPath: canonical, source, expectedHead: first });
    expect(updated.head).toBe(git(source, "rev-parse", "HEAD"));
    expect(git(canonical, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(canonical, "remote", "get-url", "origin")).toBe(source);
    await writeFile(join(source, "extra"), "third\n"); git(source, "commit", "-qam", "third");
    git(canonical, "config", "user.email", "owner@example.invalid"); git(canonical, "config", "user.name", "owner");
    git(canonical, "checkout", "-qb", "owner-divergence");
    await writeFile(join(canonical, "owner-change"), "local owner commit\n"); git(canonical, "add", "."); git(canonical, "commit", "-qm", "owner divergence");
    const divergedHead = git(canonical, "rev-parse", "HEAD");
    await expect(fastForwardCanonicalCheckout({ canonicalPath: canonical, source, expectedHead: divergedHead })).rejects.toMatchObject({ code: "NON_FAST_FORWARD" });
    expect(git(canonical, "rev-parse", "HEAD")).toBe(divergedHead);
    await writeFile(join(canonical, "local"), "dirty\n");
    const cleanHead = git(canonical, "rev-parse", "HEAD");
    await expect(fastForwardCanonicalCheckout({ canonicalPath: canonical, source, expectedHead: cleanHead })).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect(git(canonical, "rev-parse", "HEAD")).toBe(cleanHead);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid skill identity in an upstream update never replaces canonical checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-invalid-update-")), source = join(root, "source"), canonical = join(root, "skills", "sample");
  try {
    await mkdir(source); await mkdir(join(root, "skills"));
    git(source, "init", "-q"); git(source, "config", "user.email", "x@y.invalid"); git(source, "config", "user.name", "x");
    await writeFile(join(source, "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\none\n"); git(source, "add", "."); git(source, "commit", "-qm", "valid");
    git(root, "clone", "--no-hardlinks", source, canonical);
    const original = git(canonical, "rev-parse", "HEAD");
    await writeFile(join(source, "SKILL.md"), "---\nname: other\ndescription: invalid identity\n---\ntwo\n"); git(source, "commit", "-qam", "invalid identity");
    await expect(fastForwardCanonicalCheckout({ canonicalPath: canonical, source, expectedHead: original })).rejects.toThrow(/identity|name/i);
    expect(git(canonical, "rev-parse", "HEAD")).toBe(original);
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("name: sample");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical files roll back when the transactional catalog publish callback fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-publish-failure-")), source = join(root, "source"), canonical = join(root, "skills", "sample");
  try {
    await mkdir(source); await mkdir(join(root, "skills"));
    git(source, "init", "-q"); git(source, "config", "user.email", "x@y.invalid"); git(source, "config", "user.name", "x");
    await writeFile(join(source, "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\none\n"); git(source, "add", "."); git(source, "commit", "-qm", "one");
    git(root, "clone", "--no-hardlinks", source, canonical); const before = git(canonical, "rev-parse", "HEAD");
    await writeFile(join(source, "extra"), "two\n"); git(source, "add", "."); git(source, "commit", "-qm", "two");
    await expect(fastForwardCanonicalCheckout({ canonicalPath: canonical, source, expectedHead: before }, async () => { throw new Error("injected ledger failure"); })).rejects.toThrow(/injected ledger failure/);
    expect(git(canonical, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toContain("name: sample");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner revert is explicit, compare-and-swap fenced, and refuses dirty worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-revert-")), repo = join(root, "skills", "sample");
  try {
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q"); git(repo, "config", "user.email", "x@y.invalid"); git(repo, "config", "user.name", "x");
    await writeFile(join(repo, "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\none\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "one");
    const first = git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\ntwo\n"); git(repo, "commit", "-qam", "two");
    await writeFile(join(repo, "SKILL.md"), "---\nname: wrong\ndescription: invalid identity\n---\ninvalid\n"); git(repo, "commit", "-qam", "invalid identity");
    const invalid = git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\nrestored\n"); git(repo, "commit", "-qam", "restored identity");
    const current = git(repo, "rev-parse", "HEAD");
    git(repo, "config", "--local", "remote.origin.url", "/upstream/demo.git");
    git(repo, "config", "--local", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(repo, "config", "--local", "remote.backup.url", "/backup/demo.git");
    const remotesBefore = git(repo, "config", "--local", "--get-regexp", "^remote\\.");
    await expect(prepareCanonicalRevert({ canonicalPath: repo, expectedHead: current, targetCommit: invalid })).rejects.toThrow(/name|identity/i);
    expect(git(repo, "rev-parse", "HEAD")).toBe(current);
    const reverted = await prepareCanonicalRevert({ canonicalPath: repo, expectedHead: current, targetCommit: first });
    expect(reverted.head).toBe(first);
    expect(git(repo, "config", "--local", "--get-regexp", "^remote\\.")).toBe(remotesBefore); // Preserve remotes exactly; never retain the candidate's self-origin.
    expect(await readFile(join(repo, "SKILL.md"), "utf8")).toContain("one");
    await expect(prepareCanonicalRevert({ canonicalPath: repo, expectedHead: current, targetCommit: first })).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(join(repo, "untracked"), "keep\n");
    await expect(prepareCanonicalRevert({ canonicalPath: repo, expectedHead: first, targetCommit: invalid })).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect(await readFile(join(repo, "untracked"), "utf8")).toBe("keep\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner revert preserves the absence of upstream remotes", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-revert-no-remotes-")), repo = join(root, "skills", "sample");
  try {
    await mkdir(repo, { recursive: true }); git(repo, "init", "-q"); git(repo, "config", "user.email", "x@y.invalid"); git(repo, "config", "user.name", "x");
    await writeFile(join(repo, "SKILL.md"), "---\nname: sample\ndescription: fixture\n---\none\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "one");
    const first = git(repo, "rev-parse", "HEAD"); await writeFile(join(repo, "content"), "two\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "two");
    const current = git(repo, "rev-parse", "HEAD"); expect(git(repo, "remote")).toBe("");
    await prepareCanonicalRevert({ canonicalPath: repo, expectedHead: current, targetCommit: first });
    expect(git(repo, "remote")).toBe("");
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
