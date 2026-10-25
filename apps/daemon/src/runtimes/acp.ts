import { createHash } from "node:crypto";
import { CLI_DEFAULT_MODEL, type TurnJob } from "@muster/shared";
import type { Runtime, RuntimeContext, RuntimeResult, RunningTurn } from "./types.js";
import { JsonProcess, type Wire } from "./process.js";
import { mcpServers, writeBridge, type Bridge } from "./bridge.js";
import { errorText } from "../util.js";

// Write-capable tool kinds; plan turns reject them when the agent asks.
const WRITE_KINDS = new Set(["edit", "delete", "move", "execute"]);
const pairs = (record: Record<string, string> = {}) => Object.entries(record).map(([name, value]) => ({ name, value }));
const find = (values: Wire[] | undefined, pattern: RegExp, key = "id") => values?.find((value) => pattern.test(String(value[key] ?? "")) || pattern.test(String(value.name ?? "")));

/**
 * Agent Client Protocol (JSON-RPC 2.0 over stdio), spoken by Gemini CLI,
 * OpenCode, Qwen Code, Devin, Cline, dsh, Hermes, OpenClaw, Kiro and Auggie.
 * ACP has no system prompt, so instructions lead the first prompt of a session
 * (again whenever they change). Messages sent mid-turn queue as the next prompt.
 */
