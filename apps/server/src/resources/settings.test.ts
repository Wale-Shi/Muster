import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createApp } from "../app.js";
import { requestJson, seedProjectAndAgent, createTodo } from "../test/helpers.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()));
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "muster-phase-c-")); cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = createApp({ dataDir, claimWaitMs: 0, autoFollowUp: false }); cleanup.push(() => result.services.db.close()); return { ...result, dataDir };
}
it("stores validated settings and notification preferences server-side", async () => {
  const { app, services } = setup();
  expect((await requestJson(app, "/api/settings")).json.data.workspaceName).toBe("Muster");
  expect((await requestJson(app, "/api/settings", "PATCH", { workspaceName: "Studio" })).response.status).toBe(200);
  expect(services.db.row("SELECT value FROM settings WHERE key='workspaceName'")?.value).toBe('"Studio"');
  expect((await requestJson(app, "/api/settings", "PATCH", { language: "zh-CN" })).response.status).toBe(400);
  expect((await requestJson(app, "/api/settings/notifications", "PATCH", { done: false, dockBadge: false })).json.data).toEqual({ review: true, failed: true, done: false, dockBadge: false });
  expect((await requestJson(app, "/api/settings/notifications", "PATCH", { confirm: false })).response.status).toBe(400);
  expect((await requestJson(app, "/api/settings/notifications")).json.data.done).toBe(false);
});
it("reveals a key once, stores only SHA256, tracks usage and revokes", async () => {
  const { app, services } = setup();
  const created = (await requestJson(app, "/api/api-keys", "POST", { name: "Assistant", scopes: ["read"] })).json.data;
  expect(created.key).toMatch(/^mst_[a-zA-Z0-9]{32}$/);
  const stored = services.db.row("SELECT * FROM api_keys WHERE id=?", created.id)!;
  expect(stored.hash).toBe(createHash("sha256").update(created.key).digest("hex")); expect(JSON.stringify(stored)).not.toContain(created.key);
  expect((await requestJson(app, "/api/api-keys")).json.data[0]).not.toHaveProperty("key");
  expect((await requestJson(app, "/api/api-keys")).json.data[0]).not.toHaveProperty("hash");
  expect(services.settings.authenticate(created.key)?.lastUsedAt).not.toBeNull();
  expect((await requestJson(app, `/api/api-keys/${created.id}`, "DELETE")).response.status).toBe(204);
  expect(services.settings.authenticate(created.key)).toBeNull();
  expect((await requestJson(app, "/api/api-keys", "POST", { name: "bad", scopes: ["admin"] })).response.status).toBe(400);
});
const mcpClient = (app: ReturnType<typeof createApp>["app"], path = "/api/mcp") => {
  const send = (token: string, method: string, params?: object) => requestJson(app, path, "POST", { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, token, { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" });
  const call = async (token: string, name: string, args: object = {}) => { const result = (await send(token, "tools/call", { name, arguments: args })).json.result; return { isError: result.isError === true, text: result.content[0].text as string, value: result.isError ? null : JSON.parse(result.content[0].text) }; };
  return { send, call };
};
it("authenticates external MCP on each request and filters the catalog and execution by scope", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app);
  const read = services.settings.createKey({ name: "reader", scopes: ["read"] }); const chief = services.settings.createKey({ name: "chief", scopes: ["chief"] });
  const { send, call } = mcpClient(app);
  expect((await send("bad", "tools/list")).response.status).toBe(401);
  expect((await app.request("/api/mcp", { method: "POST", headers: { authorization: read.key } })).status).toBe(401);
  expect((await send(read.key, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).response.status).toBe(200);
  const catalog = (await send(read.key, "tools/list")).json.result.tools;
  expect(catalog.map((t: { name: string }) => t.name).sort()).toEqual(["get_task", "get_task_log", "get_workspace", "list_agents", "list_skills", "list_tasks", "list_workspaces", "read_master_conversation"]);
  expect(catalog.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
  expect((await call(read.key, "create_task", { title: "Denied" })).isError).toBe(true);
  const chiefCatalog = (await send(chief.key, "tools/list")).json.result.tools.map((t: { name: string }) => t.name);
  for (const tool of ["assign_work", "create_task", "complete_task", "send_task_message"]) expect(chiefCatalog).toContain(tool);
  expect(chiefCatalog).not.toContain("create_agent");
  // With one workspace, workspaceId may be omitted.
  const created = await call(chief.key, "create_task", { title: "Allowed", spec: "Do it", agentId });
  expect(created.value).toMatchObject({ projectId, title: "Allowed", phase: "queued" });
  const [summary] = (await call(read.key, "list_workspaces")).value;
  expect(summary).toMatchObject({ id: projectId, masterAgent: { name: "Chief" }, taskCounts: { queued: 1 } });
  expect((await call(read.key, "get_task_log", { taskId: created.value.id })).value).toMatchObject({ task: { number: 1, phase: "queued" }, log: [] });
  const assigned = (await call(chief.key, "assign_work", { content: "Build a checkout page" })).value;
  expect(assigned).toMatchObject({ workspaceId: projectId, status: "queued" });
  expect(services.db.row("SELECT id FROM turns WHERE id=? AND kind='chief' AND status='queued'", assigned.turnId)).toBeDefined();
  expect((await call(read.key, "read_master_conversation")).value).toMatchObject({ masterActivity: "queued", messages: [{ role: "user", content: "Build a checkout page" }] });
  await requestJson(app, "/api/projects", "POST", { name: "Other", repoUrl: "/tmp/other" });
  expect((await call(chief.key, "create_task", { title: "Ambiguous" })).text).toContain("pass workspaceId");
  services.settings.revoke(read.id); expect((await send(read.key, "tools/list")).response.status).toBe(401);
  for (let i = 0; i < 20; i++) await send("bad", "tools/list");
  expect((await send("bad", "tools/list")).response.status).toBe(429);
  expect((await send(chief.key, "tools/list")).response.status).toBe(200);
});
it("confines a workspace MCP endpoint to its workspace and its master agent", async () => {
  const { app, services } = setup(); const { projectId, agentId } = await seedProjectAndAgent(app);
  const lead = (await requestJson(app, "/api/agents", "POST", { name: "Lead", role: "Lead", runtime: "mock", model: "mock" })).json.data;
  const other = (await requestJson(app, "/api/projects", "POST", { name: "Other", repoUrl: "/tmp/other", chiefAgentId: lead.id })).json.data;
  const outside = await createTodo(app, projectId, agentId, "Outside");
  const key = services.settings.createKey({ name: "partner", scopes: ["chief"] }).key;
  const { call } = mcpClient(app, `/api/mcp/workspaces/${other.id}`);
  expect((await mcpClient(app, "/api/mcp/workspaces/missing").send(key, "tools/list")).response.status).toBe(404);
  expect((await call(key, "list_workspaces")).value).toEqual([expect.objectContaining({ id: other.id, masterAgent: expect.objectContaining({ id: lead.id, name: "Lead" }) })]);
  expect((await call(key, "create_task", { title: "Inside", start: false })).value).toMatchObject({ projectId: other.id, phase: "todo" });
  expect((await call(key, "create_task", { workspaceId: projectId, title: "Escape" })).text).toContain("limited to its own workspace");
  expect((await call(key, "get_task", { taskId: outside })).text).toContain("another workspace");
  expect((await call(key, "list_tasks")).value.map((task: { title: string }) => task.title)).toEqual(["Inside"]);
  await call(key, "assign_work", { content: "Plan the release" });
  expect(services.db.rows("SELECT * FROM messages WHERE conversation_id=?", other.topicId).map((row) => row.content)).toEqual(["Plan the release"]);
  expect(services.db.rows("SELECT * FROM messages WHERE conversation_id=?", services.orchestrator.topicFor(projectId))).toEqual([]);
});
