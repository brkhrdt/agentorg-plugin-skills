import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { git } from "../src/git.ts";

let root: string | undefined;
let server: OrganizationServer | undefined;
let client: OrganizationClient | undefined;
let priorPath: string | undefined;
let priorEntered: string | undefined;
let priorRelease: string | undefined;
let releaseGate: string | undefined;
afterEach(async () => {
  if (releaseGate) await writeFile(releaseGate, "release").catch(() => {});
  client?.close(); client = undefined;
  if (server) await server.close(); server = undefined;
  if (priorPath !== undefined) process.env.PATH = priorPath;
  if (priorEntered === undefined) delete process.env.SKILLS_CLONE_ENTERED; else process.env.SKILLS_CLONE_ENTERED = priorEntered;
  if (priorRelease === undefined) delete process.env.SKILLS_CLONE_RELEASE; else process.env.SKILLS_CLONE_RELEASE = priorRelease;
  priorPath = undefined; priorEntered = undefined; priorRelease = undefined; releaseGate = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for live repository reconciliation");
    await Bun.sleep(20);
  }
};

test.serial("repository settings reconcile live after commit without restarting and enforce removal immediately", async () => {
  root = await mkdtemp(join(tmpdir(), "skills-live-settings-"));
  const dataDir = join(root, "data"), socketPath = join(dataDir, "server.sock");
  const home = join(root, "home"), repo = join(root, "repo"), bin = join(root, "bin");
  await Promise.all([mkdir(home), mkdir(repo), mkdir(bin)]);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "SKILL.md"), "---\nname: alpha\ndescription: Alpha live fixture\n---\n# Instructions\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "live fixture");

  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const entered = join(root, "clone-entered"), release = join(root, "clone-release"), shim = join(bin, "git");
  releaseGate = release;
  await writeFile(shim, `#!/bin/sh
case " $* " in
  *" clone "*) touch "$SKILLS_CLONE_ENTERED"; while [ ! -e "$SKILLS_CLONE_RELEASE" ]; do sleep 0.01; done ;;
esac
exec ${realGit} "$@"
`);
  await chmod(shim, 0o700);
  priorPath = process.env.PATH;
  priorEntered = process.env.SKILLS_CLONE_ENTERED;
  priorRelease = process.env.SKILLS_CLONE_RELEASE;
  process.env.PATH = `${bin}:${priorPath ?? "/usr/bin:/bin"}`;
  process.env.SKILLS_CLONE_ENTERED = entered;
  process.env.SKILLS_CLONE_RELEASE = release;

  const pid = process.pid;
  server = await OrganizationServer.start({ dataDir, socketPath, plugins: [createSkillsPlugin({ home, allowLocalSources: true })] });
  client = await OrganizationClient.connect(socketPath);
  const update = await client.request<any>("organization.settings.update", {
    namespace: "skills", expectedRevision: 0,
    patch: { repositories: [{ name: "alpha", gitUrl: repo }] },
  });
  expect(update.revision).toBe(1);
  expect(update.values.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
  expect(process.pid).toBe(pid);
  expect((await client.request<any>("organization.snapshot")).seq).toBeGreaterThanOrEqual(0);

  // A post-commit import must run independently: the settings response and
  // unrelated reads remain available while the local clone is deliberately blocked.
  await waitFor(async () => Bun.file(entered).exists());
  const whileBlocked = await client.request<any>("organization.settings.get", { namespace: "skills" });
  expect(whileBlocked.values.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
  expect(whileBlocked.effective.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
  expect((await client.request<any>("skills.list")).skills).toEqual([]);

  await writeFile(release, "release");
  await waitFor(async () => (await client!.request<any>("skills.list")).skills.some((skill: any) => skill.name === "alpha"));
  const added = await client.request<any>("skills.list");
  expect(added.skills.map((skill: any) => skill.name)).toEqual(["alpha"]);

  const removed = await client.request<any>("organization.settings.update", {
    namespace: "skills", expectedRevision: 1, patch: { repositories: [] },
  });
  expect(removed.revision).toBe(2);
  expect(removed.values.repositories).toEqual([]);
  expect(removed.effective.repositories).toEqual([]);
  expect((await client.request<any>("skills.list")).skills).toEqual([]);
  expect(process.pid).toBe(pid);
}, 15_000);
