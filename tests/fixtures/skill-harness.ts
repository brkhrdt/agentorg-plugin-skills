import { appendFileSync } from "node:fs";
import type { ServerPlugin } from "agent-organization/plugin";
import { nodeTsxArgs } from "../helpers/node-tsx.ts";

export interface SkillHarnessOptions { nodeExecutable: string; consumerPath: string; proofPath: string; accessPaths?: Array<{ path: string; mode?: "sqlite-header" }> }

export function createSkillHarnessPlugin(options: SkillHarnessOptions): ServerPlugin {
  return { apiVersion: 1, name: "skills-e2e-harness", setup(host) {
    host.registerHarness({ name: "skill-consumer", listModels: () => [{ provider: "fixture", id: "test" }], launch(context) {
      const files = JSON.parse(context.env.AGENTORG_SKILL_FILES ?? "[]");
      appendFileSync(options.proofPath, JSON.stringify({ event: "launch", agentId: context.agent.id, token: context.token, files }) + "\n");
      return { command: options.nodeExecutable, args: nodeTsxArgs(options.consumerPath), cwd: context.agent.settings.cwd ?? process.cwd(),
        env: { ...context.env, SKILLS_E2E_PROOF: options.proofPath, SKILLS_E2E_AGENT_ID: context.agent.id, SKILLS_E2E_ACCESS_PATHS: JSON.stringify(options.accessPaths ?? []) }, consumesEnv: ["AGENTORG_SKILL_FILES"] };
    } });
  } };
}

const configured = createSkillHarnessPlugin({
  nodeExecutable: process.env.SKILLS_E2E_NODE ?? process.execPath,
  consumerPath: process.env.SKILLS_E2E_CONSUMER ?? "",
  proofPath: process.env.SKILLS_E2E_PROOF ?? "/tmp/agentorg-skills-e2e-proof.jsonl",
});
export default configured;
