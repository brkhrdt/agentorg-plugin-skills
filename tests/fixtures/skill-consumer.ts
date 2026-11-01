import * as acp from "@agentclientprotocol/sdk";
import { appendFile, open, readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

let sessionId: string = crypto.randomUUID();
acp.agent({ name: "local-skill-consumer" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  .onRequest("session/new", () => ({ sessionId }))
  .onRequest("session/load", ctx => { sessionId = ctx.params.sessionId; return {}; })
  .onRequest("session/prompt", async ctx => {
    const requested = ctx.params.prompt.map(block => block.type === "text" ? block.text : "").join(" ");
    const paths: string[] = JSON.parse(process.env.AGENTORG_SKILL_FILES ?? "[]");
    const content = (await Promise.all(paths.map(path => readFile(path, "utf8")))).join("\n");
    const accessProbes: Array<{ path: string; mode?: "sqlite-header" }> = JSON.parse(process.env.SKILLS_E2E_ACCESS_PATHS ?? "[]");
    const access = await Promise.all(accessProbes.map(async probe => {
      if (probe.mode === "sqlite-header") {
        const file = await open(probe.path, "r");
        try {
          const header = Buffer.alloc(16);
          const { bytesRead } = await file.read(header, 0, header.length, 0);
          return { path: probe.path, bytesRead, header: header.subarray(0, bytesRead).toString("ascii") };
        } finally { await file.close(); }
      }
      return { path: probe.path, content: await readFile(probe.path, "utf8") };
    }));
    const proof = { event: "prompt", agentId: process.env.SKILLS_E2E_AGENT_ID, sessionId, cwd: process.cwd(), paths, requested, content, access };
    if (process.env.SKILLS_E2E_PROOF) await appendFile(process.env.SKILLS_E2E_PROOF, JSON.stringify(proof) + "\n");
    await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${requested}\n${content}` } } });
    return { stopReason: "end_turn" };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
