import type { TurnJob } from "@muster/shared";
import type { Runtime, RuntimeContext, RuntimeResult, RunningTurn } from "./types.js";
import { JsonProcess, type Wire } from "./process.js";
import { errorText } from "../util.js";

/** Wire fields verified with codex-cli 0.162.1 app-server generate-ts. */
export class CodexRuntime implements Runtime {
  constructor(private command = "codex", private prefix: string[] = []) {}
  start(job: TurnJob, ctx: RuntimeContext): RunningTurn {
    const process = new JsonProcess(this.command, [...this.prefix, "app-server"], ctx.cwd);
    let sequence = 0;
    const pending = new Map<number, { resolve(value: Wire): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    let threadId = typeof job.sessionState?.threadId === "string" ? job.sessionState.threadId : "";
    let turnId = "";
    let text = "";
    let usage = { tokensIn: 0, tokensOut: 0 };
    let baseline = { tokensIn: Number(job.sessionState?.tokensIn ?? 0), tokensOut: Number(job.sessionState?.tokensOut ?? 0) };
    let cumulative = { ...baseline };
    let stopped = false;
    let finished = false;
    let finish!: (result: RuntimeResult) => void;
    const completion = new Promise<RuntimeResult>((resolve) => { finish = resolve; });
    const settle = (status: RuntimeResult["status"], error?: string) => {
      if (finished) return;
      finished = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(error ?? "Turn finished")); }
      pending.clear();
      finish({ status, text, usage, sessionState: { threadId, ...cumulative }, ...(error ? { error } : {}) });
    };
    const rpc = (method: string, params: Wire): Promise<Wire> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      try { process.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    process.onFailure = (error) => settle(stopped ? "stopped" : "failed", error.message);
    process.onMessage = (message) => {
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(message.id as number);
        if (entry) {
          pending.delete(message.id as number); clearTimeout(entry.timer);
          if (message.error) entry.reject(new Error(String(message.error.message)));
          else entry.resolve(message.result as Wire);
        }
        return;
      }
      // Never leave an unexpected server request hanging (e.g. elicitation).
      if (message.id !== undefined) { process.send({ id: message.id, error: { code: -32601, message: "Interactive requests are disabled in Muster" } }); return; }
      const p = (message.params ?? {}) as Wire;
      if (p.threadId && threadId && p.threadId !== threadId) return;
      const method = String(message.method);
      if (method === "turn/started") turnId = String(p.turn.id);
      if (method === "item/agentMessage/delta") { text += String(p.delta); ctx.emit({ type: "message.delta", content: String(p.delta) }); }
      else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") ctx.emit({ type: "reasoning.delta", content: String(p.delta) });
      else if (method === "item/started" || method === "item/completed") {
        const item = p.item as Wire;
        if (item.type === "agentMessage" && method === "item/started") {
          ctx.emit({ type: "message.delta", content: "" });
        } else if (item.type === "agentMessage" && method === "item/completed") {
          ctx.emit({ type: "message.completed", content: String(item.text) });
          // Keep the final assistant message as the plan, rather than concatenating commentary.
          text = String(item.text);
        } else if (item.type === "plan" && method === "item/completed") ctx.emit({ type: "plan.updated", content: String(item.text) });
        else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "functionCallOutput"].includes(String(item.type))) {
          ctx.emit(method === "item/started" ? { type: "tool.started", tool: String(item.tool ?? item.type), callId: String(item.id), input: item.arguments ?? item.command ?? item.changes } : { type: "tool.completed", tool: String(item.tool ?? item.type), callId: String(item.id), output: item.result ?? item.aggregatedOutput ?? item, ...(item.error ? { error: JSON.stringify(item.error) } : {}) });
        }
      } else if (method === "turn/plan/updated") {
        ctx.emit({ type: "plan.updated", content: (p.plan as Wire[]).map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.step}`).join("\n") });
      } else if (method === "thread/tokenUsage/updated") {
        const total = { tokensIn: Number(p.tokenUsage.total.inputTokens), tokensOut: Number(p.tokenUsage.total.outputTokens) };
        cumulative = total;
        if (!turnId || p.turnId !== turnId) baseline = total;
        else {
          // `total` is cumulative across the resumed thread, `last` is one API call.
          usage = { tokensIn: Math.max(0, total.tokensIn - baseline.tokensIn), tokensOut: Math.max(0, total.tokensOut - baseline.tokensOut) };
          ctx.emit({ type: "usage", ...usage });
        }
      } else if (method === "error") {
        ctx.emit({ type: "status", status: "error", detail: String(p.error?.message ?? "Codex error") });
        if (!p.willRetry) settle("failed", String(p.error?.message ?? "Codex error"));
      } else if (method === "turn/completed") {
        settle(p.turn.status === "completed" ? "done" : p.turn.status === "interrupted" ? "stopped" : "failed", p.turn.error?.message);
      }
    };
    const ready = (async () => {
      await rpc("initialize", { clientInfo: { name: "muster-daemon", title: null, version: "0.1.0" }, capabilities: null });
      process.send({ method: "initialized" });
      if (stopped) { settle("stopped"); return; }
      const config: Wire = {
        // Trust only Muster's platform tools, independently of the filesystem
        // sandbox. `never` rejects MCP calls that would otherwise need approval.
        mcp_servers: { muster: { url: job.mcp.url, required: true, default_tools_approval_mode: "approve", http_headers: { Authorization: `Bearer ${job.mcp.token}` } } },
      };
      const params = { cwd: ctx.cwd, model: job.agent.model, developerInstructions: job.systemInstructions, approvalPolicy: "never", sandbox: job.readOnly ? "read-only" : "danger-full-access", config };
      const response = await rpc(threadId ? "thread/resume" : "thread/start", { ...params, ...(threadId ? { threadId } : {}) });
      threadId = String(response.thread.id);
      if (stopped) { settle("stopped"); return; }
      // TurnStartParams accepts sandboxPolicy, not developerInstructions. Set it
      // on every turn: resumed threads must not inherit the planning sandbox.
      const sandboxPolicy = job.readOnly ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" };
      const started = await rpc("turn/start", { threadId, approvalPolicy: "never", sandboxPolicy, input: [{ type: "text", text: job.prompt, text_elements: [] }], ...(job.agent.reasoning ? { effort: job.agent.reasoning } : {}) });
      turnId = String(started.turn.id);
      if (stopped && !finished) await rpc("turn/interrupt", { threadId, turnId });
    })().catch((error: unknown) => { settle(stopped ? "stopped" : "failed", errorText(error)); });
    return {
      result: completion.then(async (result) => { await process.stop(); return result; }),
      steer: async (content) => { await ready; if (finished) throw new Error("Turn already completed"); await rpc("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: content, text_elements: [] }] }); },
      interrupt: async () => {
        stopped = true;
        const timer = setTimeout(() => settle("stopped"), 3000); timer.unref();
        try { await ready; if (!finished && turnId) await rpc("turn/interrupt", { threadId, turnId }); }
        finally { if (finished) clearTimeout(timer); }
      },
    };
  }
}
