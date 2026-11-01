import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { createSkillsPlugin } from "../src/index.ts";
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

function options(root: string, dataDir: string, home: string) {
  return {
    dataDir,
    socketPath: join(dataDir, "org.sock"),
    plugins: [
      createSkillHarnessPlugin({
        bunExecutable: process.execPath,
        consumerPath: join(import.meta.dir, "fixtures/skill-consumer.ts"),
        proofPath: join(root, "proof.jsonl"),
      }),
    ],
  };
}

async function createConfiguredOptions(root: string, dataDir: string, home: string) {
  const hostOptions = options(root, dataDir, home);
  hostOptions.plugins.push(await plugin(home));
  return hostOptions;
}

async function closeHost(client?: OrganizationClient, server?: OrganizationServer) {
  client?.close();
  await server?.close();
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

test("workspace-backed store installations launch explicitly and survive restart", async () => {
  for (const mode of ["equal", "contains"] as const) {
    const root = await mkdtemp(join(tmpdir(), `skills-workspace-store-positive-${mode}-`));
    const dataDir = join(root, "server-data"), home = join(root, "home");
    const store = mode === "equal" ? join(root, "workspace") : join(root, "repo-store");
    const cwd = mode === "equal" ? store : join(store, "workspace");
    await mkdir(dataDir, { recursive: true }); await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true });
    await repository(join(store, "workspace-skill"));
    const hostOptions = await createConfiguredOptions(root, dataDir, home);
    let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
    try {
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd } }));
      expect(created.status, JSON.stringify(created)).toBe("completed");
      await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
      await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: store } });
      client.close(); client = undefined; await server.close(); server = undefined;

      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const discovered = await client.request<any>("skills.list");
      expect(discovered.skills.map((skill: any) => skill.path)).toEqual([join(store, "workspace-skill")]);
      expect(discovered.skills.some((skill: any) => skill.path.includes(".agents") || skill.path === cwd)).toBe(false);
      const selected = await client.wait(await client.request<any>("agent.modify", { agentId: created.agentId, settings: { extensions: { skills: { "workspace-skill": "installed" } } } }));
      expect(selected.status, JSON.stringify(selected)).toBe("completed");
      const installed = join(cwd, ".agents", "skills", "workspace-skill");
      expect(await Bun.file(join(dataDir, "skills.sqlite")).exists()).toBe(true);
      expect(await Bun.file(join(cwd, "skills.sqlite")).exists()).toBe(false);
      const launched = await client.wait(await client.request<any>("agent.restart", { agentId: created.agentId }));
      expect(launched.status, JSON.stringify(launched)).toBe("completed");
      const proof = (await readFile(join(root, "proof.jsonl"), "utf8")).trim().split("\n").map((line: string) => JSON.parse(line)).at(-1);
      expect(proof.files).toEqual([join(installed, "SKILL.md")]);
      expect(await git(join(store, "workspace-skill"), "status", "--porcelain")).toBe("");
      expect(await git(installed, "status", "--porcelain")).toBe("");
      expect(await git(installed, "rev-parse", "HEAD")).toBe(await git(join(store, "workspace-skill"), "rev-parse", "HEAD"));

      await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
      client.close(); client = undefined; await server.close(); server = undefined;
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const afterRestart = await client.request<any>("skills.list");
      expect(afterRestart.skills.map((skill: any) => skill.path)).toEqual([join(store, "workspace-skill")]);
      expect(afterRestart.skills.some((skill: any) => skill.path.includes(".agents") || skill.path.includes("workspace/.agents"))).toBe(false);
      const db = new Database(join(dataDir, "skills.sqlite"));
      try {
        const rows = db.query("SELECT data FROM installations").all() as Array<{ data: string }>;
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.data).path).toBe(installed);
      } finally { db.close(); }
      expect(await git(join(store, "workspace-skill"), "status", "--porcelain")).toBe("");
      expect(await git(installed, "status", "--porcelain")).toBe("");
      const relaunched = await client.wait(await client.request<any>("agent.restart", { agentId: created.agentId }));
      expect(relaunched.status, JSON.stringify(relaunched)).toBe("completed");
      const nextProof = (await readFile(join(root, "proof.jsonl"), "utf8")).trim().split("\n").map((line: string) => JSON.parse(line)).at(-1);
      expect(nextProof.files).toEqual([join(installed, "SKILL.md")]);
    } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
  }
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

test("dataDir overlap directions allow agent initialization and restart", async () => {
  for (const mode of ["equal", "data-ancestor", "workspace-ancestor"] as const) {
    const root = await mkdtemp(join(tmpdir(), `skills-data-overlap-${mode}-`));
    const dataDir = mode === "equal" ? join(root, "workspace")
      : mode === "workspace-ancestor" ? join(root, "workspace", ".org") : join(root, ".org");
    const cwd = mode === "equal" ? dataDir
      : mode === "data-ancestor" ? join(dataDir, "workspace") : join(root, "workspace");
    const home = join(root, "home"), disjointStore = join(root, "separate-skill-store");
    await mkdir(dataDir, { recursive: true }); await mkdir(cwd, { recursive: true }); await mkdir(home, { recursive: true });
    const hostOptions = await createConfiguredOptions(root, dataDir, home);
    let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
    try {
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd } }));
      expect(created.status, JSON.stringify(created)).toBe("completed");
      await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
      await client.request("organization.settings.update", { namespace: "skills", expectedRevision: 0, patch: { directory: disjointStore } });
      client.close(); client = undefined; await server.close(); server = undefined;
      server = await OrganizationServer.start(hostOptions); client = await OrganizationClient.connect(hostOptions.socketPath);
      expect((await client.request<any>("organization.snapshot", {})).agents).toHaveLength(1);
    } finally { await closeHost(client, server); await rm(root, { recursive: true, force: true }); }
  }
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
