import { access } from "node:fs/promises";
import { CLI_DEFAULT_MODEL, type TurnJob } from "@muster/shared";
import type { Runtime, RuntimeContext, RuntimeResult, RunningTurn } from "./types.js";
import { JsonProcess, type Wire } from "./process.js";
import { writeBridge, type Bridge } from "./bridge.js";
import { errorText } from "../util.js";

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const text = (message: Wire) => ((message.content ?? []) as Wire[]).filter((part) => part.type === "text").map((part) => String(part.text)).join("");

/**
 * pi (and its fork omp) in RPC mode: JSONL commands on stdin, events on stdout.
 * pi has no MCP client, so a generated extension registers the MCP tools.
 * Wire format per pi-coding-agent 0.73 docs/rpc.md.
 */
export class PiRuntime implements Runtime {
  constructor(private command = "pi", private prefix: string[] = ["--mode", "rpc"]) {}
  start(job: TurnJob, ctx: RuntimeContext): RunningTurn {
    let stopped = false;
    let finished = false;
    let process: JsonProcess | undefined;
    let bridge: Bridge | undefined;
    let finish!: (value: RuntimeResult) => void;
    const completion = new Promise<RuntimeResult>((resolve) => { finish = resolve; });
    let sessionFile = typeof job.sessionState?.sessionFile === "string" ? job.sessionState.sessionFile : "";
    let reply = "";
    let usage = { tokensIn: 0, tokensOut: 0 };
    let streaming = false;
    let prompts = 0;
    let ends = 0;
    let lastError = "";
    const settle = (status: RuntimeResult["status"], error?: string) => {
      if (finished) return;
      finished = true;
      finish({ status, text: reply, usage, sessionState: { sessionFile }, ...(error ? { error } : {}) });
    };
    const send = (message: Wire) => { if (!process) throw new Error("pi is not running"); process.send(message); };
    const prompt = (message: string) => { prompts++; streaming = true; send({ type: "prompt", message }); };
    const onMessage = (message: Wire) => {
      const type = String(message.type);
      if (type === "response") {
        if (message.command === "get_state") {
          if (message.success) sessionFile = String(message.data?.sessionFile ?? sessionFile);
          // Finish once the session file is known, unless a new prompt started meanwhile.
          if (!streaming && ends > 0 && ends >= prompts) settle("done");
        } else if (!message.success && (message.command === "prompt" || message.command === "parse")) settle("failed", String(message.error ?? "pi rejected the prompt"));
        else if (!message.success && message.command === "steer") ctx.emit({ type: "warning", detail: String(message.error ?? "pi rejected the message") });
      } else if (type === "message_update") {
        const event = message.assistantMessageEvent as Wire;
        if (event?.type === "text_delta") ctx.emit({ type: "message.delta", content: String(event.delta) });
        else if (event?.type === "thinking_delta") ctx.emit({ type: "reasoning.delta", content: String(event.delta) });
      } else if (type === "message_end" && message.message?.role === "assistant") {
        const assistant = message.message as Wire;
        const content = text(assistant);
        if (content) { reply = content; ctx.emit({ type: "message.completed", content }); }
        const u = assistant.usage ?? {};
        usage = { tokensIn: usage.tokensIn + Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0), tokensOut: usage.tokensOut + Number(u.output ?? 0) };
        ctx.emit({ type: "usage", ...usage });
        lastError = assistant.stopReason === "error" ? String(assistant.errorMessage ?? "pi model call failed") : "";
      } else if (type === "tool_execution_start") {
        ctx.emit({ type: "tool.started", tool: String(message.toolName), callId: String(message.toolCallId), input: message.args });
      } else if (type === "tool_execution_end") {
        ctx.emit({ type: "tool.completed", tool: String(message.toolName), callId: String(message.toolCallId), output: message.result, ...(message.isError ? { error: text(message.result ?? {}) || "Tool failed" } : {}) });
      } else if (type === "auto_retry_start") {
        ctx.emit({ type: "warning", detail: `Retrying: ${String(message.errorMessage ?? "transient error")}` });
      } else if (type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(message.method))) {
        // Nobody is at the machine to answer an extension's dialog.
        send({ type: "extension_ui_response", id: message.id, cancelled: true });
      } else if (type === "agent_end") {
        ends++;
        streaming = false;
        send({ type: "get_state" });
        if (stopped) settle("stopped");
        else if (lastError) settle("failed", lastError);
      }
    };
    const ready = (async () => {
      bridge = await writeBridge(job);
      if (sessionFile) await access(sessionFile).catch(() => { sessionFile = ""; });
      const args = [...this.prefix, "-e", bridge.piExtension, "--append-system-prompt", job.systemInstructions,
        ...(job.agent.model && job.agent.model !== CLI_DEFAULT_MODEL ? ["--model", job.agent.model] : []),
        ...(job.agent.reasoning && THINKING.has(job.agent.reasoning) ? ["--thinking", job.agent.reasoning] : []),
        ...(sessionFile ? ["--session", sessionFile] : [])];
      if (stopped) { settle("stopped"); return; }
      process = new JsonProcess(this.command, args, ctx.cwd, { PI_MUSTER_BRIDGE_CONFIG: bridge.piConfig });
      process.ignoreInvalid = true;
      process.onFailure = (error) => settle(stopped ? "stopped" : "failed", error.message);
      process.onMessage = onMessage;
      send({ type: "get_state" });
      prompt(job.prompt);
    })().catch((error: unknown) => settle(stopped ? "stopped" : "failed", errorText(error)));
    return {
      result: completion.then(async (result) => { await process?.stop(); await bridge?.dispose(); return result; }),
      steer: async (content) => {
        await ready;
        if (finished) throw new Error("Turn already completed");
        // While streaming, pi injects steering after the current tool calls.
        if (streaming) send({ type: "steer", message: content }); else prompt(content);
      },
      interrupt: async () => {
        stopped = true;
        const timer = setTimeout(() => settle("stopped"), 3000); timer.unref();
        await ready;
        if (!finished && process) send({ type: "abort" });
      },
    };
  }
}
