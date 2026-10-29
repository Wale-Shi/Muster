import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@muster/shared";
import { CodexRuntime } from "../src/runtimes/codex.js";
import { ClaudeRuntime } from "../src/runtimes/claude.js";
import { makeJob, until } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function context() { const cwd = await mkdtemp(join(tmpdir(), "muster-adapter-")); roots.push(cwd); const events: AgentEvent[] = []; return { cwd, events, emit: (event: AgentEvent) => { events.push(event); } }; }
// Local protocol peers exercise the real process/stdio adapters, never model APIs.
const codexPeer = (readOnly = true, notifications = "", modelCheck = "p.model==='test-only'") => `
const readline = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const notify = (method, params) => send({method,params});
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line), p=m.params;
 const reply = result => send({id:m.id,result});
 if(m.method==='initialize') { if(p.clientInfo.name!=='muster-daemon'||p.clientInfo.title!==null) throw Error('initialize'); reply({}); }
 else if(m.method==='initialized') {}
 else if(m.method==='thread/start'||m.method==='thread/resume') {
  if(p.approvalPolicy!=='never'||p.developerInstructions!=='Follow the task'||p.config.mcp_servers.muster.http_headers.Authorization!=='Bearer test-only'||p.config.mcp_servers.muster.url!=='http://localhost:7420/mcp'||p.config.mcp_servers.muster.required!==true) throw Error('thread config');
  if(p.config.mcp_servers.muster.default_tools_approval_mode!=='approve') throw Error('Muster MCP approval');
  if(JSON.stringify(Object.keys(p.config))!==JSON.stringify(['shell_environment_policy','mcp_servers'])||JSON.stringify(Object.keys(p.config.mcp_servers))!==JSON.stringify(['muster'])) throw Error('MCP approval must be scoped to Muster');
  if(p.sandbox!==${JSON.stringify(readOnly ? "read-only" : "danger-full-access")}) throw Error('sandbox');
  if(!(${modelCheck})) throw Error('model');
  if(m.method==='thread/resume' && p.threadId!=='thread-test') throw Error('resume');
  reply({thread:{id:'thread-test'}});
 }
 else if(m.method==='turn/start') {
  if(p.input[0].text_elements.length!==0||p.effort!=='high') throw Error('turn input');
  if(p.approvalPolicy!=='never'||JSON.stringify(p.sandboxPolicy)!==${JSON.stringify(JSON.stringify(readOnly ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" }))}) throw Error('turn sandbox policy');
  if('developerInstructions' in p) throw Error('unsupported turn instructions');
  reply({turn:{id:'active-turn'}});
  notify('turn/started',{threadId:'thread-test',turn:{id:'active-turn'}});
  ${notifications}
  notify('item/agentMessage/delta',{threadId:'thread-test',delta:'Hello '});
  notify('item/reasoning/summaryTextDelta',{threadId:'thread-test',delta:'Thinking'});
  notify('item/started',{threadId:'thread-test',item:{type:'commandExecution',id:'call',command:'pwd'}});
  notify('item/completed',{threadId:'thread-test',item:{type:'commandExecution',id:'call',aggregatedOutput:'ok'}});
  notify('thread/tokenUsage/updated',{threadId:'thread-test',turnId:'active-turn',tokenUsage:{total:{inputTokens:120,outputTokens:50},last:{inputTokens:10,outputTokens:5}}});
 }
 else if(m.method==='turn/steer') {
  if(p.expectedTurnId!=='active-turn'||p.input[0].text!=='More') throw Error('steer');
  reply({turnId:'active-turn'});
  notify('item/agentMessage/delta',{threadId:'thread-test',delta:'More'});
  notify('item/completed',{threadId:'thread-test',item:{type:'agentMessage',id:'msg',text:'Hello More'}});
  notify('turn/completed',{threadId:'thread-test',turn:{id:'active-turn',status:'completed',error:null}});
 }
 else if(m.method==='turn/interrupt') {
  if(p.threadId!=='thread-test'||p.turnId!=='active-turn') throw Error('interrupt'); reply({});
  notify('turn/completed',{threadId:'thread-test',turn:{id:'active-turn',status:'interrupted',error:null}});
 }
 else throw Error('Unexpected method '+m.method);
});`;
it("Codex initializes, resumes, maps notifications, steers and counts only this turn's usage", async () => {
  const ctx = await context();
  const job = makeJob({ readOnly: true, sessionState: { threadId: "thread-test", tokensIn: 100, tokensOut: 30 }, agent: { runtime: "codex", model: "test-only", reasoning: "high", role: "test" } });
  const running = new CodexRuntime(process.execPath, ["-e", codexPeer(), "--"]).start(job, ctx);
  await until(async () => ctx.events.length, (length) => length >= 5);
  await running.steer("More");
  const result = await running.result;
  expect(result).toMatchObject({ status: "done", text: "Hello More", usage: { tokensIn: 20, tokensOut: 20 }, sessionState: { threadId: "thread-test", tokensIn: 120, tokensOut: 50 } });
  expect(ctx.events).toContainEqual({ type: "reasoning.delta", content: "Thinking" });
  expect(ctx.events.some((event) => event.type === "tool.completed")).toBe(true);
});
it("Codex starts a new thread and interrupts the active turn", async () => {
  const ctx = await context();
  const running = new CodexRuntime(process.execPath, ["-e", codexPeer(), "--"]).start(makeJob({ readOnly: true, agent: { runtime: "codex", model: "test-only", reasoning: "high", role: "test" } }), ctx);
  await until(async () => ctx.events.length, (length) => length >= 5);
  await running.interrupt(); expect((await running.result).status).toBe("stopped");
});
it("Codex maps retry and warning notifications separately from status and continues the turn", async () => {
  const ctx = await context();
  const peer = codexPeer(true, `
  notify('error',{threadId:'thread-test',turnId:'active-turn',willRetry:true,error:{message:'Selected model is at capacity. Please try a different model.'}});
  notify('warning',{threadId:'other-thread',message:'Wrong thread'});
  notify('warning',{threadId:'thread-test',message:'Runtime warning'});`);
  const running = new CodexRuntime(process.execPath, ["-e", peer, "--"]).start(makeJob({ readOnly: true, agent: { runtime: "codex", model: "test-only", reasoning: "high", role: "test" } }), ctx);
  await until(async () => ctx.events.length, (length) => length >= 7);
  expect(ctx.events.filter((event) => event.type === "warning")).toEqual([
    { type: "warning", detail: "Selected model is at capacity. Please try a different model." },
    { type: "warning", detail: "Runtime warning" },
  ]);
  expect(ctx.events.some((event) => event.type === "status")).toBe(false);
  await running.steer("More");
  expect((await running.result).status).toBe("done");
});
it("Codex still fails on a non-retryable runtime error", async () => {
  const ctx = await context();
  const peer = codexPeer(true, "notify('error',{threadId:'thread-test',turnId:'active-turn',willRetry:false,error:{message:'Fatal runtime error'}});");
  const running = new CodexRuntime(process.execPath, ["-e", peer, "--"]).start(makeJob({ readOnly: true, agent: { runtime: "codex", model: "test-only", reasoning: "high", role: "test" } }), ctx);
  expect(await running.result).toMatchObject({ status: "failed", error: "Fatal runtime error" });
  expect(ctx.events.some((event) => event.type === "warning")).toBe(false);
});
const codexPhases = [
  { kind: "plan", readOnly: true },
  { kind: "build", readOnly: false },
  { kind: "revise", readOnly: true },
  { kind: "revise", readOnly: false },
  { kind: "merge", readOnly: false },
  { kind: "chief", readOnly: false },
] as const;
it.each(codexPhases.flatMap((phase) => [false, true].map((resume) => ({ ...phase, resume }))))("Codex approves only Muster MCP tools and preserves the phase sandbox ($kind, readOnly: $readOnly, resumed: $resume)", async ({ kind, readOnly, resume }) => {
  const ctx = await context();
  const job = makeJob({ kind, readOnly, sessionState: resume ? { threadId: "thread-test" } : null, agent: { runtime: "codex", model: "test-only", reasoning: "high", role: "test" } });
  const running = new CodexRuntime(process.execPath, ["-e", codexPeer(readOnly), "--"]).start(job, ctx);
  await until(async () => ctx.events.length, (length) => length >= 5);
  await running.steer("More");
  expect(await running.result).toMatchObject({ status: "done", sessionState: { threadId: "thread-test" } });
});
it("Codex reports early child failure instead of hanging RPC requests", async () => {
  const ctx = await context();
  const result = await new CodexRuntime(process.execPath, ["-e", "process.exit(7)", "--"]).start(makeJob(), ctx).result;
  expect(result.status).toBe("failed"); expect(result.error).toContain("7");
});
it("Claude streams, accepts additional user messages, resumes, and returns usage", async () => {
  const ctx = await context();
  const peer = `
const readline=require('node:readline');
const args=process.argv.slice(1);
if(!args.includes('--include-partial-messages')||!args.includes('--resume')||args[args.indexOf('--resume')+1]!=='session-test') throw Error('CLI args');
if(args[args.indexOf('--model')+1]!=='mock-1') throw Error('CLI model');
const mcp=JSON.parse(args[args.indexOf('--mcp-config')+1]);
if(mcp.mcpServers.muster.headers.Authorization!=='Bearer test-only'||mcp.mcpServers.muster.url!=='http://localhost:7420/mcp'||mcp.mcpServers.muster.type!=='http') throw Error('MCP');
if(args[args.indexOf('--system-prompt-snapshot')+1]!=='off') throw Error('stale instructions');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let count=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.type!=='user'||m.message.role!=='user') throw Error('input'); count++;
 send({type:'system',subtype:'init',session_id:'session-test'});
 send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:m.message.content}}});
 if(count===2){
 send({type:'assistant',message:{content:[{type:'text',text:'Final plan'},{type:'tool_use',id:'tool',name:'Read',input:{path:'a'}}]}});
 send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'ok'}]}});
 send({type:'result',subtype:'success',usage:{input_tokens:5,cache_read_input_tokens:2,cache_creation_input_tokens:1,output_tokens:3}});
 send({type:'result',subtype:'success',usage:{input_tokens:4,output_tokens:2}});
 }
});`;
  const running = new ClaudeRuntime(process.execPath, ["-e", peer, "--"]).start(makeJob({ sessionState: { sessionId: "session-test" } }), ctx);
  await until(async () => ctx.events.length, (length) => length > 0);
  await running.steer("Also test");
  expect(await running.result).toMatchObject({ status: "done", text: "Final plan", usage: { tokensIn: 12, tokensOut: 5 }, sessionState: { sessionId: "session-test" } });
  expect(ctx.events.some((event) => event.type === "tool.started")).toBe(true);
  expect(ctx.events.some((event) => event.type === "tool.completed")).toBe(true);
});
it("Claude interruption terminates the child process", async () => {
  const ctx = await context();
  const running = new ClaudeRuntime(process.execPath, ["-e", "setInterval(()=>{},1000)", "--"]).start(makeJob(), ctx);
  await running.interrupt(); expect((await running.result).status).toBe("stopped");
});
it("Codex and Claude leave the model to the CLI when the agent uses the default", async () => {
  const ctx = await context();
  const running = new CodexRuntime(process.execPath, ["-e", codexPeer(true, "", "!('model' in p)"), "--"]).start(makeJob({ readOnly: true, agent: { runtime: "codex", model: "default", reasoning: "high", role: "test" } }), ctx);
  await until(async () => ctx.events.length, (length) => length >= 5);
  await running.steer("More");
  expect((await running.result).status).toBe("done");
  const peer = `const assert=require('node:assert/strict'); const args=process.argv.slice(1); assert.equal(args.includes('--model'),false); require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'Done',usage:{}})+'\\n'));`;
  expect((await new ClaudeRuntime(process.execPath, ["-e", peer, "--"]).start(makeJob({ agent: { runtime: "claude", model: "default", reasoning: null, role: "test" } }), ctx).result).status).toBe("done");
});

