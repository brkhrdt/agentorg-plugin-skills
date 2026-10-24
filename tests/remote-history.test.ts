import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cloneManagedRepository, cloneRemoteRepository, normalizeRemoteBranches, validateRemoteHistory } from "../src/git.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", cwd, ...args])).stdout.trim(); }

test("full managed clones and independent installs retain supported history and safe confined symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentorg-remote-history-"));
  const source = join(root, "source"), bare = join(root, "origin.git"), managed = join(root, "managed"), install = join(root, "install");
  try {
    await mkdir(source);
    await git(root, "init", "--quiet", "--initial-branch=main", source);
    await writeFile(join(source, "SKILL.md"), "---\nname: remote-skill\ndescription: fixture\n---\nInstructions\n");
    await writeFile(join(source, "history.txt"), "first\n");
    await mkdir(join(source, "scripts")); await symlink("../history.txt", join(source, "scripts", "current.txt"));
    await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "first");
    const first = await git(source, "rev-parse", "HEAD");
    await git(source, "branch", "alternate"); await git(source, "tag", "v1", "-a", "-m", "version one");
    await writeFile(join(source, "history.txt"), "second\n");
    await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "second");
    const second = await git(source, "rev-parse", "HEAD");
    await git(source, "checkout", "--quiet", "-b", "tag-only");
    await writeFile(join(source, "history.txt"), "tag-only\n");
    await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "tag only");
    await git(source, "tag", "orphan-v0", "-a", "-m", "tag-only history");
    const tagOnly = await git(source, "rev-parse", "HEAD");
    await git(source, "checkout", "--quiet", "main"); await git(source, "branch", "-D", "tag-only");
    await git(root, "clone", "--bare", source, bare);
    await cloneRemoteRepository(bare, managed, 60_000);
    expect(await validateRemoteHistory(managed, 60_000)).toBe(second);
    const manifest = await normalizeRemoteBranches(managed, 60_000);
    expect(manifest).toContainEqual(["refs/heads/main", second]);
    expect(manifest).toContainEqual(["refs/heads/alternate", first]);
    expect(manifest.some(([ref]) => ref === "refs/tags/v1")).toBe(true);
    expect(await git(managed, "rev-parse", "refs/tags/orphan-v0^{commit}")).toBe(tagOnly);
    await cloneManagedRepository(managed, install, 60_000);
    expect(await git(install, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(await git(install, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await git(install, "remote")).toBe("");
    expect(await git(install, "show-ref", "--heads")).not.toContain("alternate");
    expect(await git(install, "symbolic-ref", "-q", "HEAD").catch(() => "")).toBe("");
    expect(await readFile(await (await import("node:fs/promises")).realpath(join(install, "scripts", "current.txt")), "utf8")).toBe("second\n");
    await rm(bare, { recursive: true, force: true });
    expect(await git(managed, "show", "refs/heads/alternate:history.txt")).toBe("first");
    expect((await readFile(join(managed, "SKILL.md"), "utf8"))).toContain("remote-skill");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed clone rejects absolute/out-of-root symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentorg-unsafe-link-"));
  const source = join(root, "source"), bare = join(root, "origin.git"), managed = join(root, "managed");
  try {
    await mkdir(source); await git(root, "init", "--quiet", "--initial-branch=main", source);
    await writeFile(join(source, "SKILL.md"), "---\nname: link-skill\ndescription: fixture\n---\nInstructions\n");
    await symlink("/etc/passwd", join(source, "escape"));
    await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "unsafe link");
    await git(root, "clone", "--bare", source, bare);
    await expect(cloneRemoteRepository(bare, managed, 60_000)).rejects.toThrow(/symlink target|Absolute Git symlink/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