export class AcpRuntime implements Runtime {
  constructor(private command: string, private args: string[], private label = "ACP agent") {}
  start(job: TurnJob, ctx: RuntimeContext): RunningTurn {
    let stopped = false;
    let finished = false;
    let process: JsonProcess | undefined;
    let bridge: Bridge | undefined;
    let finish!: (value: RuntimeResult) => void;
    const completion = new Promise<RuntimeResult>((resolve) => { finish = resolve; });
    let sessionId = typeof job.sessionState?.sessionId === "string" ? job.sessionState.sessionId : "";
    const instructions = createHash("sha256").update(job.systemInstructions).digest("hex").slice(0, 16);
    let sentInstructions = job.sessionState?.instructions === instructions;
    let reply = "";
    let current = "";
    let usage = { tokensIn: 0, tokensOut: 0 };
    let replaying = false;
    let prompting = false;
    const queued: string[] = [];
    let sequence = 0;
    const pending = new Map<number, { resolve(value: Wire): void; reject(error: Error): void }>();
    const settle = (status: RuntimeResult["status"], error?: string) => {
      if (finished) return;
      finished = true;
      for (const entry of pending.values()) entry.reject(new Error(error ?? "Turn finished"));
      pending.clear();
      finish({ status, text: reply, usage, sessionState: { sessionId, instructions: sentInstructions ? instructions : null }, ...(error ? { error } : {}) });
    };
    const rpc = (method: string, params: Wire): Promise<Wire> => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try { process!.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { pending.delete(id); reject(error as Error); }
    });
    const flush = () => { if (current) { reply = current; ctx.emit({ type: "message.completed", content: current }); current = ""; } };
    const permission = (params: Wire) => {
      const options = (params.options ?? []) as Wire[];
      const deny = job.readOnly && WRITE_KINDS.has(String(params.toolCall?.kind));
      const choice = deny
        ? options.find((o) => o.kind === "reject_once") ?? options.find((o) => String(o.kind).startsWith("reject"))
        : options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once");
      return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
    };
    const update = (u: Wire) => {
      const kind = String(u.sessionUpdate);
      if (kind === "agent_message_chunk" && u.content?.type === "text") { current += String(u.content.text); ctx.emit({ type: "message.delta", content: String(u.content.text) }); }
      else if (kind === "agent_thought_chunk" && u.content?.type === "text") ctx.emit({ type: "reasoning.delta", content: String(u.content.text) });
      else if (kind === "tool_call") {
        flush();
        ctx.emit({ type: "tool.started", tool: String(u.title ?? u.kind ?? "tool"), callId: String(u.toolCallId), input: u.rawInput });
        if (u.status === "completed" || u.status === "failed") update({ ...u, sessionUpdate: "tool_call_update" });
      } else if (kind === "tool_call_update" && (u.status === "completed" || u.status === "failed")) {
        ctx.emit({ type: "tool.completed", tool: String(u.title ?? u.kind ?? "tool"), callId: String(u.toolCallId), output: u.rawOutput ?? u.content, ...(u.status === "failed" ? { error: JSON.stringify(u.rawOutput ?? u.content ?? "failed") } : {}) });
      } else if (kind === "plan") {
        ctx.emit({ type: "plan.updated", content: ((u.entries ?? []) as Wire[]).map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${String(entry.content)}`).join("\n") });
      }
    };
    const onMessage = (message: Wire) => {
      if (message.id !== undefined && message.method === undefined) {
        const entry = pending.get(Number(message.id));
        if (!entry) return;
        pending.delete(Number(message.id));
        if (message.error) entry.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
        else entry.resolve((message.result ?? {}) as Wire);
      } else if (message.id !== undefined) {
        // Requests from the agent: approve tools (nobody is at the machine); we
        // advertise no client fs/terminal, so anything else is unsupported.
        if (message.method === "session/request_permission") process!.send({ jsonrpc: "2.0", id: message.id, result: permission(message.params ?? {}) });
        else process!.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `${String(message.method)} is not supported by Muster` } });
      } else if (message.method === "session/update" && !replaying) update((message.params?.update ?? {}) as Wire);
    };
    const configure = async (session: Wire) => {
      const options = (session.configOptions ?? []) as Wire[];
      const model = job.agent.model;
      if (model && model !== CLI_DEFAULT_MODEL) {
        const option = options.find((o) => o.category === "model" || o.id === "model");
        const available = (session.models?.availableModels ?? []) as Wire[];
        if (option) await rpc("session/set_config_option", { sessionId, configId: option.id, value: model });
        else if (available.length && !available.some((m) => m.modelId === model)) throw new Error(`${this.label} has no model "${model}". Available: ${available.slice(0, 20).map((m) => String(m.modelId)).join(", ")}`);
        else await rpc("session/set_model", { sessionId, modelId: model });
      }
      const effort = options.find((o) => o.category === "thought_level" || /reason|effort|thought/i.test(String(o.id)));
      if (job.agent.reasoning && effort) await rpc("session/set_config_option", { sessionId, configId: effort.id, value: job.agent.reasoning }).catch(() => undefined);
      // Plan turns use a read-only mode when the agent has one; builds leave it.
      const modes = session.modes?.availableModes as Wire[] | undefined;
      const mode = job.readOnly ? find(modes, /plan|read.?only|^ask$/i) : find(modes, /yolo|bypass|full.?access|^auto/i) ?? find(modes, /^(default|code|agent|build)$/i);
      if (mode && mode.id !== session.modes?.currentModeId) await rpc("session/set_mode", { sessionId, modeId: mode.id }).catch(() => undefined);
    };
    const run = async (content: string): Promise<void> => {
      const lead = sentInstructions ? "" : `<instructions>\n${job.systemInstructions}\n</instructions>\n\n`;
      sentInstructions = true;
      prompting = true;
      const result = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: lead + content }] });
      prompting = false;
      flush();
      const u = result.usage ?? {};
      if (u.inputTokens !== undefined || u.outputTokens !== undefined) {
        usage = { tokensIn: usage.tokensIn + Number(u.inputTokens ?? 0) + Number(u.cachedReadTokens ?? 0) + Number(u.cachedWriteTokens ?? 0), tokensOut: usage.tokensOut + Number(u.outputTokens ?? 0) };
        ctx.emit({ type: "usage", ...usage });
      }
      if (stopped || result.stopReason === "cancelled") return settle("stopped");
      if (result.stopReason === "refusal") return settle("failed", `${this.label} refused the request`);
      if (queued.length) return run(queued.splice(0).join("\n\n"));
      settle("done");
    };
    void (async () => {
      const init = await (async () => {
        process = new JsonProcess(this.command, this.args, ctx.cwd, job.env);
        process.ignoreInvalid = true;
        process.onFailure = (error) => settle(stopped ? "stopped" : "failed", error.message);
        process.onMessage = onMessage;
        return rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "muster-daemon", version: "0.1.0" } });
      })();
      const caps = (init.agentCapabilities ?? {}) as Wire;
      // HTTP MCP servers need the agent's opt-in; otherwise proxy them over stdio.
      const http = caps.mcpCapabilities?.http === true;
      if (!http) bridge = await writeBridge(job);
      const servers = mcpServers(job).map((s) => s.transport === "http"
        ? http ? { type: "http", name: s.name, url: s.url, headers: pairs(s.headers) }
          : { name: s.name, command: globalThis.process.execPath, args: [bridge!.proxy], env: pairs({ ELECTRON_RUN_AS_NODE: "1", MCP_PROXY_URL: s.url!, MCP_PROXY_HEADERS: JSON.stringify(s.headers ?? {}) }) }
        : { name: s.name, command: s.command, args: s.args ?? [], env: pairs(s.env) });
      let session: Wire | undefined;
      if (sessionId) {
        const method = caps.sessionCapabilities?.resume ? "session/resume" : caps.loadSession ? "session/load" : "";
        if (method) {
          replaying = method === "session/load"; // load replays history as updates
          session = await rpc(method, { sessionId, cwd: ctx.cwd, mcpServers: servers }).catch(() => undefined);
          replaying = false;
        }
      }
      if (!session) {
        session = await rpc("session/new", { cwd: ctx.cwd, mcpServers: servers });
        sessionId = String(session.sessionId);
        sentInstructions = false;
      }
      await configure(session);
      if (stopped) return settle("stopped");
      await run(job.prompt);
    })().catch((error: unknown) => settle(stopped ? "stopped" : "failed", errorText(error)));
    return {
      result: completion.then(async (result) => { await process?.stop(); await bridge?.dispose(); return result; }),
      steer: async (content) => { if (finished) throw new Error("Turn already completed"); queued.push(content); },
      interrupt: async () => {
        stopped = true;
        const timer = setTimeout(() => settle("stopped"), 3000); timer.unref();
        if (sessionId && process) { try { process.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); } catch { /* already gone */ } }
        if (!prompting) settle("stopped");
      },
    };
  }
}