const grantedConnections = [
  { identifier: "linear", transport: "http" as const, url: "https://example.test/mcp", headers: { Authorization: "Bearer private-fixture" } },
  { identifier: "local", transport: "stdio" as const, command: "fixture", args: ["--flag"], env: { TOKEN: "private-env-fixture" } },
];
it.each([false, true])("Codex delivers exact granted HTTP/stdio config, readOnly=%s", async (readOnly) => {
  const ctx = await context(); const expected = {
    linear: { default_tools_approval_mode: "approve", url: "https://example.test/mcp", http_headers: { Authorization: "Bearer private-fixture" } },
    local: { default_tools_approval_mode: "approve", command: "fixture", args: ["--flag"], env: { TOKEN: "private-env-fixture" } },
    muster: { url: "http://localhost:7420/mcp", required: true, default_tools_approval_mode: "approve", http_headers: { Authorization: "Bearer test-only" } },
  };
  const peer = codexPeer(readOnly).replace("if(JSON.stringify(Object.keys(p.config))", `if(JSON.stringify(p.config.mcp_servers)!==${JSON.stringify(JSON.stringify(expected))}) throw Error('exact connection config');\n if(JSON.stringify(Object.keys(p.config))`).replace("JSON.stringify(['muster'])", "JSON.stringify(['linear','local','muster'])");
  const job = makeJob({ readOnly, connections: grantedConnections, sessionState: { threadId: "thread-test" }, agent: { runtime: "codex", model: "test-only", reasoning: "high", role: "test" } });
  const running = new CodexRuntime(process.execPath, ["-e", peer, "--"]).start(job, ctx); await until(async () => ctx.events.length, (length) => length >= 5); await running.steer("More"); expect((await running.result).status).toBe("done");
});
it.each([false, true])("Claude delivers exact granted HTTP/stdio config, readOnly=%s", async (readOnly) => {
  const ctx = await context(); const expected = { mcpServers: {
    linear: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer private-fixture" } },
    local: { type: "stdio", command: "fixture", args: ["--flag"], env: { TOKEN: "private-env-fixture" } },
    muster: { type: "http", url: "http://localhost:7420/mcp", headers: { Authorization: "Bearer test-only" } },
  } };
  const peer = `const assert=require('node:assert/strict'); const args=process.argv.slice(1); assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config')+1]),${JSON.stringify(expected)}); assert.equal(args[args.indexOf('--permission-mode')+1],${JSON.stringify(readOnly ? "plan" : "bypassPermissions")}); require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'Done',usage:{}})+'\\n'));`;
  expect((await new ClaudeRuntime(process.execPath, ["-e", peer, "--"]).start(makeJob({ readOnly, connections: grantedConnections }), ctx).result).status).toBe("done");
});
