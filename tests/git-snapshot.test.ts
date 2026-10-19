import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitWithTimeout, initializeLocalSnapshot } from "../src/git.ts";

test("local Git snapshot commits all bytes including ignored files without transforms, remotes, hooks or history", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-git-snapshot-"));
  const repo = join(root, "repo"); await mkdir(repo);
  try {
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    await writeFile(join(repo, "binary.bin"), bytes);
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "ignored.txt"), "keep ignored payload\n");
    await writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf ident\n*.bin filter=unconfigured\n");
    await writeFile(join(repo, "content.txt"), "$Id$\nplain\n");
    const executable = join(repo, "run.sh"); await writeFile(executable, "#!/bin/sh\necho exact\n"); await chmod(executable, 0o700);
    await mkdir(join(repo, ".agents")); await writeFile(join(repo, ".agents", "payload"), "included");

    await initializeLocalSnapshot(repo, 10_000);
    expect(await gitWithTimeout(repo, 10_000, "remote")).toBe("");
    expect((await gitWithTimeout(repo, 10_000, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(/\s+/)).toHaveLength(1);
    expect(await gitWithTimeout(repo, 10_000, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await readFile(join(repo, "binary.bin"))).toEqual(bytes);
    expect(await readFile(join(repo, "ignored.txt"), "utf8")).toBe("keep ignored payload\n");
    expect(await readFile(join(repo, "content.txt"), "utf8")).toBe("$Id$\nplain\n");
    expect((await (await import("node:fs/promises")).stat(executable)).mode & 0o111).not.toBe(0);
    expect((await gitWithTimeout(repo, 10_000, "config", "user.name"))).toBe("AgentOrg Skills Snapshot");
    expect((await gitWithTimeout(repo, 10_000, "config", "user.email"))).toBe("skills@agentorg.invalid");
    expect(await gitWithTimeout(repo, 10_000, "config", "core.hooksPath")).toBe("/dev/null");
  } finally { await rm(root, { recursive: true, force: true }); }
});
