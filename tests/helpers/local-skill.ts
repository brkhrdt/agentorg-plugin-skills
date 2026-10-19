import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A plain, non-Git local skill tree for local-import contract tests. */
export async function createLocalSkillFixture() {
  const root = await mkdtemp(join(tmpdir(), "skills-local-import-"));
  const path = join(root, "local-skill");
  await mkdir(join(path, "scripts"), { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: fixture-skill\ndescription: Local import contract fixture\n---\n\nFixture instructions.\n");
  const executable = join(path, "scripts", "run.sh");
  await writeFile(executable, "#!/bin/sh\necho fixture\n");
  await chmod(executable, 0o755);
  await writeFile(join(path, "asset.bin"), Buffer.from([0, 255, 1, 128]));
  await writeFile(join(path, ".gitignore"), "ignored-payload.txt\n");
  await writeFile(join(path, "ignored-payload.txt"), "ignored fixture payload\n");
  return {
    root,
    path,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
