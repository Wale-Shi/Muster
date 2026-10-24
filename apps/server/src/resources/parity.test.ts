import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()));
async function setup(persistent = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "muster-b-")); cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, ...(persistent ? { databasePath: join(dataDir, "db") } : {}), autoFollowUp: false, claimWaitMs: 0 };
  const result = createApp(options); cleanups.push(() => result.services.db.close());
  const { projectId, agentId } = await seedProjectAndAgent(result.app); const todoId = await createTodo(result.app, projectId, agentId);
  const input = { todoId, cadence: "daily", hour: 9, minute: 0, timezone: "Asia/Shanghai" };
  return { ...result, options, projectId, agentId, todoId, input };
}
it("schedule CRUD validates cadences, disables past once and filters by task", async () => {
  const { app, input, todoId } = await setup();
  expect((await requestJson(app, "/api/schedules", "POST", { ...input, timezone: "bad" })).response.status).toBe(400);
  const created = await requestJson(app, "/api/schedules", "POST", input); expect(created.response.status).toBe(201); const key = created.json.data.id;
  expect((await requestJson(app, `/api/schedules?todoId=${todoId}`)).json.data).toHaveLength(1);
  expect((await requestJson(app, `/api/schedules/${key}`, "PATCH", { enabled: false })).json.data.enabled).toBe(false);
  expect((await requestJson(app, `/api/schedules/${key}/run`, "POST")).json.data.lastResult).toBe("started");
  expect((await requestJson(app, "/api/schedules", "POST", { ...input, cadence: "once", runAt: "2000-01-01T00:00:00Z" })).json.data.enabled).toBe(false);
  expect((await requestJson(app, `/api/schedules/${key}`, "DELETE")).response.status).toBe(204);
  expect((await requestJson(app, `/api/schedules/${key}`)).response.status).toBe(404);
});
it.each(["todo", "confirm", "review", "done", "closed", "failed"])("restarts %s cleanly and pins the build through claim retries", async (phase) => {
  const { app, services: s, input, todoId, agentId } = await setup();
  const a = await enroll(app); const b = await enroll(app);
  s.orchestrator.start(todoId, "run"); const old = s.scheduler.claim(a.token)!; s.scheduler.complete(a.token, old.turnId, { status: "done", plan: "OLD PLAN MUST NOT REPEAT", sessionState: { old: true } });
  s.db.run("UPDATE todos SET phase=?,done_at=? WHERE id=?", phase, phase === "done" ? new Date().toISOString() : null, todoId);
  const override = (await requestJson(app, "/api/agents", "POST", { name: "Override", role: "override", runtime: "mock", model: "override" })).json.data.id;
  const schedule = s.schedules.save({ ...input, mode: "run", machineId: b.machineId, agentId: override });
  expect(s.schedules.run(schedule.id).lastResult).toBe("started"); expect(s.scheduler.claim(a.token)).toBeNull();
  const job = s.scheduler.claim(b.token, "retry")!; expect(job.buildId).not.toBe(old.buildId); expect(job.sessionState).toBeNull(); expect(job.prompt).not.toContain("OLD PLAN"); expect(job.agent.model).toBe("override");
  expect(s.orchestrator.getTodo(todoId)).toMatchObject({ agentId, doneAt: null });
  s.scheduler.releaseClaim(b.token, job, "retry"); expect(s.scheduler.claim(a.token)).toBeNull(); expect(s.scheduler.claim(b.token)?.buildId).toBe(job.buildId);
  expect(s.db.rows("SELECT * FROM messages WHERE conversation_id=?", job.buildId).map((r) => s.db.message(r))).toEqual(expect.arrayContaining([expect.objectContaining({ content: "Scheduled run started", meta: expect.objectContaining({ scheduleId: schedule.id }) })]));
});
it("skips busy work, collapses missed occurrences, disables once, survives restart", async () => {
  const { app, services: s, input, todoId, options } = await setup(true); const m = await enroll(app);
  const schedule = s.schedules.save(input); s.db.run("UPDATE schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE id=?", schedule.id);
  s.schedules.tick(); expect(s.schedules.get(schedule.id).lastResult).toBe("started"); expect(Date.parse(s.schedules.get(schedule.id).nextRunAt!)).toBeGreaterThan(Date.now());
  s.schedules.tick(); expect(s.db.rows("SELECT * FROM turns")).toHaveLength(1);
  expect(s.schedules.run(schedule.id).lastResult).toBe("skipped_busy"); const job = s.scheduler.claim(m.token)!;
  s.orchestrator.close(todoId); expect(s.schedules.run(schedule.id).lastResult).toBe("skipped_busy"); s.scheduler.complete(m.token, job.turnId, { status: "stopped" });
  const once = s.schedules.save({ ...input, cadence: "once", runAt: new Date(Date.now() + 10000).toISOString() }); s.schedules.run(once.id); expect(s.schedules.get(once.id).enabled).toBe(false);
  // A second connection represents a server restart over the persisted database.
  const restarted = createApp(options); cleanups.push(() => restarted.services.db.close());
  expect(restarted.services.schedules.get(once.id)).toMatchObject({ enabled: false, lastResult: "started" }); restarted.services.schedules.tick(); expect(restarted.services.db.rows("SELECT * FROM turns")).toHaveLength(2);
});
it("validates identifiers and immutable edits; secrets stay encrypted and write-only", async () => {
  const { app, services: s } = await setup(); const input = { identifier: "linear", name: "Linear", transport: "http", url: "https://example.test/mcp", secrets: { Authorization: "Bearer confidential-token" } };
  for (const identifier of ["muster", "Aaa", "x", "a-b", "a".repeat(33)]) expect((await requestJson(app, "/api/connections", "POST", { ...input, identifier })).response.status).toBe(400);
  const c = (await requestJson(app, "/api/connections", "POST", input)).json.data;
  expect(c.secretKeys).toEqual(["Authorization"]); expect(JSON.stringify(c)).not.toContain("confidential-token"); expect(JSON.stringify(s.db.rows("SELECT * FROM connections"))).not.toContain("confidential-token");
  expect((await requestJson(app, `/api/connections/${c.id}`, "PATCH", { identifier: "changed" })).response.status).toBe(400);
  expect((await requestJson(app, "/api/connections", "POST", input)).response.status).toBe(409);
  expect((await requestJson(app, `/api/connections/${c.id}`, "PATCH", { name: "Renamed" })).json.data.secretKeys).toEqual(["Authorization"]);
  expect(JSON.stringify((await requestJson(app, "/api/connections")).json)).not.toContain("confidential-token");
});
it("delivers only grants, omits other-machine stdio, re-derives secrets on replay", async () => {
  const { app, services: s, todoId, agentId } = await setup(); const m = await enroll(app); const other = await enroll(app);
  const http = s.connections.save({ identifier: "remote", name: "Remote", transport: "http", url: "https://example.test/mcp", secrets: { Authorization: "Bearer confidential-token" } });
  const local = s.connections.save({ identifier: "local", name: "Local", transport: "stdio", command: "fixture", machineId: other.machineId, secrets: { TOKEN: "local-secret" } });
  s.orchestrator.start(todoId, "plan"); const first = s.scheduler.claim(m.token, "replay")!; expect(first.connections).toEqual([]);
  s.connections.grant(agentId, http.id, true); s.connections.grant(agentId, local.id, true);
  const job = s.scheduler.claim(m.token, "replay")!; expect(job.connections).toHaveLength(1); expect(job.connections![0]?.headers).toEqual({ Authorization: "Bearer confidential-token" }); expect(job.systemInstructions).toContain("mcp__remote__*");
  s.scheduler.claim(m.token, "replay"); expect(s.db.rows("SELECT * FROM messages WHERE turn_id=?", job.turnId)).toHaveLength(1);
  expect(JSON.stringify(s.db.rows("SELECT * FROM machine_claims"))).not.toMatch(/confidential-token|local-secret|headers/);
  s.connections.save({ secrets: { Authorization: "replacement-token" } }, http.id); expect(s.scheduler.claim(m.token, "replay")!.connections![0]!.headers!.Authorization).toBe("replacement-token");
  s.connections.grant(agentId, http.id, false); expect(s.scheduler.claim(m.token, "replay")!.connections).toEqual([]);
  s.connections.delete(local.id); expect(s.db.agent(s.db.row("SELECT * FROM agents WHERE id=?", agentId)!).connectionIds).toEqual([]);
});
it("tests HTTP initialize and tools/list with a local MCP fixture; stdio never executes on server", async () => {
  const { app, services: s } = await setup(); const mcp = new McpServer({ name: "fixture", version: "1" });
  for (let i = 0; i < 55; i++) mcp.registerTool(`tool_${i}`, {}, async () => ({ content: [] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID() }); await mcp.connect(transport);
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => req.headers.get("Authorization") === "Bearer fixture-secret" ? transport.handleRequest(req) : Response.json({}, { status: 401 }) });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const c = s.connections.save({ identifier: "fixture", name: "Fixture", transport: "http", url: `http://127.0.0.1:${port}/mcp`, secrets: { Authorization: "Bearer fixture-secret" } });
    const result = (await requestJson(app, `/api/connections/${c.id}/test`, "POST")).json.data; expect(result).toMatchObject({ ok: true, toolCount: 55 }); expect(result.tools).toHaveLength(50);
    s.connections.save({ secrets: {} }, c.id); expect((await s.connections.test(c.id)).ok).toBe(false);
    const local = s.connections.save({ identifier: "stdio", name: "Local", transport: "stdio", command: "never-execute-this" }); expect(await s.connections.test(local.id)).toMatchObject({ ok: false, error: "Will be tested by the machine on next run" });
  } finally { await mcp.close(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
it("Chief MCP lists/creates/deletes schedules and grants/revokes without exposing secrets", async () => {
  const { app, services: s, input, agentId } = await setup(); const m = await enroll(app); const chief = String(s.db.row("SELECT id FROM agents WHERE is_chief=1")!.id);
  await requestJson(app, `/api/agents/${chief}`, "PATCH", { runtime: "mock", model: "mock" }); s.orchestrator.enqueueChief(String(s.db.row("SELECT id FROM topics")!.id), "Schedule"); const job = s.scheduler.claim(m.token)!;
  let session = ""; let seq = 0; const rpc = async (method: string, params: unknown) => { const r = await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", id: ++seq, method, params }, job.mcp.token, session ? { "mcp-session-id": session } : undefined); session ||= r.response.headers.get("mcp-session-id") ?? ""; return r.json.result; };
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  const call = async (name: string, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).content[0].text);
  const schedule = await call("create_schedule", input); expect(await call("list_schedules")).toHaveLength(1); await call("delete_schedule", { scheduleId: schedule.id }); expect(s.schedules.list()).toEqual([]);
  const c = s.connections.save({ identifier: "remote", name: "Remote", transport: "http", url: "https://example.test", secrets: { Authorization: "super-private-token" } });
  expect(JSON.stringify(await call("list_connections"))).not.toContain("super-private-token"); await call("grant_connection", { agentId, connectionId: c.id }); expect(s.db.agent(s.db.row("SELECT * FROM agents WHERE id=?", agentId)!).connectionIds).toEqual([c.id]); await call("revoke_connection", { agentId, connectionId: c.id }); expect(s.db.agent(s.db.row("SELECT * FROM agents WHERE id=?", agentId)!).connectionIds).toEqual([]);
  const tools = (await rpc("tools/list", {})).tools; expect(tools.find((t: { name: string }) => t.name === "list_schedules").annotations.readOnlyHint).toBe(true);
});

it("partial updates preserve run mode, disabled state and stdio arguments", async () => {
  const { app, services: s, input } = await setup();
  const schedule = s.schedules.save({ ...input, mode: "run", enabled: false });
  const renamed = await requestJson(app, `/api/schedules/${schedule.id}`, "PATCH", { minute: 25 });
  expect(renamed.json.data).toMatchObject({ mode: "run", enabled: false, minute: 25 });
  const toggled = await requestJson(app, `/api/schedules/${schedule.id}`, "PATCH", { enabled: true }); expect(toggled.json.data.mode).toBe("run");
  const connection = s.connections.save({ identifier: "local", name: "Local", transport: "stdio", command: "npx", args: ["-y", "fixture"], secrets: { TOKEN: "keep-this-token" } });
  const updated = await requestJson(app, `/api/connections/${connection.id}`, "PATCH", { name: "Renamed" }); expect(updated.json.data.args).toEqual(["-y", "fixture"]); expect(updated.json.data.secretKeys).toEqual(["TOKEN"]);
});
