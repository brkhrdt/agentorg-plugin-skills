import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { createSkillsPlugin } from "../src/index.ts";
import { git } from "../src/git.ts";
import { createSkillHarnessPlugin } from "./fixtures/skill-harness.ts";

async function repository(path: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: workspace-skill\ndescription: workspace skill\n---\nInstructions\n");
  await git(path, "init", "--initial-branch=main");
  await git(path, "config", "user.name", "Fixture");
  await git(path, "config", "user.email", "fixture@example.invalid");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "committed skill");
}

async function createPlugin(home: string) {
  const bundle = process.env.SKILLS_PLUGIN_BUNDLE;
  if (!bundle) return createSkillsPlugin({ home });
  const module = await import(pathToFileURL(resolve(bundle)).href) as typeof import("../src/index.ts");
  return module.createSkillsPlugin({ home });
}

async function restartWithStoreAtWorkspace(mode: "equal" | "containing") {
  const root = await mkdtemp(join(tmpdir(), `skills-workspace-store-${mode}-`));
  const dataDir = join(root, "data"), home = join(root, "home");
  const store = mode === "equal" ? join(root, "workspace") : join(root, "store");
  const cwd = mode === "equal" ? store : join(store, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await repository(join(store, "workspace-skill"));
  const socketPath = join(dataDir, "org.sock");
  const options = {
    dataDir,
    socketPath,
    plugins: [
      createSkillHarnessPlugin({
        bunExecutable: process.execPath,
        consumerPath: join(import.meta.dir, "fixtures/skill-consumer.ts"),
        proofPath: join(root, "proof.jsonl"),
      }),
      await createPlugin(home),
    ],
  };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    server = await OrganizationServer.start(options);
    client = await OrganizationClient.connect(socketPath);
    const created = await client.wait(await client.request<any>("agent.create", {
      settings: { harness: "skill-consumer", model: "test", cwd },
    }));
    expect(created.status, JSON.stringify(created)).toBe("completed");
    await client.wait(await client.request<any>("agent.stop", { agentId: created.agentId }));
    await client.request("organization.settings.update", {
      namespace: "skills", expectedRevision: 0, patch: { directory: store },
    });
    client.close(); client = undefined;
    await server.close(); server = undefined;

    server = await OrganizationServer.start(options);
    client = await OrganizationClient.connect(socketPath);
    const catalog = await client.request<any>("skills.list");
    expect(catalog.skills.map((skill: any) => skill.path)).toEqual([join(store, "workspace-skill")]);
  } finally {
    client?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("store equal to an active agent workspace is accepted after restart", async () => {
  await restartWithStoreAtWorkspace("equal");
});

test("store containing an active agent workspace is accepted after restart", async () => {
  await restartWithStoreAtWorkspace("containing");
});
