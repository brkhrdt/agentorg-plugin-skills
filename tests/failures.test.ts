import { expect, test } from "bun:test";
import { Organization } from "../../agentorg/src/organization.ts";
import { join } from "node:path";
import { createLocalSkillFixture } from "./helpers/local-skill.ts";
import { createSkillsPlugin } from "../src/index.ts";

test("default plugin rejects a valid plain local skill directory as a Git source", async () => {
  const fixture = await createLocalSkillFixture();
  const org = new Organization(join(fixture.root, "server.sock"), join(fixture.root, "data"));
  try {
    await org.use(createSkillsPlugin({ home: fixture.root }));
    await expect(org.request("skills.add", { name: "local", gitUrl: fixture.path }, { kind: "client", id: "test" }))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/HTTPS/) });
    await expect(org.request("skills.addFromPath", null, { kind: "agent", id: "not-real" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(org.request("skills.addFromPath", { path: fixture.path, name: "ignored" }, { kind: "client", id: "test" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(org.request("skills.list", {}, { kind: "client", id: "test" })).resolves.toMatchObject({ skills: [] });
  } finally { await org.close(); await fixture.cleanup(); }
});
