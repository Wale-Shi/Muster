import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createAgentSchema, createTodoSchema, todoPhaseSchema } from "@muster/shared";
import type { AppServices } from "../services.js";
import { id, now } from "../db/index.js";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: { result: value },
});

function createMcpServer(services: AppServices, topicId: string | null): McpServer {
  const { db, orchestrator } = services;
  const server = new McpServer({ name: "muster", version: "0.1.0" });

  server.registerTool("list_projects", { description: "List Muster projects" }, async () => result(db.rows("SELECT * FROM projects ORDER BY created_at").map((row) => db.project(row))));
  server.registerTool("list_agents", { description: "List available agents" }, async () => result(db.rows("SELECT * FROM agents ORDER BY is_chief DESC, created_at").map((row) => db.agent(row))));
  server.registerTool("list_todos", { description: "List todos, optionally filtered by phase", inputSchema: { phase: todoPhaseSchema.optional() } }, async ({ phase }) => {
    const rows = phase ? db.rows("SELECT * FROM todos WHERE phase = ? ORDER BY number DESC", phase) : db.rows("SELECT * FROM todos ORDER BY number DESC");
    return result(rows.map((row) => db.todo(row)));
  });
  server.registerTool("get_todo", { description: "Get a todo and its builds, turns, and documents", inputSchema: { todoId: z.string() } }, async ({ todoId }) => {
    const todo = orchestrator.getTodo(todoId); const builds = db.rows("SELECT * FROM builds WHERE todo_id=? ORDER BY created_at", todoId).map((row) => { const build = db.build(row); return { ...build, turns: db.rows("SELECT * FROM turns WHERE build_id=? ORDER BY rowid", build.id).map((item) => db.turn(item)), documents: db.rows("SELECT * FROM documents WHERE build_id=? ORDER BY kind,version", build.id).map((item) => db.document(item)) }; });
    return result({ ...todo, builds });
  });
  server.registerTool("create_todo", {
    description: "Create a todo",
    inputSchema: createTodoSchema.omit({ createdBy: true }).shape,
  }, async (input) => {
    if (!db.row("SELECT id FROM projects WHERE id=?", input.projectId)) throw new Error("Project not found");
    const todoId = id(); const timestamp = now(); const number = Number((db.row("SELECT COALESCE(max(number),0)+1 number FROM todos") ?? {}).number ?? 1);
    db.run("INSERT INTO todos VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, 'chief', ?, NULL, ?, ?, NULL)", todoId, number, input.projectId, input.title, input.spec, input.agentId ?? null, input.planAgentId ?? null, input.mode, JSON.stringify(input.tags), input.topicId ?? topicId, timestamp, timestamp);
    const todo = orchestrator.getTodo(todoId); services.events.emit({ type: "todo.created", todoId, payload: todo }); return result(todo);
  });
  server.registerTool("start_todo", { description: "Start a todo in plan-first or run-now mode", inputSchema: { todoId: z.string(), mode: z.enum(["plan", "run"]), agentId: z.string().optional() } }, async ({ todoId, mode, agentId }) => result({ turnId: orchestrator.start(todoId, mode, agentId) }));
  server.registerTool("send_todo_message", { description: "Send feedback to or steer a todo", inputSchema: { todoId: z.string(), content: z.string().min(1) } }, async ({ todoId, content }) => result(orchestrator.message(todoId, content)));
  server.registerTool("confirm_plan", { description: "Confirm a todo plan and queue its build", inputSchema: { todoId: z.string() } }, async ({ todoId }) => result({ turnId: orchestrator.confirm(todoId) }));
  server.registerTool("complete_todo", { description: "Accept a reviewed todo, optionally merging it", inputSchema: { todoId: z.string(), merge: z.boolean().default(true) } }, async ({ todoId, merge }) => result({ turnId: orchestrator.done(todoId, merge) }));
  server.registerTool("close_todo", { description: "Close a todo", inputSchema: { todoId: z.string() } }, async ({ todoId }) => { orchestrator.close(todoId); return result(orchestrator.getTodo(todoId)); });
  server.registerTool("create_agent", { description: "Create a coding agent", inputSchema: createAgentSchema.shape }, async (input) => {
    const agentId = id(); db.run("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)", agentId, input.name, input.role, input.runtime, input.model, input.reasoning ?? null, input.avatar ?? null, now()); const agent = db.agent(db.row("SELECT * FROM agents WHERE id=?", agentId)!); services.events.emit({ type: "agent.changed", payload: agent }); return result(agent);
  });
  return server;
}

export async function handleMcp(request: Request, services: AppServices): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const assignment = token ? services.db.row(`SELECT b.todo_id, b.branch FROM mcp_tokens mt JOIN turns t ON t.id=mt.turn_id
    JOIN builds b ON b.id=t.build_id JOIN machines m ON m.id=t.machine_id
    WHERE mt.token=? AND t.status='running' AND t.stop_requested=0 AND m.last_seen_at>=? AND t.last_reported_at>=?`, token,
    new Date(Date.now()-30_000).toISOString(), new Date(Date.now()-30_000).toISOString()) : undefined;
  if (!token || !assignment) {
    return Response.json({ error: "Invalid or expired turn token" }, { status: 401 });
  }
  let sessions = sessionStores.get(services);
  if (!sessions) { sessions = new Map(); sessionStores.set(services, sessions); }
  for (const [savedToken, saved] of sessions) {
    if (!services.db.row("SELECT mt.token FROM mcp_tokens mt JOIN turns t ON t.id=mt.turn_id WHERE mt.token=? AND t.status='running' AND t.stop_requested=0", savedToken)) {
      sessions.delete(savedToken); await saved.server.close();
    }
  }
  let session = sessions.get(token);
  if (!session) {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID() });
    const server = createMcpServer(services, assignment.todo_id ? null : String(assignment.branch).replace(/^chief:/, ""));
    await server.connect(transport);
    session = { server, transport };
    sessions.set(token, session);
  }
  return session.transport.handleRequest(request);
}

const sessionStores = new WeakMap<AppServices, Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }>>();
