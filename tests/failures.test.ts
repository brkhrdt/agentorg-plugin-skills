import { expect, test } from "bun:test";
import { Organization } from "../../agentorg/src/organization.ts";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillsPlugin } from "../src/index.ts";

test("normal plugin rejects local sources without an explicit trusted factory opt-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-policy-"));
  await mkdir(join(dir, "data"));
  const org = new Organization(join(dir, "server.sock"), join(dir, "data"));
  try {
    await org.use(createSkillsPlugin({ home: dir }));
    await expect(org.request("skills.add", { name: "local", gitUrl: dir }, { kind: "client", id: "test" })).rejects.toThrow("HTTPS");
  } finally { await org.close(); await rm(dir, { recursive: true, force: true }); }
});
