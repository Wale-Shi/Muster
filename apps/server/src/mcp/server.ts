import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createAgentSchema, createSkillSchema, updateSkillSchema, githubSkillSchema, todoPhaseSchema, type Project, type Todo } from "@muster/shared";
import type { AppServices } from "../services.js";
import { id, now } from "../db/index.js";
import { createTask, postToChief } from "../workspaces.js";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: { result: value },
});
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text;

/**
 * Who is calling: a workspace's master agent, a coding agent working on a task,
 * or another AI with an API key. A master agent and a workspace-scoped key are
 * confined to their workspace; tools default to it.
 */
type Caller =
  | { kind: "chief"; agentId: string; turnId: string; topicId: string; projectId: string | null }
  | { kind: "agent"; agentId: string; turnId: string; projectId: string | null }
  | { kind: "external"; scope: "chief" | "read"; projectId: string | null };

function createMcpServer(services: AppServices, caller: Caller): McpServer {
  const { db, orchestrator } = services;
  const server = new McpServer({ name: "muster", version: "0.2.0" });
  const scoped = caller.kind === "chief" || (caller.kind === "external" && caller.projectId !== null);
  const canManage = caller.kind === "chief" || (caller.kind === "external" && caller.scope === "chief");
  const optionalWorkspace = { workspaceId: z.string().optional().describe(scoped ? "Defaults to this workspace" : "Required when there is more than one workspace") };

  const workspace = (workspaceId?: string): Project => {
    if (scoped && workspaceId && workspaceId !== caller.projectId) throw new Error("This endpoint is limited to its own workspace");
    let row = workspaceId ?? caller.projectId ? db.row("SELECT * FROM projects WHERE id=?", workspaceId ?? caller.projectId) : undefined;
    if (!row && !workspaceId && !caller.projectId) {
      const all = db.rows("SELECT * FROM projects ORDER BY created_at");
      if (all.length > 1) throw new Error("Several workspaces exist; pass workspaceId (see list_workspaces)");
      row = all[0];
    }
    if (!row) throw new Error("Workspace not found");
    return db.project(row);
  };
  const task = (taskId: string): Todo => {
    const todo = orchestrator.getTodo(taskId);
    if (scoped && todo.projectId !== caller.projectId) throw new Error("Task belongs to another workspace");
    return todo;
  };
  const summary = (project: Project) => {
    const counts = Object.fromEntries(db.rows("SELECT phase, count(*) AS count FROM todos WHERE project_id=? GROUP BY phase", project.id).map((r) => [String(r.phase), Number(r.count)]));
    const master = db.chiefFor(project.id);
    return { ...project, masterAgent: { id: master.id, name: master.name, runtime: master.runtime, model: master.model }, masterActivity: db.topic(db.row("SELECT * FROM topics WHERE id=?", project.topicId)!).activity, taskCounts: counts };
  };
  const listTasks = (projectId: string | null, phase?: string) => db.rows(`SELECT * FROM todos WHERE 1=1 ${projectId ? "AND project_id=?" : ""} ${phase ? "AND phase=?" : ""} ORDER BY number DESC`, ...[projectId, phase].filter((v) => v)).map((row) => db.todo(row));
  const read = { annotations: { readOnlyHint: true } };

  // Observing: every caller can see workspaces, tasks and how each task is going.
  server.registerTool("list_workspaces", { description: "List workspaces with their master agent and task counts by phase", ...read }, async () =>
    result((scoped ? [workspace()] : db.rows("SELECT * FROM projects ORDER BY created_at").map((row) => db.project(row))).map(summary)));
  server.registerTool("get_workspace", { description: "Get a workspace, its master agent and its tasks", ...read, inputSchema: optionalWorkspace }, async ({ workspaceId }) => {
    const project = workspace(workspaceId);
    return result({ ...summary(project), tasks: listTasks(project.id).map(({ id, number, title, phase, agentId, updatedAt }) => ({ id, number, title, phase, agentId, updatedAt })) });
  });
  server.registerTool("list_tasks", { description: "List tasks, newest first, optionally filtered by phase", ...read, inputSchema: { ...optionalWorkspace, phase: todoPhaseSchema.optional() } }, async ({ workspaceId, phase }) =>
    result(listTasks(scoped || workspaceId ? workspace(workspaceId).id : null, phase)));
  server.registerTool("get_task", { description: "Get a task with its runs and the latest diff of its changes", ...read, inputSchema: { taskId: z.string() } }, async ({ taskId }) => {
    const todo = task(taskId);
    const builds = db.rows("SELECT * FROM builds WHERE todo_id=? ORDER BY created_at", todo.id).map((row) => {
      const build = db.build(row);
      const changes = db.row("SELECT content, version FROM documents WHERE build_id=? AND kind='changes' ORDER BY version DESC LIMIT 1", build.id);
      return { ...build, turns: db.rows("SELECT * FROM turns WHERE build_id=? ORDER BY rowid", build.id).map((item) => { const { prompt: _prompt, ...turn } = db.turn(item); return turn; }), changes: changes ? { version: Number(changes.version), diff: clip(String(changes.content), 60_000) } : null };
    });
    return result({ ...todo, builds });
  });
  server.registerTool("get_task_log", { description: "Read the latest execution log of a task: agent messages, tool calls and system notices", ...read, inputSchema: { taskId: z.string(), limit: z.number().int().min(1).max(200).default(40) } }, async ({ taskId, limit }) => {
    const todo = task(taskId);
    const build = db.row("SELECT id FROM builds WHERE todo_id=? ORDER BY rowid DESC LIMIT 1", todo.id);
    const entries = build ? db.rows("SELECT * FROM (SELECT rowid AS position, * FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, position", build.id, limit).map((row) => db.message(row)) : [];
    return result({ task: { id: todo.id, number: todo.number, title: todo.title, phase: todo.phase }, log: entries.map((m) => ({ role: m.role, at: m.createdAt, content: clip(m.content, 4000), ...(m.role === "tool" && m.meta.tool ? { tool: m.meta.tool } : {}) })) });
  });
  server.registerTool("list_agents", { description: "List agents that can work on tasks", ...read }, async () => result(db.rows("SELECT * FROM agents ORDER BY is_chief DESC, created_at").map((row) => db.agent(row))));
  server.registerTool("list_skills", { description: "List the skills library", ...read }, async () => result(services.skills.list()));

  if (canManage) {
    server.registerTool("create_task", { description: "Create a task in a workspace. It starts right away unless start is false.", inputSchema: { ...optionalWorkspace, title: z.string().trim().min(1), spec: z.string().default(""), agentId: z.string().optional().describe("Coding agent; defaults to the first one"), start: z.boolean().default(true) } }, async ({ workspaceId, title, spec, agentId, start }) =>
      result(createTask(services, { projectId: workspace(workspaceId).id, title, spec, agentId: agentId ?? null, createdBy: caller.kind === "chief" ? "chief" : "user", start })));
    server.registerTool("start_task", { description: "Start a task waiting in the backlog", inputSchema: { taskId: z.string(), agentId: z.string().optional() } }, async ({ taskId, agentId }) => result({ turnId: orchestrator.start(task(taskId).id, agentId) }));
    server.registerTool("send_task_message", { description: "Steer a running task, or send review feedback so its agent revises the changes", inputSchema: { taskId: z.string(), content: z.string().min(1) } }, async ({ taskId, content }) => result(orchestrator.message(task(taskId).id, content)));
    server.registerTool("complete_task", { description: "Accept a task in review. With merge (default) its branch is merged into the base branch.", inputSchema: { taskId: z.string(), merge: z.boolean().default(true) } }, async ({ taskId, merge }) => result({ turnId: orchestrator.done(task(taskId).id, merge) }));
    server.registerTool("rerun_task", { description: "Rerun a failed task, continuing its worktree or restarting from a clean one", inputSchema: { taskId: z.string(), strategy: z.enum(["continue", "restart"]).default("continue") } }, async ({ taskId, strategy }) => result({ turnId: orchestrator.rerun(task(taskId).id, strategy) }));
    server.registerTool("stop_task", { description: "Stop a task's running or queued turn", inputSchema: { taskId: z.string() } }, async ({ taskId }) => { orchestrator.stop(task(taskId).id); return result({ stopRequested: true }); });
    server.registerTool("close_task", { description: "Close a task without merging", inputSchema: { taskId: z.string() } }, async ({ taskId }) => { orchestrator.close(task(taskId).id); return result(orchestrator.getTodo(taskId)); });
  }

  if (caller.kind === "external") {
    // Another AI hands work to a workspace's master agent and reads its replies.
    server.registerTool("read_master_conversation", { description: "Read the latest messages between the workspace's master agent and its users", ...read, inputSchema: { ...optionalWorkspace, limit: z.number().int().min(1).max(100).default(20) } }, async ({ workspaceId, limit }) => {
      const project = workspace(workspaceId);
      const messages = db.rows("SELECT * FROM (SELECT rowid AS position, * FROM messages WHERE conversation_id=? AND role IN ('user','agent','system') ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, position", project.topicId, limit).map((row) => db.message(row));
      return result({ masterActivity: db.topic(db.row("SELECT * FROM topics WHERE id=?", project.topicId)!).activity, messages: messages.map((m) => ({ role: m.role, at: m.createdAt, content: clip(m.content, 8000) })) });
    });
    if (caller.scope === "chief") server.registerTool("assign_work", { description: "Hand a goal or request to the workspace's master agent. It splits the work into tasks, runs and reviews them; follow progress with get_workspace and read_master_conversation.", inputSchema: { ...optionalWorkspace, content: z.string().min(1).max(100000) } }, async ({ workspaceId, content }) => {
      const project = workspace(workspaceId);
      return result({ workspaceId: project.id, turnId: postToChief(services, project.topicId, content), status: "queued" });
    });
    return server;
  }

  // Agent turns: skills, gated by the agent's own permissions.
  const profile = () => { const row = db.row("SELECT * FROM agents WHERE id=?", caller.agentId); if (!row) throw new Error("Agent not found"); return db.agent(row); };
  const requirePermission = (key: "createSkills" | "updateSkills") => { if (!profile().permissions?.[key]) throw new Error("Agent permission denied"); };
  server.registerTool("install_skill_from_github", { description: "Install a skill from a public GitHub folder", inputSchema: githubSkillSchema.shape }, async ({ url }) => { requirePermission("createSkills"); const skill = await services.skills.github(url); services.events.emit({ type: "skill.changed", payload: skill }); return result(skill); });
  server.registerTool("create_skill", { description: "Create a reusable skill", inputSchema: createSkillSchema.shape }, async (input) => { requirePermission("createSkills"); const skill = services.skills.create(input); services.events.emit({ type: "skill.changed", payload: skill }); return result(skill); });
  server.registerTool("update_skill", { description: "Update a skill", inputSchema: { slug: z.string(), ...updateSkillSchema.shape } }, async ({ slug, ...input }) => { requirePermission("updateSkills"); const skill = services.skills.update(slug, input); services.events.emit({ type: "skill.changed", payload: skill }); return result(skill); });

  if (caller.kind === "chief") {
    server.registerTool("create_agent", { description: "Create a coding agent", inputSchema: createAgentSchema.shape }, async (input) => {
      if (input.permissions && Object.values(input.permissions).some(Boolean)) throw new Error("Agent permissions must be granted by the user");
      if (input.defaultSkillIds?.some((id) => !db.row("SELECT id FROM skills WHERE id=?", id))) throw new Error("Skill not found");
      const agentId = id(); db.run("INSERT INTO agents (id,name,role,runtime,model,reasoning,avatar,is_chief,created_at,updated_at,permissions_json,default_skill_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', ?)", agentId, input.name, input.role, input.runtime, input.model, input.reasoning ?? null, input.avatar ?? null, now(), now(), JSON.stringify(input.defaultSkillIds ?? [])); const agent = db.agent(db.row("SELECT * FROM agents WHERE id=?", agentId)!); services.events.emit({ type: "agent.changed", payload: agent }); return result(agent);
    });
    server.registerTool("list_connections", { description: "List MCP connections without credentials", ...read }, async () => result(services.connections.list()));
    for (const action of ["grant", "revoke"] as const) server.registerTool(`${action}_connection`, { description: `${action === "grant" ? "Grant" : "Revoke"} an agent's access to a connection`, inputSchema: { agentId: z.string(), connectionId: z.string() } }, async ({ agentId, connectionId }) => { services.connections.grant(agentId, connectionId, action === "grant"); return result({ ok: true }); });
  }
  return server;
}

