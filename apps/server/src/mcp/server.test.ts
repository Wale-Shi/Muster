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
    const created = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_todo", arguments: { projectId, title: "From Chief", spec: "MCP-created", agentId, mode: "plan" } } });
    expect(created.response.status).toBe(200);
    const createdTodo = JSON.parse(created.json.result.content[0].text);
    expect(createdTodo).toMatchObject({ title: "From Chief", createdBy: "chief", phase: "todo" });
    const started = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "start_todo", arguments: { todoId: createdTodo.id, mode: "plan" } } });
    expect(started.json.result.isError).not.toBe(true);
    expect((await requestJson(app, `/api/todos/${createdTodo.id}`)).json.data.phase).toBe("queued");
  });
});
