import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OrganizationClient } from "../../agentorg/src/client.ts";

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