export async function handleMcp(request: Request, services: AppServices): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const assignment = token ? services.db.row(`SELECT b.todo_id, b.branch, t.id AS turn_id, t.agent_snapshot_json FROM mcp_tokens mt JOIN turns t ON t.id=mt.turn_id
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
      sessions.delete(savedToken); await Promise.all([...saved.values()].map((session) => session.server.close()));
    }
  }
  // A turn may connect more than once (ACP agents restart their MCP servers), so
  // each initialize gets its own session; later requests carry its session id.
  let byToken = sessions.get(token);
  if (!byToken) { byToken = new Map(); sessions.set(token, byToken); }
  const sessionId = request.headers.get("mcp-session-id");
  const existing = sessionId ? byToken.get(sessionId) : undefined;
  if (existing) return existing.transport.handleRequest(request);
  if (sessionId) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
  const sessionsForToken = byToken;
  const agentId = String(JSON.parse(String(assignment.agent_snapshot_json)).id); const turnId = String(assignment.turn_id);
  const topicId = assignment.todo_id ? null : String(assignment.branch).replace(/^chief:/, "");
  const projectId = (topicId ? services.db.row("SELECT project_id FROM topics WHERE id=?", topicId)?.project_id : services.db.row("SELECT project_id FROM todos WHERE id=?", assignment.todo_id)?.project_id) as string | null | undefined;
  const server = createMcpServer(services, topicId ? { kind: "chief", agentId, turnId, topicId, projectId: projectId ?? null } : { kind: "agent", agentId, turnId, projectId: projectId ?? null });
  const session = { server, transport: undefined as unknown as WebStandardStreamableHTTPServerTransport };
  session.transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (id) => {
    sessionsForToken.set(id, session);
    // Bound reconnect churn: drop the oldest session beyond a handful per turn.
    for (const [oldId, old] of sessionsForToken) { if (sessionsForToken.size <= MAX_SESSIONS_PER_TURN) break; sessionsForToken.delete(oldId); void old.server.close(); }
  } });
  await server.connect(session.transport);
  return session.transport.handleRequest(request);
}

const MAX_SESSIONS_PER_TURN = 8;
const sessionStores = new WeakMap<AppServices, Map<string, Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }>>>();

// Stateless external requests avoid long-lived sessions retaining revoked credentials.
const authFailures = new WeakMap<AppServices, { count: number; until: number }>();
export async function handleExternalMcp(request: Request, services: AppServices, workspaceId: string | null = null): Promise<Response> {
  const failure = authFailures.get(services);
  if (failure && failure.until <= Date.now()) authFailures.delete(services);
  const authorization = request.headers.get("authorization");
  const key = services.settings.authenticate(authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
  if (!key) {
    const current = authFailures.get(services) ?? { count: 0, until: Date.now() + 60_000 };
    current.count++; authFailures.set(services, current);
    return Response.json({ error: current.count > 20 ? "Too many authentication failures" : "Invalid API key" }, { status: current.count > 20 ? 429 : 401, headers: current.count > 20 ? { "Retry-After": String(Math.ceil((current.until - Date.now()) / 1000)) } : {} });
  }
  if (workspaceId && !services.db.row("SELECT id FROM projects WHERE id=?", workspaceId)) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const server = createMcpServer(services, { kind: "external", scope: key.scopes.includes("chief") ? "chief" : "read", projectId: workspaceId });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request); } finally { await server.close(); }
}
