import type { TurnJob } from "@muster/shared";
import type { Runtime, RuntimeContext, RuntimeResult, RunningTurn } from "./types.js";
import { JsonProcess, type Wire } from "./process.js";

export class ClaudeRuntime implements Runtime {
  constructor(private command = "claude", private prefix: string[] = []) {}
  start(job: TurnJob, ctx: RuntimeContext): RunningTurn {
    let sessionId = typeof job.sessionState?.sessionId === "string" ? job.sessionState.sessionId : "";
    const args = [...this.prefix, "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions", "--append-system-prompt", job.systemInstructions, "--model", job.agent.model,
      ...(sessionId ? ["--resume", sessionId] : []), "--mcp-config", JSON.stringify({ mcpServers: { muster: { type: "http", url: job.mcp.url, headers: { Authorization: `Bearer ${job.mcp.token}` } } } })];
    const process = new JsonProcess(this.command, args, ctx.cwd);
    let stopped = false;
    let finished = false;
    let text = "";
    let streamed = false;
    let submitted = 0;
    let completed = 0;
    let usage = { tokensIn: 0, tokensOut: 0 };
    let finish!: (value: RuntimeResult) => void;
    const completion = new Promise<RuntimeResult>((resolve) => { finish = resolve; });
    const settle = (status: RuntimeResult["status"], error?: string) => {
      if (finished) return;
      finished = true;
      finish({ status, text, usage, sessionState: { sessionId }, ...(error ? { error } : {}) });
    };
    const send = (content: string) => { submitted++; process.send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId }); };
    process.onFailure = (error) => settle(stopped ? "stopped" : "failed", error.message);
    process.onMessage = (message: Wire) => {
      if (message.session_id) sessionId = String(message.session_id);
      if (message.type === "stream_event") {
        const event = message.event as Wire;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") { streamed = true; text += String(event.delta.text); ctx.emit({ type: "message.delta", content: String(event.delta.text) }); }
          if (event.delta.type === "thinking_delta") ctx.emit({ type: "reasoning.delta", content: String(event.delta.thinking) });
        }
      } else if (message.type === "assistant") {
        const blocks = message.message.content as Wire[];
        const content = blocks.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
        if (content) {
          if (!streamed) ctx.emit({ type: "message.delta", content });
          ctx.emit({ type: "message.completed", content }); text = content; streamed = false;
        }
        for (const block of blocks) if (block.type === "tool_use") ctx.emit({ type: "tool.started", tool: String(block.name), callId: String(block.id), input: block.input });
      } else if (message.type === "user" && Array.isArray(message.message?.content)) {
        for (const block of message.message.content as Wire[]) if (block.type === "tool_result") ctx.emit({ type: "tool.completed", tool: "claude", callId: String(block.tool_use_id), output: block.content, ...(block.is_error ? { error: JSON.stringify(block.content) } : {}) });
      } else if (message.type === "result") {
        const u = message.usage ?? {};
        usage = { tokensIn: usage.tokensIn + Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0), tokensOut: usage.tokensOut + Number(u.output_tokens ?? 0) };
        ctx.emit({ type: "usage", ...usage });
        if (!text && message.result) { text = String(message.result); ctx.emit({ type: "message.completed", content: text }); }
        completed++;
        if (message.is_error || (message.subtype && message.subtype !== "success")) settle("failed", (message.errors ?? [message.result ?? message.subtype]).join("\n"));
        else if (completed >= submitted) settle("done");
      }
    };
    send(job.prompt);
    return {
      result: completion.then(async (result) => { await process.stop(); return result; }),
      steer: async (content) => { if (finished) throw new Error("Turn already completed"); send(content); },
      interrupt: async () => { stopped = true; settle("stopped"); await process.stop(); },
    };
  }
}
