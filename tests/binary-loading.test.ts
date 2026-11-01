import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { git } from "../src/git.ts";
import { createSkillHarnessPlugin } from "./fixtures/skill-harness.ts";

test("compiled core with bundled skills permits spawned reads from an overlapping store/workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-binary-overlap-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let client: OrganizationClient | undefined;
  try {
    const dataDir = join(dir, ".org"), store = join(dataDir, "skills"), cwd = join(store, "agent-workspace");
    const repository = join(store, "binary-skill"), home = join(dir, "home");
    await mkdir(repository, { recursive: true }); await mkdir(cwd, { recursive: true }); await mkdir(home, { recursive: true });
    await writeFile(join(repository, "SKILL.md"), "---\nname: binary-skill\ndescription: Compiled overlap fixture\n---\nBundled overlap instructions.\n");
    await git(repository, "init", "--initial-branch=main");
    await git(repository, "config", "user.name", "Fixture"); await git(repository, "config", "user.email", "fixture@example.invalid");
    await git(repository, "add", "."); await git(repository, "commit", "-m", "compiled overlap skill");
    const sentinel = join(dataDir, "binary-sentinel.txt"); await writeFile(sentinel, "compiled-core-overlap-proof");
    const installed = join(cwd, ".agents", "skills", "binary-skill");
    const accessPaths = [
      { path: sentinel },
      { path: join(dataDir, "skills.sqlite"), mode: "sqlite-header" },
      { path: join(installed, "SKILL.md") },
      { path: join(installed, ".git", "agentorg-skills.json") },
    ];
    const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/index.ts")], target: "bun" });
    expect(bundle.success).toBe(true);
    const module = join(dir, "skills.js"); await Bun.write(module, bundle.outputs[0]!);
    const wrapper = join(dir, "plugin.ts"), proofPath = join(dir, "proof.jsonl");
    const harnessPath = resolve(import.meta.dir, "./fixtures/skill-harness.ts");
    await writeFile(wrapper, `import { createSkillsPlugin } from ${JSON.stringify(module)};
import { createSkillHarnessPlugin } from ${JSON.stringify(harnessPath)};
const harness = createSkillHarnessPlugin({ bunExecutable: ${JSON.stringify(process.execPath)}, consumerPath: ${JSON.stringify(resolve(import.meta.dir, "./fixtures/skill-consumer.ts"))}, proofPath: ${JSON.stringify(proofPath)}, accessPaths: ${JSON.stringify(accessPaths)} });
const skills = createSkillsPlugin({ home: ${JSON.stringify(home)} });
export default { apiVersion: 1, name: "compiled-overlap", async setup(host) { harness.setup(host); await skills.setup(host); } };
`);
    const binary = resolve(process.env.ORG_BINARY ?? join(import.meta.dir, "../../agentorg/dist/agentorg"));
    expect(await Bun.file(binary).exists()).toBe(true);
    child = Bun.spawn([binary, "--data-dir", dataDir, "--plugin", wrapper], { stdout: "ignore", stderr: "pipe" });
    for (let attempt = 0; attempt < 100 && !client; attempt++) {
      try { client = await OrganizationClient.connect(join(dataDir, "server.sock")); }
      catch { await Bun.sleep(20); }
    }
    if (!client) {
      const stderr = child.stderr;
      throw new Error(stderr && typeof stderr !== "number" ? await new Response(stderr).text() : "Compiled host did not open its socket");
    }
    const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "skill-consumer", model: "test", cwd, extensions: { skills: { "binary-skill": "installed" } } } }));
    expect(created.status, JSON.stringify(created)).toBe("completed");
    const prompt = await client.request<any>("agent.prompt", { agentId: created.agentId, text: "read the bundled overlap files" });
    expect((await client.wait(prompt)).status).toBe("completed");
    const proofs = (await readFile(proofPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter((record: any) => record.event === "prompt");
    expect(proofs).toHaveLength(1);
    expect(proofs[0].cwd).toBe(cwd);
    expect(proofs[0].paths).toEqual([join(installed, "SKILL.md")]);
    expect(proofs[0].content).toContain("Bundled overlap instructions");
    expect(proofs[0].access[0].content).toBe("compiled-core-overlap-proof");
    expect(proofs[0].access[1]).toEqual({ path: join(dataDir, "skills.sqlite"), bytesRead: 16, header: "SQLite format 3\u0000" });
    expect(proofs[0].access[2].content).toContain("Bundled overlap instructions");
    expect(proofs[0].access[3].content).toContain('"agentId"');
    expect(child.exitCode).toBeNull();
  } finally {
    client?.close();
    if (child) { child.kill("SIGTERM"); await child.exited; }
    await rm(dir, { recursive: true, force: true });
  }
});

test("compiled host loads the separate skills module and exposes coded errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-binary-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let client: OrganizationClient | undefined;
  try {
    const dataDir = join(dir, "data");
    await mkdir(dataDir);
    // Compiled Bun hosts require external plugins to bundle npm dependencies.
    const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../src/index.ts')], target: 'bun' });
    expect(bundle.success).toBe(true);
    const module = join(dir, 'skills.js');
    await Bun.write(module, bundle.outputs[0]!);
    const wrapper = join(dir, "plugin.ts");
    await writeFile(wrapper, `import {createSkillsPlugin} from ${JSON.stringify(module)}; export default createSkillsPlugin({home:${JSON.stringify(dir)}});`);
    const binary = resolve(process.env.ORG_BINARY ?? join(import.meta.dir, "../../agentorg/dist/agentorg"));
    expect(await Bun.file(binary).exists()).toBe(true);
    child = Bun.spawn([binary, "--data-dir", dataDir, "--plugin", wrapper], { stdout: "ignore", stderr: "pipe" });
    for (let attempt = 0; attempt < 100 && !client; attempt++) {
      try { client = await OrganizationClient.connect(join(dataDir, "server.sock")); }
      catch { await Bun.sleep(20); }
    }
    if (!client) {
      const stderr = child!.stderr;
      throw new Error(stderr && typeof stderr !== "number" ? await new Response(stderr).text() : "Compiled host did not open its socket");
    }
    let snapshot: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { snapshot = await client.request("organization.snapshot"); break; }
      catch (error: any) { if (error.code !== "NOT_READY") throw error; await Bun.sleep(20); }
    }
    expect(snapshot.capabilities.plugins.skills).toEqual({
      settingsNamespace: "skills", serverSettingsNamespace: "skills",
      endpoints: { list: "skills.list", registerRepository: "skills.registerRepository" },
      repositoryRegistration: { version: 2, sourceKinds: ["https", "server-path"], semantics: "committed-head-v2" }, version: 1,
    });
    const settings = await client.request<any>("organization.settings.list");
    expect(settings.groups.find((group: any) => group.namespace === "skills")).toMatchObject({
      defaults: { directory: "skills", gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
      fields: [{ key: "directory", effect: "restart" }, { key: "gitTimeoutMs", effect: "immediate" }, { key: "maxCatalogEntries", effect: "immediate" }],
    });
    const catalog = await client.request<any>("skills.list");
    expect(catalog.skills).toEqual([]);
    expect(catalog).toEqual({ skills: [] });
    try {
      await client.request("skills.registerRepository", { source: "ssh://localhost/skill" });
      throw new Error("Unexpected success");
    } catch (error: any) { expect(error.code).toBe("INVALID_PARAMS"); }
  } finally {
    client?.close();
    if (child) { child.kill("SIGTERM"); await child.exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
