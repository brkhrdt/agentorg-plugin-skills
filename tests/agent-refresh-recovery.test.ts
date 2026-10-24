import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayGenerationMove, removeVerifiedStage } from "../src/agent-refresh.ts";

async function exists(path: string) { try { await access(path); return true; } catch { return false; } }

test.each(["before-renames", "after-old-rename", "after-both-renames"] as const)("generation journal replay converges after %s and repeated restart", async boundary => {
  const root = await mkdtemp(join(tmpdir(), "skills-refresh-replay-"));
  const dest = join(root, "installed"), stage = join(root, "stage"), backup = join(root, "backup");
  try {
    await mkdir(dest); await mkdir(stage);
    await writeFile(join(dest, "generation"), "old"); await writeFile(join(stage, "generation"), "new");
    const oldMove = { from: dest, to: backup, generation: "old" }, newMove = { from: stage, to: dest, generation: "new" };
    const verify = async (path: string, generation: string) => { if ((await readFile(join(path, "generation"), "utf8")) !== generation) throw new Error(`wrong generation in ${path}`); };
    const ensureParent = async (path: string) => { await mkdir(join(path, ".."), { recursive: true }); };
    if (boundary !== "before-renames") await replayGenerationMove(oldMove, exists, verify, ensureParent);
    if (boundary === "after-both-renames") await replayGenerationMove(newMove, exists, verify, ensureParent);
    await replayGenerationMove(oldMove, exists, verify, ensureParent);
    await replayGenerationMove(newMove, exists, verify, ensureParent);
    // Simulate another restart/replay: destinations carry their generation identity.
    await replayGenerationMove(oldMove, exists, verify, ensureParent);
    await replayGenerationMove(newMove, exists, verify, ensureParent);
    expect(await readFile(join(backup, "generation"), "utf8")).toBe("old");
    expect(await readFile(join(dest, "generation"), "utf8")).toBe("new");
    expect(await exists(stage)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stage cleanup requires the persisted inode and a matching generation marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-refresh-cleanup-")), stage = join(root, "stage");
  try {
    await mkdir(stage); await writeFile(join(stage, "marker"), "generation-1");
    const info = await import("node:fs/promises").then(fs => fs.lstat(stage));
    await expect(removeVerifiedStage(stage, { device: info.dev, inode: info.ino + 1 }, async () => {})).rejects.toThrow(/Unverified/);
    expect(await exists(stage)).toBe(true);
    await expect(removeVerifiedStage(stage, { device: info.dev, inode: info.ino }, async path => {
      if (await readFile(join(path, "marker"), "utf8") !== "generation-1") throw new Error("marker mismatch");
    })).resolves.toBeUndefined();
    expect(await exists(stage)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generation replay rejects a destination owned by a different generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-refresh-collision-")), source = join(root, "source"), target = join(root, "target");
  try {
    await mkdir(source); await mkdir(target); await writeFile(join(source, "generation"), "old"); await writeFile(join(target, "generation"), "attacker");
    await expect(replayGenerationMove({ from: source, to: target, generation: "old" }, exists,
      async (path, generation) => { if (await readFile(join(path, "generation"), "utf8") !== generation) throw new Error("identity mismatch"); }, async () => {})).rejects.toThrow("identity mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});
