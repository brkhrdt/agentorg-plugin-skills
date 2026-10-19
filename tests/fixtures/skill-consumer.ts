import * as acp from "@agentclientprotocol/sdk";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

const sessionId = crypto.randomUUID();
acp.agent({ name: "local-skill-consumer" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  .onRequest("session/new", () => ({ sessionId }))
  .onRequest("session/load", () => ({}))
  .onRequest("session/prompt", async ctx => {
    const requested = ctx.params.prompt.map(block => block.type === "text" ? block.text : "").join(" ");
    const paths: string[] = JSON.parse(process.env.AGENTORG_SKILL_FILES ?? "[]");
    const content = (await Promise.all(paths.map(path => readFile(path, "utf8")))).join("\n");
    await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${requested}\n${content}` } } });
    return { stopReason: "end_turn" };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
