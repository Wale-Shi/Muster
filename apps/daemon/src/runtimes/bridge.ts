import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnJob } from "@muster/shared";

// Dependency-free scripts written next to each turn, so they work from the
// desktop bundle too. They let CLIs without (HTTP) MCP support reach Muster's
// MCP endpoint and the agent's granted connections.

export interface McpServer { name: string; transport: "http" | "stdio"; url?: string | undefined; headers?: Record<string, string>; command?: string | undefined; args?: string[]; env?: Record<string, string> }

/** Muster's own endpoint plus the connections granted to the agent. */
export function mcpServers(job: TurnJob): McpServer[] {
  return [
    ...(job.connections ?? []).map((c): McpServer => c.transport === "http"
      ? { name: c.identifier, transport: "http", url: c.url, headers: c.headers ?? {} }
      : { name: c.identifier, transport: "stdio", command: c.command, args: c.args ?? [], env: c.env ?? {} }),
    { name: "muster", transport: "http", url: job.mcp.url, headers: { Authorization: `Bearer ${job.mcp.token}` } },
  ];
}

const client = String.raw`
import { spawn } from "node:child_process";
function events(body) {
  return body.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")).filter(Boolean).map((data) => JSON.parse(data));
}
export function httpMcp(url, headers = {}) {
  let session = "";
  const post = async (message) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(message) });
    session = response.headers.get("mcp-session-id") ?? session;
    const body = await response.text();
    if (!response.ok) throw new Error("MCP HTTP " + response.status + ": " + body.slice(0, 500));
    if (!body.trim()) return [];
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) return events(body);
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  return rpc(post);
}
export function stdioMcp(command, args = [], env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    buffered += data;
    for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
      const line = buffered.slice(0, index).trim(); buffered = buffered.slice(index + 1);
      if (!line) continue;
      try { const message = JSON.parse(line); waiting.get(message.id)?.([message]); waiting.delete(message.id); } catch {}
    }
  });
  const post = (message) => new Promise((resolve) => {
    if (message.id === undefined) resolve([]); else waiting.set(message.id, resolve);
    child.stdin.write(JSON.stringify(message) + "\n");
  });
  return { ...rpc(post), close: () => child.kill() };
}
function rpc(post) {
  let sequence = 0;
  return {
    post,
    async request(method, params) {
      const id = ++sequence;
      const reply = (await post({ jsonrpc: "2.0", id, method, params })).find((message) => message.id === id);
      if (!reply) throw new Error("No MCP reply to " + method);
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    },
    notify: (method, params) => post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
  };
}
`;

/** A stdio MCP server that forwards every message to one HTTP MCP endpoint. */
const proxy = String.raw`
import { httpMcp } from "./mcp-client.mjs";
const upstream = httpMcp(process.env.MCP_PROXY_URL, JSON.parse(process.env.MCP_PROXY_HEADERS || "{}"));
let buffered = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffered += data;
  for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
    const line = buffered.slice(0, index).trim(); buffered = buffered.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    // Keep order so initialize settles the session before later requests.
    queue = queue.then(() => upstream.post(message)).then(
      (replies) => { for (const reply of replies) process.stdout.write(JSON.stringify(reply) + "\n"); },
      (error) => { if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }) + "\n"); },
    );
  }
});
process.stdin.on("end", () => { void queue.then(() => process.exit(0)); });
`;

/** pi extension: registers each MCP tool as mcp__<server>__<tool>. */
const piExtension = String.raw`
import { readFileSync } from "node:fs";
import { httpMcp, stdioMcp } from "./mcp-client.mjs";
export default async function (pi) {
  const config = JSON.parse(readFileSync(process.env.PI_MUSTER_BRIDGE_CONFIG, "utf8"));
  const names = [];
  for (const server of config.servers) {
    try {
      const mcp = server.transport === "http" ? httpMcp(server.url, server.headers) : stdioMcp(server.command, server.args, server.env);
      await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "muster-pi-bridge", version: "0.1.0" } });
      await mcp.notify("notifications/initialized");
      const { tools = [] } = await mcp.request("tools/list", {});
      for (const tool of tools) {
        const name = ("mcp__" + server.name + "__" + tool.name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        names.push(name);
        pi.registerTool({
          name, label: tool.title ?? tool.name, description: tool.description ?? tool.name,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          async execute(_id, params) {
            const result = await mcp.request("tools/call", { name: tool.name, arguments: params ?? {} });
            const content = (result.content ?? []).map((part) => part.type === "text" || part.type === "image" ? part : { type: "text", text: JSON.stringify(part) });
            if (result.isError) throw new Error(content.map((part) => part.text ?? "").join("\n") || "Tool failed");
            return { content: content.length ? content : [{ type: "text", text: JSON.stringify(result.structuredContent ?? {}) }], details: result.structuredContent ?? {} };
          },
        });
      }
    } catch (error) { console.error("Muster bridge: " + server.name + ": " + (error?.message ?? error)); }
  }
}
`;

export interface Bridge { dir: string; proxy: string; piExtension: string; piConfig: string; dispose(): Promise<void> }

/** Writes the bridge scripts (and, for pi, the private config) for one turn. */
export async function writeBridge(job: TurnJob): Promise<Bridge> {
  const dir = await mkdtemp(join(tmpdir(), "muster-bridge-"));
  const files = { client: join(dir, "mcp-client.mjs"), proxy: join(dir, "mcp-proxy.mjs"), piExtension: join(dir, "muster-pi.mjs"), piConfig: join(dir, "config.json") };
  await writeFile(files.client, client);
  await writeFile(files.proxy, proxy);
  await writeFile(files.piExtension, piExtension);
  await writeFile(files.piConfig, JSON.stringify({ servers: mcpServers(job) }), { mode: 0o600 });
  return { dir, proxy: files.proxy, piExtension: files.piExtension, piConfig: files.piConfig, dispose: () => rm(dir, { recursive: true, force: true }) };
}
