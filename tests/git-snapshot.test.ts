import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneLocalSnapshot, gitWithTimeout, initializeLocalSnapshot } from "../src/git.ts";

test("local Git snapshot commits all bytes including ignored files without transforms, remotes, hooks or history", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-git-snapshot-"));
  const repo = join(root, "repo"); await mkdir(repo);
  try {
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    await writeFile(join(repo, "binary.bin"), bytes);
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "ignored.txt"), "keep ignored payload\n");
    await writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf ident\n*.bin filter=unconfigured\n");
    await writeFile(join(repo, "content.txt"), "$Id$\r\nplain\r\n");
    const executable = join(repo, "run.sh"); await writeFile(executable, "#!/bin/sh\necho exact\n"); await chmod(executable, 0o700);
    await mkdir(join(repo, ".agents")); await writeFile(join(repo, ".agents", "payload"), "included");

    const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"];
    const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { GIT_AUTHOR_NAME: "Attacker", GIT_AUTHOR_EMAIL: "attacker@example.com", GIT_COMMITTER_NAME: "Attacker", GIT_COMMITTER_EMAIL: "attacker@example.com", GIT_AUTHOR_DATE: "@1 +0000", GIT_COMMITTER_DATE: "@1 +0000" });
    try { await initializeLocalSnapshot(repo, 10_000); }
    finally { for (const [key, value] of Object.entries(originalEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; }
    expect(await gitWithTimeout(repo, 10_000, "show", "-s", "--format=%an <%ae>%n%cn <%ce>", "HEAD")).toBe("AgentOrg Skills Snapshot <skills@agentorg.invalid>\nAgentOrg Skills Snapshot <skills@agentorg.invalid>");
    expect(await gitWithTimeout(repo, 10_000, "remote")).toBe("");
    expect((await gitWithTimeout(repo, 10_000, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(/\s+/)).toHaveLength(1);
    expect(await gitWithTimeout(repo, 10_000, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await readFile(join(repo, "binary.bin"))).toEqual(bytes);
    expect(await readFile(join(repo, "ignored.txt"), "utf8")).toBe("keep ignored payload\n");
    expect(await readFile(join(repo, "content.txt"), "utf8")).toBe("$Id$\r\nplain\r\n");
    expect((await (await import("node:fs/promises")).stat(executable)).mode & 0o111).not.toBe(0);
    expect((await gitWithTimeout(repo, 10_000, "config", "user.name"))).toBe("AgentOrg Skills Snapshot");
    expect((await gitWithTimeout(repo, 10_000, "config", "user.email"))).toBe("skills@agentorg.invalid");
    expect(await gitWithTimeout(repo, 10_000, "config", "core.hooksPath")).toBe("/dev/null");
    expect(await gitWithTimeout(repo, 10_000, "rev-parse", "HEAD:binary.bin")).toBe(await gitWithTimeout(repo, 10_000, "hash-object", "--no-filters", "--", "binary.bin"));
    await expect((await import("node:fs/promises")).access(join(repo, ".git", "objects", "info", "alternates"))).rejects.toThrow();

    const template = join(root, "template"), hook = join(template, "hooks", "post-checkout"), marker = join(root, "hook-ran");
    await mkdir(join(template, "hooks"), { recursive: true });
    await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`); await chmod(hook, 0o700);
    process.env.GIT_TEMPLATE_DIR = template;
    const clone = join(root, "clone");
    try { await cloneLocalSnapshot(repo, clone, 10_000); }
    finally { delete process.env.GIT_TEMPLATE_DIR; }
    await expect((await import("node:fs/promises")).access(marker)).rejects.toThrow();
    expect(await readFile(join(clone, "content.txt"))).toEqual(await readFile(join(repo, "content.txt")));
    expect(await readFile(join(clone, "binary.bin"))).toEqual(bytes);
    expect(await gitWithTimeout(clone, 10_000, "status", "--porcelain")).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshot verification accommodates thousands of long filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-git-longnames-")), repo = join(root, "repo");
  await mkdir(repo);
  try {
    for (let i = 0; i < 5_000; i++) await writeFile(join(repo, `${String(i).padStart(4, "0")}-${"x".repeat(220)}`), "x");
    await initializeLocalSnapshot(repo, 30_000);
    expect(await gitWithTimeout(repo, 10_000, "rev-list", "--count", "HEAD")).toBe("1");
  } finally { await rm(root, { recursive: true, force: true }); }
});
