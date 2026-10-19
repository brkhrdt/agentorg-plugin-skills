import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OrganizationClient } from "../../agentorg/src/client.ts";

test.skipIf(!process.env.ORG_BINARY)("compiled host loads the separate skills module and exposes coded errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-binary-"));
  const dataDir = join(dir, "data");
  await mkdir(dataDir);
  // Compiled Bun hosts require external plugins to bundle npm dependencies.
  const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../src/index.ts')], target: 'bun' });
  expect(bundle.success).toBe(true);
  const module = join(dir, 'skills.js');
  await Bun.write(module, bundle.outputs[0]!);
  const wrapper = join(dir, "plugin.ts");
  await writeFile(wrapper, `import {createSkillsPlugin} from ${JSON.stringify(module)}; export default createSkillsPlugin({home:${JSON.stringify(dir)}});`);
  const child = Bun.spawn([resolve(process.env.ORG_BINARY!), "--data-dir", dataDir, "--plugin", wrapper], { stdout: "ignore", stderr: "pipe" });
  let client: OrganizationClient | undefined;
  try {
    for (let attempt = 0; attempt < 100 && !client; attempt++) {
      try { client = await OrganizationClient.connect(join(dataDir, "server.sock")); }
      catch { await Bun.sleep(20); }
    }
    if (!client) throw new Error(await new Response(child.stderr).text());
    let snapshot: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { snapshot = await client.request("organization.snapshot"); break; }
      catch (error: any) { if (error.code !== "NOT_READY") throw error; await Bun.sleep(20); }
    }
    expect(snapshot.capabilities.plugins.skills).toEqual({
      settingsNamespace: "skills", serverSettingsNamespace: "skills",
      endpoints: { list: "skills.list", add: "skills.add", reconcile: "skills.reconcile" }, version: 1,
    });
    const settings = await client.request<any>("organization.settings.list");
    expect(settings.groups.find((group: any) => group.namespace === "skills")).toMatchObject({
      defaults: { repositories: [], gitTimeoutMs: 60_000, maxCatalogEntries: 256 },
      fields: [{ key: "repositories", effect: "immediate" }, { key: "gitTimeoutMs", effect: "immediate" }, { key: "maxCatalogEntries", effect: "immediate" }],
    });
    const catalog = await client.request<any>("skills.list");
    expect(catalog.skills).toEqual([]);
    expect(catalog.retained).toEqual([]);
    expect(catalog.reconciliation).toMatchObject({ state: "ready", desiredRevision: 0, entries: [] });
    try {
      await client.request("skills.add", { name: "bad", gitUrl: "ssh://localhost/skill" });
      throw new Error("Unexpected success");
    } catch (error: any) { expect(error.code).toBe("INVALID_PARAMS"); }
  } finally {
    client?.close(); child.kill("SIGTERM"); await child.exited;
    await rm(dir, { recursive: true, force: true });
  }
});
