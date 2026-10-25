import { afterEach, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "@muster/shared";
import { PiRuntime } from "../src/runtimes/pi.js";
import { AcpRuntime } from "../src/runtimes/acp.js";
import { writeBridge } from "../src/runtimes/bridge.js";
import { detectRuntimes, locateRuntimes } from "../src/daemon.js";
import { makeJob, until } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function context() { const cwd = await mkdtemp(join(tmpdir(), "muster-runtime-")); roots.push(cwd); const events: AgentEvent[] = []; return { cwd, events, emit: (event: AgentEvent) => { events.push(event); } }; }
const connection = { id: "c1", identifier: "linear", name: "Linear", transport: "http" as const, url: "http://linear.test/mcp", headers: { Authorization: "Bearer granted" } };

// Local protocol peers exercise the real process/stdio adapters, never model APIs.
const piPeer = String.raw`
const fs = require('node:fs');
const send = x => process.stdout.write(JSON.stringify(x)+'\n');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name)+1];
if (arg('--mode') !== 'rpc' || arg('--append-system-prompt') !== 'Follow the task' || arg('--model') !== 'anthropic/test-only' || arg('--thinking') !== 'high') throw Error('args ' + args);
if (!fs.readFileSync(arg('-e'), 'utf8').includes('registerTool')) throw Error('bridge extension');
const config = JSON.parse(fs.readFileSync(process.env.PI_MUSTER_BRIDGE_CONFIG, 'utf8'));
if (config.readOnly !== false || config.servers.map(s => s.name).join() !== 'linear,muster' || config.servers[1].headers.Authorization !== 'Bearer test-only') throw Error('bridge config');
if (args.includes('--session')) throw Error('missing session files must not be resumed');
let buffered = '';
process.stdin.on('data', d => { buffered += d; let i; while ((i = buffered.indexOf('\n')) >= 0) { const m = JSON.parse(buffered.slice(0, i)); buffered = buffered.slice(i + 1); handle(m); } });
function handle(m) {
  if (m.type === 'get_state') return send({ type: 'response', command: 'get_state', success: true, data: { sessionFile: '/sessions/pi.jsonl' } });
  if (m.type === 'prompt') {
    if (m.message !== 'Add a greeting') throw Error('prompt');
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow?' });
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Line one' } });
    send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } });
    send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  }
  if (m.type === 'extension_ui_response') { if (!m.cancelled) throw Error('dialogs are cancelled'); }
  if (m.type === 'steer') {
    if (m.message !== 'More') throw Error('steer');
    send({ type: 'response', command: 'steer', success: true });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, stopReason: 'stop' } });
    send({ type: 'agent_end', messages: [] });
  }
}`;

it("pi runs in RPC mode with the MCP bridge, streams, steers and keeps its session file", async () => {
  const ctx = await context();
  const job = makeJob({ agent: { runtime: "pi", model: "anthropic/test-only", reasoning: "high", role: "test" }, connections: [connection], sessionState: { sessionFile: join(ctx.cwd, "gone.jsonl") } });
  const running = new PiRuntime(process.execPath, ["-e", piPeer, "--", "--mode", "rpc"]).start(job, ctx);
  await until(async () => ctx.events, (events) => events.some((event) => event.type === "tool.completed"));
  await running.steer("More");
  const result = await running.result;
  expect(result).toMatchObject({ status: "done", text: "Done", usage: { tokensIn: 13, tokensOut: 5 }, sessionState: { sessionFile: "/sessions/pi.jsonl" } });
  expect(ctx.events).toEqual(expect.arrayContaining([
    { type: "reasoning.delta", content: "Hmm" },
    { type: "message.delta", content: "Line one" },
    { type: "tool.started", tool: "bash", callId: "call-1", input: { command: "ls" } },
    { type: "message.completed", content: "Done" },
  ]));
});

it("pi reports a failed model call and interrupts with abort", async () => {
  const failing = String.raw`
let b=''; const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
 if(m.type==='prompt'){send({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'No API key'}});send({type:'agent_end'});}}});`;
  const ctx = await context();
  expect(await new PiRuntime(process.execPath, ["-e", failing, "--"]).start(makeJob(), ctx).result).toMatchObject({ status: "failed", error: "No API key" });
  const hanging = String.raw`
let b=''; const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
 if(m.type==='abort'){send({type:'response',command:'abort',success:true});send({type:'agent_end'});}}});`;
  const running = new PiRuntime(process.execPath, ["-e", hanging, "--"]).start(makeJob(), ctx);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await running.interrupt();
  expect((await running.result).status).toBe("stopped");
});

const acpPeer = (http: boolean) => String.raw`
const send = x => process.stdout.write(JSON.stringify(x)+'\n');
let buffered = '', asked = 0;
console.log('banner on stdout is tolerated');
process.stdin.on('data', d => { buffered += d; let i; while ((i = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, i); buffered = buffered.slice(i + 1); handle(JSON.parse(line)); } });
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: u } });
function handle(m) {
  const p = m.params, reply = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    if (p.protocolVersion !== 1 || p.clientCapabilities.terminal !== false) throw Error('init');
    reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: ${http} } } });
  } else if (m.method === 'session/load') {
    if (p.sessionId !== 'old') throw Error('load');
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } });
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Session not found' } });
  } else if (m.method === 'session/new') {
    const [linear, muster] = p.mcpServers;
    if (${http}) { if (muster.type !== 'http' || muster.headers[0].value !== 'Bearer test-only' || linear.url !== 'http://linear.test/mcp') throw Error('http servers'); }
    else if (!muster.args[0].endsWith('mcp-proxy.mjs') || !muster.env.some(e => e.name === 'MCP_PROXY_URL' && e.value === 'http://localhost:7420/mcp')) throw Error('proxied servers');
    reply({ sessionId: 's-1', models: { currentModelId: 'a', availableModels: [{ modelId: 'a' }, { modelId: 'test-only' }] }, modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'plan' }] } });
  } else if (m.method === 'session/set_model') { if (p.modelId !== 'test-only') throw Error('model'); reply({}); }
  else if (m.method === 'session/set_mode') { if (p.modeId !== 'plan') throw Error('plan mode'); reply({}); }
  else if (m.method === 'session/prompt') {
    asked++;
    const text = p.prompt[0].text;
    if (asked === 1 && !text.startsWith('<instructions>\nFollow the task\n</instructions>')) throw Error('instructions lead the first prompt');
    if (asked === 2 && text !== 'More') throw Error('queued steer');
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 't' + asked, title: 'Write file', kind: 'edit', status: 'pending', rawInput: { path: 'a' } });
    send({ jsonrpc: '2.0', id: 'perm-' + asked, method: 'session/request_permission', params: { sessionId: 's-1', toolCall: { toolCallId: 't' + asked, kind: 'edit' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
    pendingPrompt = m.id;
  } else if (m.id === 'perm-1' || m.id === 'perm-2') {
    if (m.result.outcome.optionId !== 'no') throw Error('plan turns reject edits');
    update({ sessionUpdate: 'tool_call_update', toolCallId: m.id === 'perm-1' ? 't1' : 't2', status: 'failed', rawOutput: 'denied' });
    update({ sessionUpdate: 'plan', entries: [{ content: 'Step', status: 'completed' }] });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: m.id === 'perm-1' ? 'First' : 'Plan ready' } });
    if (m.id === 'perm-1') process.stdin.emit('steer-window');
    setTimeout(() => send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3, cachedReadTokens: 1 } } }), m.id === 'perm-1' ? 300 : 0);
  }
  else throw Error('Unexpected ' + JSON.stringify(m));
}
let pendingPrompt;`;

for (const http of [true, false]) {
  it(`ACP ${http ? "passes HTTP MCP servers" : "proxies MCP over stdio"}, plans read-only, queues steering and keeps the session`, async () => {
    const ctx = await context();
    const job = makeJob({ readOnly: true, connections: [connection], agent: { runtime: "gemini", model: "test-only", reasoning: null, role: "test" }, sessionState: { sessionId: "old", instructions: "stale" } });
    const running = new AcpRuntime(process.execPath, ["-e", acpPeer(http), "--", "--acp"], "Test ACP").start(job, ctx);
    await until(async () => ctx.events, (events) => events.some((event) => event.type === "message.delta" && event.content === "First"));
    await running.steer("More");
    const result = await running.result;
    expect(result).toMatchObject({ status: "done", text: "Plan ready", usage: { tokensIn: 16, tokensOut: 6 }, sessionState: { sessionId: "s-1" } });
    expect(ctx.events.some((event) => event.type === "message.delta" && event.content === "replayed history")).toBe(false);
    expect(ctx.events).toEqual(expect.arrayContaining([
      { type: "reasoning.delta", content: "Thinking" },
      { type: "message.completed", content: "Looking" },
      { type: "tool.started", tool: "Write file", callId: "t1", input: { path: "a" } },
      { type: "plan.updated", content: "- [x] Step" },
    ]));
    expect(ctx.events.find((event) => event.type === "tool.completed")).toMatchObject({ callId: "t1", error: "\"denied\"" });
  });
}

it("ACP rejects an unknown model with the agent's list and cancels on interrupt", async () => {
  const ctx = await context();
  const peer = String.raw`
const send=x=>process.stdout.write(JSON.stringify(x)+'\n'); let b='';
process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true}}}});
 else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'s',models:{availableModels:[{modelId:'only'}]}}});
 else if(m.method==='session/prompt')globalThis.prompt=m.id;
 else if(m.method==='session/cancel')send({jsonrpc:'2.0',id:globalThis.prompt,result:{stopReason:'cancelled'}});}});`;
  const wrong = makeJob({ agent: { runtime: "qwen", model: "missing", reasoning: null, role: "test" } });
  expect(await new AcpRuntime(process.execPath, ["-e", peer, "--"], "Qwen Code").start(wrong, ctx).result).toMatchObject({ status: "failed", error: "Qwen Code has no model \"missing\". Available: only" });
  const running = new AcpRuntime(process.execPath, ["-e", peer, "--"]).start(makeJob({ agent: { runtime: "qwen", model: "default", reasoning: null, role: "test" } }), ctx);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await running.interrupt();
  expect((await running.result).status).toBe("stopped");
});

it("the pi bridge extension registers MCP tools over Streamable HTTP and restricts plan turns", async () => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      calls.push(`${message.method}:${request.headers.authorization}:${request.headers["mcp-session-id"] ?? ""}`);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} }
        : message.method === "tools/list" ? { tools: [{ name: "ask_user", description: "Ask", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }
        : { content: [{ type: "text", text: `asked ${JSON.stringify(message.params?.arguments)}` }], isError: message.params?.arguments === undefined };
      // Answer with SSE like the MCP SDK's Streamable HTTP transport does.
      response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "mcp-1" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const bridge = await writeBridge(makeJob({ readOnly: true, mcp: { url: `http://127.0.0.1:${port}/mcp`, token: "test-only" } }));
  try {
    process.env.PI_MUSTER_BRIDGE_CONFIG = bridge.piConfig;
    const tools: Array<{ name: string; execute(id: string, params: unknown): Promise<{ content: unknown }> }> = [];
    const handlers: Record<string, () => void> = {};
    let active: string[] = [];
    const extension = await import(pathToFileURL(bridge.piExtension).href) as { default(pi: unknown): Promise<void> };
    await extension.default({ registerTool: (tool: typeof tools[number]) => tools.push(tool), on: (event: string, handler: () => void) => { handlers[event] = handler; }, setActiveTools: (names: string[]) => { active = names; } });
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__muster__ask_user"]);
    expect(await tools[0]!.execute("call", { q: "hi" })).toMatchObject({ content: [{ type: "text", text: "asked {\"q\":\"hi\"}" }] });
    handlers.session_start?.();
    expect(active).toEqual(["read", "grep", "find", "ls", "mcp__muster__ask_user"]);
    expect(calls).toEqual(["initialize:Bearer test-only:", "notifications/initialized:Bearer test-only:mcp-1", "tools/list:Bearer test-only:mcp-1", "tools/call:Bearer test-only:mcp-1"]);
    // The stdio proxy ACP agents launch when they cannot take HTTP MCP servers.
    const proxy = spawn(process.execPath, [bridge.proxy], { env: { ...process.env, MCP_PROXY_URL: `http://127.0.0.1:${port}/mcp`, MCP_PROXY_HEADERS: JSON.stringify({ Authorization: "Bearer proxied" }) } });
    let output = "";
    proxy.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await until(async () => output, (text) => text.split("\n").filter(Boolean).length === 2);
    proxy.stdin.end();
    expect(output.trim().split("\n").map((line) => JSON.parse(line) as { id: number }).map((reply) => reply.id)).toEqual([1, 2]);
    expect(calls.slice(4)).toEqual(["initialize:Bearer proxied:", "notifications/initialized:Bearer proxied:mcp-1", "tools/list:Bearer proxied:mcp-1"]);
  } finally {
    delete process.env.PI_MUSTER_BRIDGE_CONFIG;
    await bridge.dispose(); server.close();
  }
});

it("detects runtimes on PATH, in install directories and from MUSTER_<ID>_BIN", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-detect-")); roots.push(root);
  const bin = join(root, "bin"); await mkdir(bin);
  for (const name of ["pi", "kiro-cli", "not-a-runtime"]) { await writeFile(join(bin, name), "#!/bin/sh\n"); await chmod(join(bin, name), 0o755); }
  await writeFile(join(root, "custom-gemini"), "#!/bin/sh\n"); await chmod(join(root, "custom-gemini"), 0o755);
  const found = await locateRuntimes(bin, { MUSTER_GEMINI_BIN: join(root, "custom-gemini") });
  expect(found).toMatchObject({ pi: join(bin, "pi"), kiro: join(bin, "kiro-cli"), gemini: join(root, "custom-gemini") });
  expect(await detectRuntimes(bin, {})).toEqual(expect.arrayContaining(["mock", "pi", "kiro"]));
});
