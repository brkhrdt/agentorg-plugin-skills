import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "../../agentorg/src/client.ts";
import { createPiPlugin } from "../../agentorg-plugin-pi-agent/src/index.ts";
import { createSkillsPlugin } from "../src/index.ts";

const provider = process.env.PI_PROVIDER ?? "openai-codex";
const model = process.env.PI_MODEL ?? "gpt-6-luna";
const dir = await mkdtemp(join(tmpdir(), "agentorg-live-skill-"));
let server: OrganizationServer | undefined;
let client: OrganizationClient | undefined;
try {
  await mkdir(join(dir, "home"));
  const workspace = join(dir, "workspace"); await mkdir(workspace);
  const repository = join(dir, "source-skill");
  await mkdir(repository);
  await writeFile(join(repository, "SKILL.md"), "---\nname: live-proof\ndescription: Live proof skill\n---\nWhen asked to demonstrate this skill, read `proof.txt` and reply with its exact contents, with no other text.\n");
  await writeFile(join(repository, "proof.txt"), "LIVE_SKILL_PROOF_7f3d91");
  const git = (...args: string[]) => {
    try { execFileSync("git", args, { cwd: repository, stdio: "pipe" }); }
    catch (error: any) { throw new Error(error.stderr?.toString() ?? error.message); }
  };
  git("init", "--initial-branch=main"); git("config", "user.name", "Demo"); git("config", "user.email", "demo@example.invalid");
  git("add", "."); git("commit", "-m", "skill");
  server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "org.sock"),
    plugins: [createPiPlugin({ provider, model }), createSkillsPlugin({ home: join(dir, "home") })], limits: { startTimeoutMs: 30_000 } });
  client = await OrganizationClient.connect(join(dir, "org.sock"));
  const registered = await client.request<any>("skills.registerRepository", { source: repository });
  console.log(`REGISTERED ${registered.name} ${registered.path}`);
  const created = await client.wait(await client.request<any>("agent.create", { settings: { harness: "pi", provider, model, cwd: workspace,
    extensions: { skills: { "live-proof": "installed" } } } }), 45_000);
  if (created.status !== "completed") throw new Error(created.error?.message ?? "Pi agent creation failed");
  const agent = (created.result as any).agent ?? created.result as any;
  console.log(`AGENT ${agent.id}`);
  const prompt = await client.wait(await client.request<any>("agent.prompt", { agentId: agent.id,
    text: "Use the live-proof skill and follow its instructions, including reading proof.txt. Return exactly what the skill requires." }), 120_000);
  const response = (prompt.result as any)?.text;
  console.log(`PROMPT ${JSON.stringify(prompt)}`);
  if (prompt.status !== "completed" || response !== "LIVE_SKILL_PROOF_7f3d91") throw new Error("Live Pi skill-use verification failed");
} finally { client?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
