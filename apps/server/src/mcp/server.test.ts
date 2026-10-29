import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("MCP server", () => {
  it("creates and starts a todo with a per-turn bearer token", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const bootstrap = await createTodo(app, projectId, agentId, "run", "Bootstrap"); const machine = await enroll(app, 2);
    await requestJson(app, `/api/todos/${bootstrap}/start`, "POST", { mode: "run" });
    const job = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    let sessionId: string | null = null;
    const mcp = async (payload: unknown) => {
      const response = await requestJson(app, "/mcp", "POST", payload, job.mcp.token, sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" } : undefined);
      sessionId ??= response.response.headers.get("mcp-session-id");
      return response;
    };
    const initialized = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(initialized.response.status).toBe(200);
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    const catalog = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const tools = catalog.json.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name).sort()).toEqual(["get_todo", "list_agents", "list_connections", "list_memories", "list_projects", "list_schedules", "list_skills", "list_todos"]);
    const created = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_todo", arguments: { projectId, title: "From Chief", spec: "MCP-created", agentId, mode: "plan" } } });
    expect(created.response.status).toBe(200);
    const createdTodo = JSON.parse(created.json.result.content[0].text);
    expect(createdTodo).toMatchObject({ title: "From Chief", createdBy: "chief", phase: "todo" });
    const missingAgent = await mcp({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "create_todo", arguments: { projectId, title: "Bad agent", spec: "", agentId: "missing", mode: "plan" } } });
    expect(missingAgent.json.result.isError).toBe(true);
    expect(missingAgent.json.result.content[0].text).toContain("Agent not found");
    const started = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "start_todo", arguments: { todoId: createdTodo.id, mode: "plan" } } });
    expect(started.json.result.isError).not.toBe(true);
    expect((await requestJson(app, `/api/todos/${createdTodo.id}`)).json.data.phase).toBe("queued");
  });

  it("lets a turn reconnect with a fresh session, as ACP agents do", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const todoId = await createTodo(app, projectId, agentId, "run"); const machine = await enroll(app);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", { mode: "run" });
    const job = services.scheduler.claim(machine.token)!;
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    const sessions: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await requestJson(app, "/mcp", "POST", initialize, job.mcp.token);
      expect(response.response.status).toBe(200);
      sessions.push(response.response.headers.get("mcp-session-id")!);
    }
    expect(new Set(sessions).size).toBe(2);
    for (const sessionId of sessions) {
      const headers = { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" };
      await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", method: "notifications/initialized" }, job.mcp.token, headers);
      expect((await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, job.mcp.token, headers)).json.result.tools.length).toBeGreaterThan(0);
    }
    expect((await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", id: 3, method: "tools/list" }, job.mcp.token, { "mcp-session-id": "unknown", "mcp-protocol-version": "2025-03-26" })).response.status).toBe(404);
  });
});

describe("MCP authentication boundaries", () => {
  it("rejects missing/machine tokens, expired tokens, and stopped or offline assignments", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const todoId = await createTodo(app, projectId, agentId, "run"); const machine = await enroll(app);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", { mode: "run" });
    const job = services.scheduler.claim(machine.token)!;
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    expect((await requestJson(app, "/mcp", "POST", initialize)).response.status).toBe(401);
    expect((await requestJson(app, "/mcp", "POST", initialize, machine.token)).response.status).toBe(401);
    expect((await requestJson(app, "/mcp", "POST", initialize, job.mcp.token)).response.status).toBe(200);
    services.db.run("UPDATE machines SET last_seen_at=? WHERE id=?", "2000-01-01T00:00:00.000Z", machine.machineId);
    expect((await requestJson(app, "/mcp", "POST", initialize, job.mcp.token)).response.status).toBe(401);
    services.db.run("UPDATE machines SET last_seen_at=? WHERE id=?", new Date().toISOString(), machine.machineId);
    services.orchestrator.stop(todoId);
    expect((await requestJson(app, "/mcp", "POST", initialize, job.mcp.token)).response.status).toBe(401);
    services.scheduler.complete(machine.token, job.turnId, { status: "stopped" });
    expect((await requestJson(app, "/mcp", "POST", initialize, job.mcp.token)).response.status).toBe(401);
  });

  it("does not accept another turn's transport session ID", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app, 2);
    const ids = await Promise.all(["one", "two"].map((title) => createTodo(app, projectId, agentId, "run", title)));
    ids.forEach((todoId) => services.orchestrator.start(todoId, "run"));
    const first = services.scheduler.claim(machine.token)!; const second = services.scheduler.claim(machine.token)!;
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    const initial = await requestJson(app, "/mcp", "POST", initialize, first.mcp.token);
    const stolenSession = initial.response.headers.get("mcp-session-id")!;
    const result = await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, second.mcp.token, { "mcp-session-id": stolenSession });
    expect(result.response.status).toBe(404);
  });
});
