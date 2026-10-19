import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import type { Operation, AgentRecord } from "../../agentorg/src/types.ts";
import type { ServerPlugin } from "../../agentorg/src/plugin.ts";
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

const promptly = async <T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Settings update exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};

test.serial("repository settings reconcile live after commit without restarting and enforce removal immediately", async () => {
  root = await mkdtemp(join(tmpdir(), "skills-live-settings-"));
  const dataDir = join(root, "data"), socketPath = join(dataDir, "server.sock");
  const home = join(root, "home"), repo = join(root, "repo"), bin = join(root, "bin"), workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(repo), mkdir(bin), mkdir(workspace)]);
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

  const harness: ServerPlugin = { apiVersion: 1, name: "live-settings-fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch: context => ({
      command: process.execPath,
      args: [join(import.meta.dir, "../../agentorg/tests/fixtures/agent.ts")],
      cwd: context.agent.settings.cwd ?? process.cwd(),
      env: { ...process.env, ORG_SOCKET: context.socketPath, ORG_TOKEN: context.token },
    }) });
  } };
  const pid = process.pid;
  server = await OrganizationServer.start({ dataDir, socketPath, plugins: [harness, createSkillsPlugin({ home, allowLocalSources: true })] });
  client = await OrganizationClient.connect(socketPath);
  const created = await client.wait(await client.request<Operation>("agent.create", {
    parentId: null, settings: { harness: "fixture", model: "test", cwd: workspace },
  }));
  expect(created.status).toBe("completed");
  const agent = created.result as AgentRecord;
  const update = await promptly(client.request<any>("organization.settings.update", {
    namespace: "skills", expectedRevision: 0,
    patch: { repositories: [{ name: "alpha", gitUrl: repo }] },
  }));
  expect(update.revision).toBe(1);
  expect(update.values.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
  expect(update.effective.repositories).toEqual(update.values.repositories);
  expect(update.restartRequired).toEqual([]);
  expect(process.pid).toBe(pid);
  expect((await client.request<any>("organization.snapshot")).seq).toBeGreaterThanOrEqual(0);

  // A post-commit import must run independently: the settings response and
  // unrelated reads remain available while the local clone is deliberately blocked.
  await waitFor(async () => Bun.file(entered).exists());
  const whileBlocked = await client.request<any>("organization.settings.get", { namespace: "skills" });
  expect(whileBlocked.values.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
  expect(whileBlocked.effective.repositories).toEqual([{ name: "alpha", gitUrl: repo }]);
  expect((await client.request<any>("skills.list")).skills).toEqual([]);

  // Remove while the original clone is still blocked. That stale completion
  // must remain unregistered and cannot create a grantable catalog entry.
  const removedDuringClone = await promptly(client.request<any>("organization.settings.update", {
    namespace: "skills", expectedRevision: 1, patch: { repositories: [] },
  }));
  expect(removedDuringClone.revision).toBe(2);
  expect(removedDuringClone.values.repositories).toEqual([]);
  expect(removedDuringClone.effective.repositories).toEqual([]);
  expect((await client.request<any>("skills.list")).skills.map((skill: any) => skill.name)).not.toContain("alpha");
  await expect(server.organization.request("skills.reconcile", {}, { kind: "agent", id: agent.id })).rejects.toThrow("client-only");
  const staleGrant = await client.wait(await client.request<Operation>("agent.modify", {
    agentId: agent.id, settings: { extensions: { skills: { alpha: "available" } } },
  }));
  expect(staleGrant.status).toBe("failed");
  await writeFile(release, "release");
  await waitFor(async () => {
    const result = await client!.request<any>("skills.list");
    return result.reconciliation.desiredRevision === 2 && result.reconciliation.state === "ready";
  });
  expect((await client.request<any>("skills.list")).skills).toEqual([]);

  // Re-add using the same socket/server; the completed retained checkout must
  // not be mistaken for a stale grant, and the current desired identity wins.
  const readded = await client.request<any>("organization.settings.update", {
    namespace: "skills", expectedRevision: 2, patch: { repositories: [{ name: "alpha", gitUrl: repo }] },
  });
  expect(readded.revision).toBe(3);
  await waitFor(async () => (await client!.request<any>("skills.list")).skills.some((skill: any) => skill.name === "alpha"));
  const added = await client.request<any>("skills.list");
  expect(added.skills.map((skill: any) => skill.name)).toEqual(["alpha"]);

  const removed = await client.request<any>("organization.settings.update", {
    namespace: "skills", expectedRevision: 3, patch: { repositories: [] },
  });
  expect(removed.revision).toBe(4);
  expect(removed.values.repositories).toEqual([]);
  expect(removed.effective.repositories).toEqual([]);
  const afterRemoval = await client.request<any>("skills.list");
  expect(afterRemoval.skills.map((skill: any) => skill.name)).not.toContain("alpha");
  const deniedGrant = await client.wait(await client.request<Operation>("agent.modify", {
    agentId: agent.id, settings: { extensions: { skills: { alpha: "available" } } },
  }));
  expect(deniedGrant.status).toBe("failed");
  const unchanged = await client.request<AgentRecord>("agent.get", { agentId: agent.id });
  expect((unchanged.settings.extensions?.skills as Record<string, string> | undefined)?.alpha).toBeUndefined();
  expect(process.pid).toBe(pid);
}, 15_000);
