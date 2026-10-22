import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureLocalGit, importLocalGitHistory } from "../src/local-history.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", cwd, ...args])).stdout.trim(); }
async function setup(pack = true) {
  const root = await mkdtemp(join(tmpdir(), "agentorg-history-"));
  const source = join(root, "source"), stage = join(root, "managed");
  await mkdir(source); await mkdir(stage);
  await git(root, "init", "--quiet", "--initial-branch=main", source);
  await writeFile(join(source, "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture\n---\nInstructions\n");
  await writeFile(join(source, "tracked.txt"), "one\n");
  await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "first");
  const first = await git(source, "rev-parse", "HEAD");
  await git(source, "branch", "alternate"); await git(source, "tag", "v1", "-a", "-m", "version one");
  await writeFile(join(source, "tracked.txt"), "two\n");
  await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "second");
  const second = await git(source, "rev-parse", "HEAD");
  if (pack) await git(source, "gc", "--quiet");
  return { root, source, stage, first, second };
}
async function copyWorktree(source: string, stage: string) {
  await writeFile(join(stage, "SKILL.md"), await readFile(join(source, "SKILL.md")));
  await writeFile(join(stage, "tracked.txt"), await readFile(join(source, "tracked.txt")));
}

test("raw local Git import preserves supported refs/history and snapshots dirty content without touching source", async () => {
  const f = await setup();
  try {
    await writeFile(join(f.source, "tracked.txt"), "dirty\n");
    await writeFile(join(f.source, "ignored.tmp"), "ignored\n");
    await writeFile(join(f.source, ".gitignore"), "ignored.tmp\n");
    const beforeHead = await git(f.source, "rev-parse", "HEAD");
    const beforeIndex = await readFile(join(f.source, ".git", "index"));
    await copyWorktree(f.source, f.stage);
    await writeFile(join(f.stage, "ignored.tmp"), await readFile(join(f.source, "ignored.tmp")));
    await writeFile(join(f.stage, ".gitignore"), await readFile(join(f.source, ".gitignore")));
    const capture = await captureLocalGit(f.source);
    expect(capture?.head.oid).toBe(f.second);
    const history = await importLocalGitHistory(capture!, f.stage, 60_000);
    expect(history.originalHead).toBe(f.second);
    expect(history.selected).not.toBe(f.second);
    expect(history.refCount).toBe(4);
    expect(await git(f.stage, "rev-parse", "refs/heads/main")).toBe(f.second);
    expect(await git(f.stage, "rev-parse", "refs/heads/alternate")).toBe(f.first);
    expect(await git(f.stage, "rev-parse", "refs/tags/v1^{commit}")).toBe(f.first);
    expect(await git(f.stage, "rev-parse", `${history.selected}^`)).toBe(f.second);
    expect(await readFile(join(f.stage, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(await readFile(join(f.stage, "ignored.tmp"), "utf8")).toBe("ignored\n");
    expect(await git(f.source, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await readFile(join(f.source, ".git", "index"))).toEqual(beforeIndex);
    await rm(f.source, { recursive: true });
    expect(await git(f.stage, "show", "refs/heads/alternate:tracked.txt")).toBe("one");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("clean and detached sources preserve the original selected commit; unborn sources get an initial commit", async () => {
  const clean = await setup();
  try {
    await copyWorktree(clean.source, clean.stage);
    const history = await importLocalGitHistory((await captureLocalGit(clean.source))!, clean.stage, 60_000);
    expect(history.selected).toBe(clean.second);
    expect(history.dirtyCommit).toBeUndefined();
    expect(await git(clean.stage, "rev-parse", "HEAD")).toBe(clean.second);
  } finally { await rm(clean.root, { recursive: true, force: true }); }

  const detached = await setup();
  try {
    await git(detached.source, "checkout", "--quiet", "--detach", detached.first);
    await copyWorktree(detached.source, detached.stage);
    const history = await importLocalGitHistory((await captureLocalGit(detached.source))!, detached.stage, 60_000);
    expect(history.originalHead).toBe(detached.first);
    expect(history.selected).toBe(detached.first);
    expect(await git(detached.stage, "rev-parse", "HEAD")).toBe(detached.first);
    expect(await git(detached.stage, "rev-parse", "refs/heads/alternate")).toBe(detached.first);
  } finally { await rm(detached.root, { recursive: true, force: true }); }

  const root = await mkdtemp(join(tmpdir(), "agentorg-unborn-")), source = join(root, "source"), stage = join(root, "managed");
  try {
    await mkdir(source); await mkdir(stage);
    await git(root, "init", "--quiet", "--initial-branch=main", source);
    await writeFile(join(source, "SKILL.md"), "---\nname: unborn-skill\ndescription: fixture\n---\nInstructions\n");
    await writeFile(join(stage, "SKILL.md"), await readFile(join(source, "SKILL.md")));
    const capture = await captureLocalGit(source);
    expect(capture?.head.ref).toBe("refs/heads/main"); expect(capture?.head.oid).toBeUndefined();
    const history = await importLocalGitHistory(capture!, stage, 60_000);
    expect(history.originalHead).toBeUndefined();
    expect(history.selected).toBeDefined();
    expect(await git(stage, "rev-list", "--parents", "-n", "1", "HEAD")).toBe(history.selected!);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local Git capture rejects gitfiles, subdirectories, bare roots, alternates and shallow boundaries", async () => {
  const f = await setup();
  try {
    const worktree = join(f.root, "linked");
    await git(f.source, "worktree", "add", "--detach", worktree, f.second);
    await expect(captureLocalGit(worktree)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    await rm(worktree, { recursive: true, force: true });
    const subdir = join(f.source, "subdir"); await mkdir(subdir);
    await writeFile(join(subdir, "SKILL.md"), "metadata");
    await expect(captureLocalGit(subdir)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    await writeFile(join(f.source, ".git", "objects", "info", "alternates"), "/tmp/elsewhere\n");
    await expect(captureLocalGit(f.source)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    await rm(join(f.source, ".git", "objects", "info", "alternates"));
    await writeFile(join(f.source, ".git", "shallow"), `${f.first}\n`);
    await expect(captureLocalGit(f.source)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("all Git subprocesses during raw import point only into managed storage", async () => {
  const f = await setup(), bin = join(f.root, "bin"), trace = join(f.root, "git-args.log"), wrapper = join(bin, "git");
  const oldPath = process.env.PATH, oldTrace = process.env.TRACE_FILE;
  try {
    await mkdir(bin);
    await writeFile(wrapper, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TRACE_FILE\"\nexec /usr/bin/git \"$@\"\n");
    await chmod(wrapper, 0o700);
    await copyWorktree(f.source, f.stage);
    process.env.PATH = `${bin}:${oldPath ?? ""}`; process.env.TRACE_FILE = trace;
    const capture = await captureLocalGit(f.source);
    await importLocalGitHistory(capture!, f.stage, 60_000);
    process.env.PATH = oldPath; process.env.TRACE_FILE = oldTrace;
    const invocations = await readFile(trace, "utf8");
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations).toContain(f.stage);
    expect(invocations).not.toContain(f.source);
  } finally {
    process.env.PATH = oldPath; process.env.TRACE_FILE = oldTrace;
    await rm(f.root, { recursive: true, force: true });
  }
});

test("full Git fsck detects corruption in a historical blob before registration", async () => {
  const f = await setup(false);
  try {
    const oid = await git(f.source, "rev-parse", "HEAD:tracked.txt");
    const objectPath = join(f.source, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    await chmod(objectPath, 0o600);
    const compressed = await readFile(objectPath);
    compressed[Math.floor(compressed.byteLength / 2)] ^= 0xff;
    await writeFile(objectPath, compressed);
    await copyWorktree(f.source, f.stage);
    const capture = await captureLocalGit(f.source);
    await expect(importLocalGitHistory(capture!, f.stage, 60_000)).rejects.toThrow(/fsck|object|corrupt|hash|inflate/i);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("selected gitlinks, object-store symlinks and unsupported object formats fail closed", async () => {
  const f = await setup();
  try {
    await git(f.source, "update-index", "--add", "--cacheinfo", `160000,${f.first},submodule`);
    await git(f.source, "commit", "--quiet", "-m", "submodule");
    await copyWorktree(f.source, f.stage);
    await expect(importLocalGitHistory((await captureLocalGit(f.source))!, f.stage, 60_000)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  } finally { await rm(f.root, { recursive: true, force: true }); }

  const unsafe = await setup();
  try {
    const fanout = join(unsafe.source, ".git", "objects", "aa");
    await mkdir(fanout);
    await (await import("node:fs/promises")).symlink("/etc/passwd", join(fanout, "0".repeat(38)));
    await expect(captureLocalGit(unsafe.source)).rejects.toThrow(/symlink|unsupported/i);
    const shaRoot = await mkdtemp(join(tmpdir(), "agentorg-sha256-")), shaSource = join(shaRoot, "source");
    try {
      await mkdir(shaSource);
      await git(shaRoot, "init", "--quiet", "--object-format=sha256", shaSource);
      await writeFile(join(shaSource, "SKILL.md"), "metadata");
      await expect(captureLocalGit(shaSource)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    } finally { await rm(shaRoot, { recursive: true, force: true }); }
  } finally { await rm(unsafe.root, { recursive: true, force: true }); }
});

test("ignored ref namespaces still consume a global traversal budget", async () => {
  const f = await setup(), ignored = join(f.source, ".git", "refs", "remotes", "origin");
  try {
    await mkdir(ignored, { recursive: true });
    const batchSize = 1000;
    for (let batch = 0; batch < 101; batch++) {
      await Promise.all(Array.from({ length: batchSize }, (_, i) => {
        const index = batch * batchSize + i;
        return writeFile(join(ignored, `ignored-${String(index).padStart(6, "0")}`), "ignored\n");
      }));
    }
    await expect(captureLocalGit(f.source)).rejects.toMatchObject({ code: "LIMIT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
