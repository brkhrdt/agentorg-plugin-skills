import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { clonePinnedSkill } from "../src/git.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("pinned install is genuinely shallow, detached and independent of canonical objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-shallow-"));
  const canonical = join(root, "canonical"), install = join(root, "install");
  try {
    await mkdir(canonical);
    git(canonical, "init", "-q");
    git(canonical, "config", "user.email", "test@example.invalid");
    git(canonical, "config", "user.name", "test");
    await writeFile(join(canonical, "SKILL.md"), "first\n");
    git(canonical, "add", "."); git(canonical, "commit", "-qm", "first");
    await writeFile(join(canonical, "SKILL.md"), "second\n");
    git(canonical, "commit", "-qam", "second");
    const pinned = git(canonical, "rev-parse", "HEAD");
    await clonePinnedSkill(canonical, install, pinned);
    expect(git(install, "rev-parse", "HEAD")).toBe(pinned);
    expect(git(install, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(install, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(install, "remote")).toBe("");
    expect(await readFile(join(install, "SKILL.md"), "utf8")).toBe("second\n");
    expect(await Bun.file(join(install, ".git", "objects", "info", "alternates")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
