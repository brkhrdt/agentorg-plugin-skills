import { fileExists } from "./helpers/runtime.ts";
import { expect, test } from "vitest";
import { Database } from "../src/sqlite.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { Store } from "../../agentorg/src/store.ts";
import { git } from "../src/git.ts";
import { createSkillHarnessPlugin } from "./fixtures/skill-harness.ts";

async function repository(path: string, name = "workspace-skill") {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture\n---\nInstructions\n`);
  await git(path, "init", "--initial-branch=main");
  await git(path, "config", "user.name", "Fixture");
  await git(path, "config", "user.email", "fixture@example.invalid");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "committed skill");
}

async function plugin(home: string) {
  const bundlePath = process.env.SKILLS_PLUGIN_BUNDLE;
  if (!bundlePath) return createSkillsPlugin({ home });
  const bundled = await import(pathToFileURL(resolve(bundlePath)).href) as typeof import("../src/index.ts");
  return bundled.createSkillsPlugin({ home });
}

function options(root: string, dataDir: string, home: string, accessPaths: Array<{ path: string; mode?: "sqlite-header" }> = []) {
  return {
    dataDir,
    socketPath: join(dataDir, "org.sock"),
    plugins: [
      createSkillHarnessPlugin({
        nodeExecutable: process.execPath,
        consumerPath: join(import.meta.dirname, "fixtures/skill-consumer.ts"),
        proofPath: join(root, "proof.jsonl"),
        accessPaths,
      }),
    ],
  };
}

async function createConfiguredOptions(root: string, dataDir: string, home: string, accessPaths: Array<{ path: string; mode?: "sqlite-header" }> = []) {
  const hostOptions = options(root, dataDir, home, accessPaths);
  hostOptions.plugins.push(await plugin(home));
  return hostOptions;
}

async function closeHost(client?: OrganizationClient, server?: OrganizationServer) {
  client?.close();
  await server?.close();
}

async function proofRecords(root: string) {
  return (await readFile(join(root, "proof.jsonl"), "utf8")).trim().split("\n").map((line: string) => JSON.parse(line));
}

async function promptProofs(root: string) {
  return (await proofRecords(root)).filter((entry: any) => entry.event === "prompt");
}

async function launchProofs(root: string) {
  return (await proofRecords(root)).filter((entry: any) => entry.event === "launch");
}

async function restartedFailure(hostOptions: ReturnType<typeof options>, expectedCode: string, message: RegExp) {
  let failure: any;
  try {
    const unexpectedServer = await OrganizationServer.start(hostOptions);
    await unexpectedServer.close();
  } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(failure.code).toBe(expectedCode);
  expect(failure.message).toMatch(message);
}

test("workspace-backed stores permit active cwd modification and spawned reads across restart", async () => {
  for (const mode of ["equal", "contains"] as const) {
    const root = await mkdtemp(join(tmpdir(), `skills-workspace-store-positive-${mode}-`));
    const dataDir = join(root, "server-data"), home = join(root, "home"), initialCwd = join(root, "initial-workspace");
    const store = mode === "equal" ? join(root, "workspace") : join(root, "repo-store");
    const cwd = mode === "equal" ? store : join(store, "workspace");
    await mkdir(dataDir, { recursive: true }); await mkdir(home, { recursive: true }); await mkdir(initialCwd, { recursive: true }); await mkdir(cwd, { recursive: true });
    const catalogSkill = join(store, "workspace-skill");
    await repository(catalogSkill);
    const hostOptions = await createConfiguredOptions(root, dataDir, home, [{ path: join(catalogSkill, "SKILL.md") }]);
    let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
    try {
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd: initialCwd } }));
      expect(created.status, JSON.stringify(created)).toBe("completed");
      const moved = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { cwd } }));
      expect(moved.status, JSON.stringify(moved)).toBe("completed");
      const prompt = async (text: string) => {
        const operation = await client!.request<any>("agent.prompt", { agentId: created.agentId, text });
        expect((await client!.wait(operation)).status, JSON.stringify(operation)).toBe("completed");
      };
      await prompt("read catalog from overlapping store");
      const overlapProof = (await promptProofs(root)).at(-1);
      expect(overlapProof.access).toEqual([{ path: join(catalogSkill, "SKILL.md"), content: expect.stringContaining("Instructions") }]);
      expect(overlapProof.content).toBe("");

      expect((await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }))).status).toBe("completed");
      await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: store } });
      client.close(); client = undefined; await server.close(); server = undefined;

      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const discovered = await client.request<any>("skills.list");
      expect(discovered.skills.map((skill: any) => skill.path)).toEqual([catalogSkill]);
      expect(discovered.skills.some((skill: any) => skill.path.includes(".agents") || skill.path === cwd)).toBe(false);
      const selected = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { extensions: { skills: { "workspace-skill": "installed" } } } }));
      expect(selected.status, JSON.stringify(selected)).toBe("completed");
      const installed = join(cwd, ".agents", "skills", "workspace-skill");
      expect(await fileExists(join(dataDir, "skills.sqlite"))).toBe(true);
      expect(await fileExists(join(cwd, "skills.sqlite"))).toBe(false);
      const launched = await client.wait(await client.request<any>("agent.restart", { agentId: created.agentId }));
      expect(launched.status, JSON.stringify(launched)).toBe("completed");
      await prompt("read installed skill");
      const proof = (await promptProofs(root)).at(-1);
      expect(proof.paths).toEqual([join(installed, "SKILL.md")]);
      expect(proof.content).toContain("Instructions");
      expect(proof.access[0].content).toContain("Instructions");
      expect(await git(catalogSkill, "status", "--porcelain")).toBe("");
      expect(await git(installed, "status", "--porcelain")).toBe("");
      expect(await git(installed, "rev-parse", "HEAD")).toBe(await git(catalogSkill, "rev-parse", "HEAD"));

      expect((await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }))).status).toBe("completed");
      client.close(); client = undefined; await server.close(); server = undefined;
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const afterRestart = await client.request<any>("skills.list");
      expect(afterRestart.skills.map((skill: any) => skill.path)).toEqual([catalogSkill]);
      expect(afterRestart.skills.some((skill: any) => skill.path.includes(".agents") || skill.path.includes("workspace/.agents"))).toBe(false);
      const db = new Database(join(dataDir, "skills.sqlite"));
      try {
        const rows = db.query("SELECT data FROM installations").all() as Array<{ data: string }>;
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.data).path).toBe(installed);
      } finally { db.close(); }
      expect(await git(catalogSkill, "status", "--porcelain")).toBe("");
      expect(await git(installed, "status", "--porcelain")).toBe("");
      const relaunched = await client.wait(await client.request<any>("agent.restart", { agentId: created.agentId }));
      expect(relaunched.status, JSON.stringify(relaunched)).toBe("completed");
      await prompt("read installed skill after server restart");
      const nextProof = (await promptProofs(root)).at(-1);
      expect(nextProof.paths).toEqual([join(installed, "SKILL.md")]);
      expect(nextProof.content).toContain("Instructions");
    } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
  }
});

test("active cwd modification and session replacement retain reads in the configured overlapping dataDir/store", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-active-overlap-session-"));
  const dataDir = join(root, ".org"), home = join(root, "home"), store = join(dataDir, "skills");
  const initialCwd = join(root, "initial-workspace"), cwd = join(store, "agent-workspace");
  await mkdir(store, { recursive: true }); await mkdir(home, { recursive: true });
  await mkdir(initialCwd, { recursive: true }); await mkdir(cwd, { recursive: true });
  const catalogSkill = join(store, "overlap-skill"); await repository(catalogSkill, "overlap-skill");
  const sentinel = join(dataDir, "overlap-sentinel.txt"); await writeFile(sentinel, "configured-overlap-data-proof");
  const installed = join(cwd, ".agents", "skills", "overlap-skill");
  const hostOptions = await createConfiguredOptions(root, dataDir, home, [
    { path: sentinel },
    { path: join(installed, "SKILL.md") },
    { path: join(installed, ".git", "agentorg-skills.json") },
  ]);
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
    const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd: initialCwd } }));
    expect(created.status, JSON.stringify(created)).toBe("completed");
    const moved = await client.wait(await client.request<any>("agent.modify", {
      agentId: created.agentId,
      settings: { cwd, extensions: { skills: { "overlap-skill": "installed" } } },
    }));
    expect(moved.status, JSON.stringify(moved)).toBe("completed");

    const promptAndAssertReads = async (text: string) => {
      const operation = await client!.request<any>("agent.prompt", { agentId: created.agentId, text });
      const completed = await client!.wait(operation);
      expect(completed.status, JSON.stringify(completed)).toBe("completed");
      const proof = (await promptProofs(root)).filter((entry: any) => entry.agentId === created.agentId).at(-1);
      expect(proof.cwd).toBe(cwd);
      expect(proof.paths).toEqual([join(installed, "SKILL.md")]);
      expect(proof.content).toContain("Instructions");
      expect(proof.access[0].content).toBe("configured-overlap-data-proof");
      expect(proof.access[1].content).toContain("Instructions");
      expect(proof.access[2].content).toContain('"agentId"');
      return proof;
    };
    await promptAndAssertReads("prove active cwd modification reads");
    const beforeReplace = await client.request<any>("agent.get", { agentId: created.agentId });
    const replaced = await client.wait(await client.request<any>("agent.replace_session", { agentId: created.agentId }));
    expect(replaced.status, JSON.stringify(replaced)).toBe("completed");
    const afterReplace = await client.request<any>("agent.get", { agentId: created.agentId });
    expect(afterReplace.sessionId).not.toBe(beforeReplace.sessionId);
    await promptAndAssertReads("prove replacement session reads");
  } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
});

test("workspace overlap permits nested stores while preserving installation-root and removed-agent boundaries", async () => {
  for (const mode of ["nested", "install-equal", "install-inside", "sibling-prefix", "removed"] as const) {
    const root = await mkdtemp(join(tmpdir(), `skills-workspace-store-control-${mode}-`));
    const dataDir = join(root, "server-data"), home = join(root, "home"), cwd = join(root, "workspace");
    const store = mode === "nested" ? join(cwd, "repo-store")
      : mode === "install-equal" ? join(cwd, ".agents", "skills")
      : mode === "install-inside" ? join(cwd, ".agents", "skills", "repo-store")
      : mode === "sibling-prefix" ? join(root, "workspace-neighbor") : join(cwd, "repo-store");
    await mkdir(dataDir, { recursive: true }); await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true });
    if (mode === "install-equal" || mode === "install-inside") await mkdir(join(cwd, ".agents", "skills"), { recursive: true });
    const hostOptions = await createConfiguredOptions(root, dataDir, home);
    let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
    try {
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd } }));
      expect(created.status, JSON.stringify(created)).toBe("completed");
      if (mode === "removed") await client.wait(await client.request<any>("agent.remove", { agentId: created.agentId }));
      else await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
      await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: store } });
      client.close(); client = undefined; await server.close(); server = undefined;
      if (["install-equal", "install-inside"].includes(mode)) {
        await restartedFailure(hostOptions, "INVALID_PATH", /installation root/i);
      } else {
        server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
        expect((await client.request<any>("organization.snapshot", {})).agents).toHaveLength(1);
      }
    } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
  }
});

test("dataDir overlap allows spawned skill agents to read data, catalog, and metadata on restart", async () => {
  for (const mode of ["equal", "data-ancestor", "workspace-ancestor"] as const) {
    const root = await mkdtemp(join(tmpdir(), `skills-data-overlap-${mode}-`));
    const dataDir = mode === "equal" ? join(root, "workspace")
      : mode === "workspace-ancestor" ? join(root, "workspace", ".org") : join(root, ".org");
    const cwd = mode === "equal" ? dataDir
      : mode === "data-ancestor" ? join(dataDir, "workspace") : join(root, "workspace");
    const home = join(root, "home"), store = join(dataDir, "skills");
    await mkdir(store, { recursive: true }); await mkdir(cwd, { recursive: true }); await mkdir(home, { recursive: true });
    const catalogSkill = join(store, "data-skill");
    await repository(catalogSkill, "data-skill");
    const sentinel = join(dataDir, "read-sentinel.txt"); await writeFile(sentinel, `data:${mode}`);
    const installed = join(cwd, ".agents", "skills", "data-skill");
    const accessPaths = [
      { path: sentinel },
      { path: join(dataDir, "skills.sqlite"), mode: "sqlite-header" as const },
      { path: join(catalogSkill, "SKILL.md") },
      { path: join(installed, ".git", "agentorg-skills.json") },
    ];
    const hostOptions = await createConfiguredOptions(root, dataDir, home, accessPaths);
    let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
    try {
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd, extensions: { skills: { "data-skill": "installed" } } } }));
      expect(created.status, JSON.stringify(created)).toBe("completed");
      const prompt = async () => {
        const operation = await client!.request<any>("agent.prompt", { agentId: created.agentId, text: "probe" });
        expect((await client!.wait(operation)).status).toBe("completed");
      };
      await prompt();
      const stopped = await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
      expect(stopped.status, JSON.stringify(stopped)).toBe("completed");
      client.close(); client = undefined; await server.close(); server = undefined;
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      expect((await client.request<any>("organization.snapshot", {})).agents).toHaveLength(1);
      const relaunched = await client.wait(await client.request<any>("agent.restart", { agentId: created.agentId }));
      expect(relaunched.status, JSON.stringify(relaunched)).toBe("completed");
      await prompt();
      const proofs = await promptProofs(root);
      expect(proofs).toHaveLength(2);
      for (const proof of proofs) {
        expect(proof.paths).toEqual([join(installed, "SKILL.md")]);
        expect(proof.content).toContain("Instructions");
        expect(proof.access[0].content).toBe(`data:${mode}`);
        expect(proof.access[1]).toEqual({ path: join(dataDir, "skills.sqlite"), bytesRead: 16, header: "SQLite format 3\u0000" });
        expect(proof.access[2].content).toContain("Instructions");
        expect(proof.access[3].content).toContain('"agentId"');
      }
    } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
  }
});

test.each([true, false])("overlapping installed-skill agent recovery (recover=%s) launches only when enabled", async recover => {
  const root = await mkdtemp(join(tmpdir(), `skills-overlap-recovery-${recover}-`));
  const dataDir = join(root, ".org"), home = join(root, "home"), store = join(dataDir, "skills");
  const parentCwd = join(root, "parent-workspace"), childCwd = join(store, "child-workspace");
  await mkdir(dataDir, { recursive: true }); await mkdir(home, { recursive: true });
  await mkdir(parentCwd, { recursive: true }); await mkdir(childCwd, { recursive: true });
  const catalogSkill = join(store, "recovery-skill"); await repository(catalogSkill, "recovery-skill");
  const sentinel = join(dataDir, "recovery-sentinel.txt"); await writeFile(sentinel, "recovery-data-dir-proof");
  const installedSkill = join(childCwd, ".agents", "skills", "recovery-skill", "SKILL.md");
  const hostOptions = await createConfiguredOptions(root, dataDir, home, [{ path: sentinel }, { path: installedSkill }]);
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
    const parentCreated = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd: parentCwd } }));
    expect(parentCreated.status, JSON.stringify(parentCreated)).toBe("completed");
    const parentId = parentCreated.agentId;
    const childCreated = await client.wait(await client.request<any>("agent.create", { parentId, settings: { harness: "skill-consumer", model: "test", cwd: childCwd, extensions: { skills: { "recovery-skill": "installed" } } } }));
    expect(childCreated.status, JSON.stringify(childCreated)).toBe("completed");
    const childId = childCreated.agentId;
    const promptChild = async (label: string) => {
      const operation = await client!.request<any>("agent.prompt", { agentId: childId, text: label });
      const completed = await client!.wait(operation);
      expect(completed.status, JSON.stringify(completed)).toBe("completed");
      const proof = (await promptProofs(root)).filter((entry: any) => entry.agentId === childId).at(-1);
      expect(proof.cwd).toBe(childCwd);
      expect(proof.paths).toEqual([installedSkill]);
      expect(proof.content).toContain("Instructions");
      expect(proof.access.map((entry: any) => entry.content)).toEqual(["recovery-data-dir-proof", expect.stringContaining("Instructions")]);
      return proof;
    };
    await promptChild("before simulated crash");
    const initialLaunchCount = (await launchProofs(root)).length;
    expect(initialLaunchCount).toBe(2);
    expect((await client.request<any>("agent.get", { agentId: childId })).settings.cwd).toBe(childCwd);

    await closeHost(client, server); client = undefined; server = undefined;
    // Model an abrupt prior process termination: graceful close marks records stopped, so
    // restore persisted eligibility only, leaving generations/session/skill metadata intact.
    const persisted = new Store(join(dataDir, "organization.sqlite"));
    try {
      for (const agent of persisted.agents())
        if (agent.id === parentId || agent.id === childId) persisted.saveAgent({ ...agent, state: "running" });
    } finally { persisted.close(); }

    server = await OrganizationServer.start({ ...hostOptions, recover });
    client = await OrganizationClient.connect(hostOptions.socketPath);
    const snapshot = await client.request<any>("organization.snapshot", {});
    expect(snapshot.agents.find((agent: any) => agent.id === parentId).state).toBe(recover ? "idle" : "stopped");
    expect(snapshot.agents.find((agent: any) => agent.id === childId).state).toBe(recover ? "idle" : "stopped");
    let launches = await launchProofs(root);
    if (recover) {
      expect(launches).toHaveLength(initialLaunchCount + 2);
      expect(launches.slice(-2).map((entry: any) => entry.agentId)).toEqual([parentId, childId]);
      await promptChild("after automatic recovery");
      const restarted = await client.wait(await client.request<any>("agent.restart_subtree", { agentId: parentId }));
      expect(restarted.status, JSON.stringify(restarted)).toBe("completed");
      launches = await launchProofs(root);
      expect(launches).toHaveLength(initialLaunchCount + 4);
      expect(launches.slice(-2).map((entry: any) => entry.agentId)).toEqual([parentId, childId]);
      await promptChild("after overlapping subtree restart");
    } else {
      expect(launches).toHaveLength(initialLaunchCount);
      const explicit = await client.wait(await client.request<any>("agent.restart", { agentId: childId }));
      expect(explicit.status, JSON.stringify(explicit)).toBe("completed");
      launches = await launchProofs(root);
      expect(launches).toHaveLength(initialLaunchCount + 1);
      expect(launches.at(-1).agentId).toBe(childId);
      await promptChild("after explicit restart following recover false");
    }
  } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
});

test("skills store equal to or containing dataDir keeps setup-time rejection", async () => {
  for (const mode of ["equal", "contains"] as const) {
    const root = await mkdtemp(join(tmpdir(), `skills-store-data-setup-${mode}-`));
    const dataDir = join(root, "data"), home = join(root, "home"), store = mode === "equal" ? dataDir : root;
    await mkdir(dataDir, { recursive: true }); await mkdir(home, { recursive: true });
    const hostOptions = await createConfiguredOptions(root, dataDir, home);
    let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
    try {
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: store } });
      client.close(); client = undefined; await server.close(); server = undefined;
      await restartedFailure(hostOptions, "INVALID_PARAMS", /Skills store directory must not be the server data directory or its ancestor/);
    } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
  }
});

test("symlinked store and managed install path are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-store-symlink-control-"));
  const dataDir = join(root, "data"), home = join(root, "home"), target = join(root, "store-target"), link = join(root, "store-link");
  await mkdir(dataDir, { recursive: true }); await mkdir(home, { recursive: true }); await mkdir(target); await symlink(target, link);
  const hostOptions = await createConfiguredOptions(root, dataDir, home);
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
    await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: link } });
    client.close(); client = undefined; await server.close(); server = undefined;
    await restartedFailure(hostOptions, "INVALID_PARAMS", /cannot traverse a symlink/i);
  } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }

  const installCase = await mkdtemp(join(tmpdir(), "skills-install-symlink-control-"));
  const installData = join(installCase, "data"), installHome = join(installCase, "home"), cwd = join(installCase, "workspace"), external = join(installCase, "external-install");
  await mkdir(join(installData, "skills"), { recursive: true }); await mkdir(installHome); await mkdir(cwd); await mkdir(join(cwd, ".agents")); await mkdir(external);
  await repository(join(installData, "skills", "selected-skill"), "selected-skill");
  await symlink(external, join(cwd, ".agents", "skills"));
  const installOptions = await createConfiguredOptions(installCase, installData, installHome);
  try {
    server = await OrganizationServer.start(installOptions); client = await OrganizationClient.connect(installOptions.socketPath);
    const result = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd, extensions: { skills: { "selected-skill": "installed" } } } }));
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/cannot traverse a symlink/i);
    expect(await readdir(external)).toEqual([]);
  } finally { await closeHost(client, server); await rm(installCase, { recursive: true, force: true }); }
});
