import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("MCP server", () => {
  it("gives a coding agent read-only workspace tools with a per-turn bearer token", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const bootstrap = await createTodo(app, projectId, agentId, "Bootstrap"); const machine = await enroll(app, 2);
    await requestJson(app, `/api/todos/${bootstrap}/start`, "POST", {});
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
    // A coding agent observes the workspace and manages skills, but does not manage tasks.
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name).sort()).toEqual(["get_task", "get_task_log", "get_workspace", "list_agents", "list_skills", "list_tasks", "list_workspaces"]);
    expect(tools.map((tool) => tool.name)).not.toContain("create_task");
    const workspace = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_workspace", arguments: { workspaceId: projectId } } });
    expect(JSON.parse(workspace.json.result.content[0].text)).toMatchObject({ id: projectId, tasks: [{ id: bootstrap, phase: "building" }] });
  });

  it("lets a workspace's master agent create, start and follow tasks only in its own workspace", async () => {
    const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app, 2);
    const other = (await requestJson(app, "/api/projects", "POST", { name: "Other", repoUrl: "/tmp/other" })).json.data;
    const outside = await createTodo(app, other.id, agentId, "Outside");
    services.db.run("UPDATE agents SET runtime='mock', model='mock' WHERE is_chief=1");
    services.orchestrator.enqueueChief(services.orchestrator.topicFor(projectId), "Split the goal");
    const job = services.scheduler.claim(machine.token)!;
    let sessionId = ""; let seq = 0;
    const call = async (name: string, args: object = {}) => {
      const response = await requestJson(app, "/mcp", "POST", seq === 0 ? { jsonrpc: "2.0", id: ++seq, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } } : { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }, job.mcp.token, sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" } : undefined);
      sessionId ||= response.response.headers.get("mcp-session-id") ?? "";
      return response.json.result;
    };
    await call("initialize");
    const created = await call("create_task", { title: "From master", spec: "MCP-created", agentId });
    expect(JSON.parse(created.content[0].text)).toMatchObject({ projectId, title: "From master", createdBy: "chief", phase: "queued" });
    const backlog = JSON.parse((await call("create_task", { title: "Later", start: false })).content[0].text);
    expect(backlog.phase).toBe("todo");
    expect((await call("start_task", { taskId: backlog.id })).isError).not.toBe(true);
    expect((await requestJson(app, `/api/todos/${backlog.id}`)).json.data.phase).toBe("queued");
    const missingAgent = await call("create_task", { title: "Bad agent", agentId: "missing" });
    expect(missingAgent.isError).toBe(true);
    expect(missingAgent.content[0].text).toContain("Agent not found");
    expect((await call("create_task", { workspaceId: other.id, title: "Elsewhere" })).content[0].text).toContain("limited to its own workspace");
    expect((await call("close_task", { taskId: outside })).content[0].text).toContain("another workspace");
    expect(JSON.parse((await call("list_tasks")).content[0].text).map((task: { title: string }) => task.title)).toEqual(["Later", "From master"]);
  });

  it("lets a turn reconnect with a fresh session, as ACP agents do", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const todoId = await createTodo(app, projectId, agentId); const machine = await enroll(app);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
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
    const { projectId, agentId } = await seedProjectAndAgent(app); const todoId = await createTodo(app, projectId, agentId); const machine = await enroll(app);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
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
    const ids = await Promise.all(["one", "two"].map((title) => createTodo(app, projectId, agentId, title)));
    ids.forEach((todoId) => services.orchestrator.start(todoId));
    const first = services.scheduler.claim(machine.token)!; const second = services.scheduler.claim(machine.token)!;
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    const initial = await requestJson(app, "/mcp", "POST", initialize, first.mcp.token);
    const stolenSession = initial.response.headers.get("mcp-session-id")!;
    const result = await requestJson(app, "/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, second.mcp.token, { "mcp-session-id": stolenSession });
    expect(result.response.status).toBe(404);
  });
});
