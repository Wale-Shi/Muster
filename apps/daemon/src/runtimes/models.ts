import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MODELS, runtimeInfo, type MachineModels, type Runtime, type RuntimeModel } from "@muster/shared";
import { JsonProcess, type Wire } from "./process.js";
import { runtimeEnv } from "./env.js";
import { errorText } from "../util.js";

const PI_THINKING = ["off", "minimal", "low", "medium", "high"];

/** Runs `command args`, resolving with stdout; rejects on a non-zero exit or timeout. */
function output(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: runtimeEnv(), stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal } : {}) });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Timed out listing models")); }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(stderr.trim() || `Exited with ${code}`)); });
  });
}

/** Sends JSONL requests to a long-running CLI until `done` returns models, then stops it. */
async function conversation(command: string, args: string[], timeoutMs: number, signal: AbortSignal | undefined, talk: (process: JsonProcess, cwd: string) => Promise<RuntimeModel[]>): Promise<RuntimeModel[]> {
  const cwd = await mkdtemp(join(tmpdir(), "muster-models-"));
  const process = new JsonProcess(command, args, cwd);
  process.ignoreInvalid = true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      talk(process, cwd),
      new Promise<never>((_, reject) => {
        process.onFailure = reject;
        timer = setTimeout(() => reject(new Error("Timed out listing models")), timeoutMs);
        signal?.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await process.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

function requests(process: JsonProcess, match: (message: Wire) => string | number | undefined) {
  const waiting = new Map<string | number, (message: Wire) => void>();
  process.onMessage = (message) => { const key = match(message); if (key !== undefined) { waiting.get(key)?.(message); waiting.delete(key); } };
  return (key: string | number, message: Wire) => new Promise<Wire>((resolve) => { waiting.set(key, resolve); process.send(message); });
}

async function codex(command: string, timeoutMs: number, signal?: AbortSignal): Promise<RuntimeModel[]> {
  // `codex debug models` prints the live catalog as JSON on its first line.
  const catalog = JSON.parse((await output(command, ["debug", "models"], timeoutMs, signal)).split("\n")[0] ?? "{}") as Wire;
  // Hidden models still run when named explicitly, so keep them after the listed ones.
  const models = (catalog.models ?? []) as Wire[];
  const listed = (m: Wire) => (m.visibility ?? "list") === "list";
  return [...models.filter(listed), ...models.filter((m) => !listed(m))].map((m) => ({
    id: String(m.slug), name: String(m.display_name ?? m.slug),
    reasoning: ((m.supported_reasoning_levels ?? []) as Wire[]).map((level) => String(level.effort)),
  }));
}

function pi(command: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<RuntimeModel[]> {
  return conversation(command, [...args, "--no-session"], timeoutMs, signal, async (process) => {
    const ask = requests(process, (m) => m.type === "response" ? m.id : undefined);
    const response = await ask("models", { id: "models", type: "get_available_models" });
    if (!response.success) throw new Error(String(response.error ?? "pi could not list models"));
    return ((response.data?.models ?? []) as Wire[]).map((m) => ({
      id: `${String(m.provider)}/${String(m.id)}`, name: String(m.name ?? m.id), ...(m.reasoning ? { reasoning: PI_THINKING } : {}),
    }));
  });
}

function acp(command: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<RuntimeModel[]> {
  // Opening a session lists models without calling one; the session is discarded.
  return conversation(command, [...args], timeoutMs, signal, async (process, cwd) => {
    const ask = requests(process, (m) => m.method === undefined ? m.id : undefined);
    let id = 0;
    const call = async (method: string, params: Wire) => {
      const reply = await ask(++id, { jsonrpc: "2.0", id, method, params });
      if (reply.error) throw new Error(String(reply.error.message ?? method));
      return (reply.result ?? {}) as Wire;
    };
    await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "muster-daemon", version: "0.1.0" } });
    const session = await call("session/new", { cwd, mcpServers: [] });
    const options = (session.configOptions ?? []) as Wire[];
    const effort = options.find((o) => o.category === "thought_level" || /reason|effort|thought/i.test(String(o.id)));
    const reasoning = ((effort?.options ?? []) as Wire[]).map((o) => String(o.value));
    const select = options.find((o) => o.category === "model" || o.id === "model");
    const listed = (session.models?.availableModels ?? []) as Wire[];
    const models = listed.length ? listed.map((m) => ({ id: String(m.modelId), name: String(m.name ?? m.modelId) }))
      : ((select?.options ?? []) as Wire[]).map((o) => ({ id: String(o.value), name: String(o.name ?? o.value) }));
    return models.map((m) => (reasoning.length ? { ...m, reasoning } : m));
  });
}

/** Asks each installed runtime CLI which models it offers; failures are reported per runtime. */
export async function discoverModels(commands: Partial<Record<Runtime, string>>, timeoutMs = 20_000, signal?: AbortSignal): Promise<MachineModels> {
  const found: MachineModels = { mock: { models: [{ id: "mock", name: "Mock" }], checkedAt: new Date().toISOString() } };
  await Promise.all(Object.entries(commands).map(async ([id, command]) => {
    const runtime = id as Runtime; const info = runtimeInfo(runtime);
    try {
      const models = info.protocol === "codex" ? await codex(command, timeoutMs, signal)
        : info.protocol === "claude" ? CLAUDE_MODELS
        : info.protocol === "pi" ? await pi(command, info.args, timeoutMs, signal)
        : info.protocol === "acp" ? await acp(command, info.args, timeoutMs, signal)
        : [];
      found[runtime] = { models, checkedAt: new Date().toISOString() };
    } catch (error) {
      found[runtime] = { models: [], error: errorText(error).slice(0, 500), checkedAt: new Date().toISOString() };
    }
  }));
  return found;
}
