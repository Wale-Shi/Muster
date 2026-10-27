import { parityRoutes } from "./parity.js";
import { StateError } from "../orchestrator/state.js";
import { resourceRoutes } from "./resources.js";
import { Hono } from "hono";
import {
  createAgentSchema, createProjectSchema, createTodoSchema, createTopicSchema, doneTodoSchema,
  idSchema, rerunTodoSchema, startTodoSchema, todoMessageSchema, todoPhaseSchema, topicMessageSchema,
  updateAgentSchema, updateMachineSchema, updateProjectSchema, updateTodoSchema, updateTopicSchema,
} from "@muster/shared";
import type { AppServices } from "../services.js";
import { id, now } from "../db/index.js";
import { queueRoutes } from "./queue.js";
import { usageReport } from "./usage.js";
import { body } from "./helpers.js";

export function apiRoutes(services: AppServices): Hono {
  const app = new Hono();
  const { db, orchestrator, events } = services;
  const validateSkillIds = (ids?: string[]) => { if (ids?.some((id) => !db.row("SELECT id FROM skills WHERE id=?", id))) throw new StateError("Skill not found", 400); };

  app.get("/projects", (c) => c.json({ data: db.rows("SELECT * FROM projects ORDER BY created_at").map((row) => db.project(row)) }));
  app.post("/projects", async (c) => {
    const input = await body(c, createProjectSchema); const projectId = id();
    db.run("INSERT INTO projects (id,name,repo_url,base_branch,created_at) VALUES (?, ?, ?, ?, ?)", projectId, input.name, input.repoUrl, input.baseBranch, now());
    if (input.description !== undefined) db.run("UPDATE projects SET description=? WHERE id=?", input.description, projectId);
    const project = db.project(db.row("SELECT * FROM projects WHERE id = ?", projectId)!);
    events.emit({ type: "project.changed", payload: project }); return c.json({ data: project }, 201);
  });
  app.get("/projects/:id", (c) => {
    const row = db.row("SELECT * FROM projects WHERE id = ?", c.req.param("id"));
    return row ? c.json({ data: db.project(row) }) : c.json({ error: "Project not found" }, 404);
  });
  app.patch("/projects/:id", async (c) => {
    const input = await body(c, updateProjectSchema); const projectId = c.req.param("id");
    const current = db.row("SELECT * FROM projects WHERE id = ?", projectId); if (!current) return c.json({ error: "Project not found" }, 404);
    db.run("UPDATE projects SET name = ?, repo_url = ?, base_branch = ? WHERE id = ?", input.name ?? current.name, input.repoUrl ?? current.repo_url, input.baseBranch ?? current.base_branch, projectId);
    if (input.description !== undefined) db.run("UPDATE projects SET description=? WHERE id=?", input.description, projectId);
    const project = db.project(db.row("SELECT * FROM projects WHERE id = ?", projectId)!); events.emit({ type: "project.changed", payload: project }); return c.json({ data: project });
  });
  app.delete("/projects/:id", (c) => {
    const projectId = c.req.param("id"); const current = db.row("SELECT id FROM projects WHERE id = ?", projectId); if (!current) return c.json({ error: "Project not found" }, 404);
    db.run("DELETE FROM projects WHERE id = ?", projectId); events.emit({ type: "project.deleted", payload: { id: projectId } }); return c.body(null, 204);
  });

  app.route("/", resourceRoutes(services));
  app.route("/", parityRoutes(services));

  app.get("/agents", (c) => c.json({ data: db.rows("SELECT * FROM agents ORDER BY is_chief DESC, created_at").map((row) => db.agent(row)) }));
  app.post("/agents", async (c) => {
    const input = await body(c, createAgentSchema); validateSkillIds(input.defaultSkillIds); if (input.connectionIds?.some((id) => !db.row("SELECT id FROM connections WHERE id=?", id))) throw new StateError("Connection not found", 400); const agentId = id();
    db.run("INSERT INTO agents (id,name,role,runtime,model,reasoning,avatar,is_chief,created_at,updated_at,permissions_json,default_skill_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)", agentId, input.name, input.role, input.runtime, input.model, input.reasoning ?? null, input.avatar ?? null, now(), now(), JSON.stringify(input.permissions ?? {}), JSON.stringify(input.defaultSkillIds ?? []));
    if (input.connectionIds) db.run("UPDATE agents SET connection_ids_json=? WHERE id=?", JSON.stringify(input.connectionIds), agentId);
    const agent = db.agent(db.row("SELECT * FROM agents WHERE id = ?", agentId)!); events.emit({ type: "agent.changed", payload: agent }); return c.json({ data: agent }, 201);
  });
  app.get("/agents/:id", (c) => { const row = db.row("SELECT * FROM agents WHERE id = ?", c.req.param("id")); return row ? c.json({ data: { ...db.agent(row), inProgress: db.rows("SELECT * FROM todos WHERE (agent_id=? OR plan_agent_id=?) AND phase NOT IN ('todo','done','closed') ORDER BY number DESC", row.id, row.id).map((r) => db.todo(r)), memoryCount: services.memories.list(String(row.id)).length, skillCount: db.agent(row).defaultSkillIds?.length ?? 0 } }) : c.json({ error: "Agent not found" }, 404); });
  app.patch("/agents/:id", async (c) => {
    const input = await body(c, updateAgentSchema); validateSkillIds(input.defaultSkillIds); if (input.connectionIds?.some((id) => !db.row("SELECT id FROM connections WHERE id=?", id))) throw new StateError("Connection not found", 400); const agentId = c.req.param("id"); const current = db.row("SELECT * FROM agents WHERE id = ?", agentId); if (!current) return c.json({ error: "Agent not found" }, 404);
    db.run("UPDATE agents SET name = ?, role = ?, runtime = ?, model = ?, reasoning = ?, avatar = ?, permissions_json = ?, default_skill_ids_json = ?, updated_at = ? WHERE id = ?", input.name ?? current.name, input.role ?? current.role, input.runtime ?? current.runtime, input.model ?? current.model, input.reasoning === undefined ? current.reasoning : input.reasoning, input.avatar === undefined ? current.avatar : input.avatar, input.permissions ? JSON.stringify(input.permissions) : current.permissions_json, input.defaultSkillIds ? JSON.stringify(input.defaultSkillIds) : current.default_skill_ids_json, now(), agentId);
    if (input.connectionIds) db.run("UPDATE agents SET connection_ids_json=? WHERE id=?", JSON.stringify(input.connectionIds), agentId);
    const agent = db.agent(db.row("SELECT * FROM agents WHERE id = ?", agentId)!); events.emit({ type: "agent.changed", payload: agent }); return c.json({ data: agent });
  });
  app.delete("/agents/:id", (c) => {
    const agentId = c.req.param("id"); const current = db.row("SELECT is_chief FROM agents WHERE id = ?", agentId); if (!current) return c.json({ error: "Agent not found" }, 404); if (current.is_chief === 1) return c.json({ error: "Chief cannot be deleted" }, 409);
    if (db.row("SELECT t.id FROM turns t JOIN builds b ON b.id=t.build_id JOIN todos td ON td.id=b.todo_id WHERE t.status IN ('queued','running') AND (td.agent_id=? OR td.plan_agent_id=? OR json_extract(t.agent_snapshot_json,'$.id')=?)", agentId, agentId, agentId)) return c.json({ error: "Agent has running work" }, 409);
    db.transaction(() => { db.run("UPDATE todos SET agent_id=NULL WHERE agent_id=?", agentId); db.run("UPDATE todos SET plan_agent_id=NULL WHERE plan_agent_id=?", agentId); db.run("DELETE FROM agents WHERE id = ?", agentId); }); events.emit({ type: "agent.deleted", payload: { id: agentId } }); return c.body(null, 204);
  });

  app.get("/machines", (c) => {
    services.scheduler.failOfflineMachines(); const cutoff = Date.now() - 30_000;
    const data = db.rows(`SELECT m.*, (SELECT count(*) FROM turns t WHERE t.machine_id=m.id AND t.status='running') AS running FROM machines m ORDER BY created_at`).map((row) => ({ ...db.machine(row), online: typeof row.last_seen_at === "string" && Date.parse(row.last_seen_at) >= cutoff, running: Number(row.running) }));
    return c.json({ data });
  });
  // Ask every machine to list its runtimes' models again on its next heartbeat.
  app.post("/machines/refresh-models", (c) => { db.run("UPDATE machines SET models_requested = 1"); return c.json({ data: { requested: true } }, 202); });
  app.patch("/machines/:id", async (c) => { const input = await body(c, updateMachineSchema); const machineId = c.req.param("id"); if (!db.row("SELECT id FROM machines WHERE id = ?", machineId)) return c.json({ error: "Machine not found" }, 404); db.run("UPDATE machines SET concurrency = ? WHERE id = ?", input.concurrency, machineId); events.emit({ type: "machine.changed", payload: { machineId, ...input } }); return c.json({ data: db.machine(db.row("SELECT * FROM machines WHERE id = ?", machineId)!) }); });
  app.delete("/machines/:id", (c) => { const machineId = c.req.param("id"); if (!db.row("SELECT id FROM machines WHERE id = ?", machineId)) return c.json({ error: "Machine not found" }, 404); const running = db.row("SELECT count(*) AS count FROM turns WHERE machine_id = ? AND status = 'running'", machineId); if (Number(running?.count) > 0) return c.json({ error: "Machine has running turns" }, 409); db.transaction(() => { db.run("UPDATE turns SET machine_id = NULL WHERE machine_id = ?", machineId); db.run("UPDATE builds SET machine_id = NULL WHERE machine_id = ?", machineId); db.run("DELETE FROM machines WHERE id = ?", machineId); }); events.emit({ type: "machine.deleted", payload: { id: machineId } }); return c.body(null, 204); });

  app.get("/todos", (c) => {
    const clauses: string[] = []; const params: string[] = [];
    const phase = c.req.query("phase"); if (phase) { clauses.push("phase = ?"); params.push(todoPhaseSchema.parse(phase)); }
    for (const [query, column] of [["projectId", "project_id"], ["agentId", "agent_id"]] as const) { const value = c.req.query(query); if (value) { clauses.push(`${column} = ?`); params.push(idSchema.parse(value)); } }
    const tag = c.req.query("tag"); if (tag) { clauses.push("EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?)"); params.push(tag); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return c.json({ data: db.rows(`SELECT * FROM todos ${where} ORDER BY number DESC`, ...params).map((row) => db.todo(row)) });
  });
  app.post("/todos", async (c) => {
    const input = await body(c, createTodoSchema); if (!db.row("SELECT id FROM projects WHERE id = ?", input.projectId)) return c.json({ error: "Project not found" }, 422);
    const todoId = id(); const timestamp = now(); const number = Number((db.row("SELECT COALESCE(max(number), 0) + 1 AS number FROM todos") ?? {}).number ?? 1);
    db.run("INSERT INTO todos VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)", todoId, number, input.projectId, input.title, input.spec, input.agentId ?? null, input.planAgentId ?? null, input.mode, JSON.stringify(input.tags), input.createdBy, input.topicId ?? null, timestamp, timestamp);
    const todo = orchestrator.getTodo(todoId); events.emit({ type: "todo.created", todoId, payload: todo }); return c.json({ data: todo }, 201);
  });
  app.get("/todos/:id", (c) => {
    const row = db.row("SELECT * FROM todos WHERE id = ?", c.req.param("id")); if (!row) return c.json({ error: "Todo not found" }, 404); const todo = db.todo(row);
    const builds = db.rows("SELECT * FROM builds WHERE todo_id = ? ORDER BY created_at", todo.id).map((buildRow) => { const build = db.build(buildRow); return { ...build, turns: db.rows("SELECT * FROM turns WHERE build_id = ? ORDER BY rowid", build.id).map((turn) => db.turn(turn)), documents: db.rows("SELECT * FROM documents WHERE build_id = ? ORDER BY kind, version", build.id).map((document) => db.document(document)) }; });
    return c.json({ data: { ...todo, builds } });
  });
  app.patch("/todos/:id", async (c) => { const input = await body(c, updateTodoSchema); const todoId = c.req.param("id"); const current = db.row("SELECT * FROM todos WHERE id = ?", todoId); if (!current) return c.json({ error: "Todo not found" }, 404); db.run("UPDATE todos SET title=?, spec=?, agent_id=?, plan_agent_id=?, tags_json=?, updated_at=? WHERE id=?", input.title ?? current.title, input.spec ?? current.spec, input.agentId === undefined ? current.agent_id : input.agentId, input.planAgentId === undefined ? current.plan_agent_id : input.planAgentId, input.tags ? JSON.stringify(input.tags) : current.tags_json, now(), todoId); const todo = orchestrator.getTodo(todoId); events.emit({ type: "todo.changed", todoId, payload: todo }); return c.json({ data: todo }); });
  app.delete("/todos/:id", (c) => { try { orchestrator.close(c.req.param("id")); services.attachments.delete(c.req.param("id")); return c.body(null, 204); } catch (error) { throw error; } });

  app.post("/todos/:id/start", async (c) => { const input = await body(c, startTodoSchema); return c.json({ data: { turnId: orchestrator.start(c.req.param("id"), input.mode, input.agentId) } }, 202); });
  app.post("/todos/:id/confirm", (c) => c.json({ data: { turnId: orchestrator.confirm(c.req.param("id")) } }, 202));
  app.post("/todos/:id/message", async (c) => { const input = await body(c, todoMessageSchema); return c.json({ data: orchestrator.message(c.req.param("id"), input.content) }, 202); });
  app.post("/todos/:id/done", async (c) => { const input = await body(c, doneTodoSchema); return c.json({ data: { turnId: orchestrator.done(c.req.param("id"), input.merge) } }, input.merge ? 202 : 200); });
  app.post("/todos/:id/close", (c) => { orchestrator.close(c.req.param("id")); return c.json({ data: orchestrator.getTodo(c.req.param("id")) }); });
  app.post("/todos/:id/reopen", (c) => { orchestrator.reopen(c.req.param("id")); return c.json({ data: orchestrator.getTodo(c.req.param("id")) }); });
  app.post("/todos/:id/rerun", async (c) => { const input = await body(c, rerunTodoSchema); return c.json({ data: { turnId: orchestrator.rerun(c.req.param("id"), input.strategy) } }, 202); });
  app.post("/todos/:id/stop", (c) => { orchestrator.stop(c.req.param("id")); return c.json({ data: { stopRequested: true } }, 202); });

  app.get("/conversations/:id/messages", (c) => c.json({ data: db.rows("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", c.req.param("id")).map((row) => db.message(row)) }));
  app.get("/todos/:id/documents", (c) => c.json({ data: db.rows("SELECT d.* FROM documents d JOIN builds b ON b.id=d.build_id WHERE b.todo_id=? ORDER BY d.kind, d.version", c.req.param("id")).map((row) => db.document(row)) }));
  app.get("/todos/:id/documents/:kind/:version", (c) => { const row = db.row("SELECT d.* FROM documents d JOIN builds b ON b.id=d.build_id WHERE b.todo_id=? AND d.kind=? AND d.version=? ORDER BY b.created_at DESC LIMIT 1", c.req.param("id"), c.req.param("kind"), Number(c.req.param("version"))); return row ? c.json({ data: db.document(row) }) : c.json({ error: "Document not found" }, 404); });

  app.get("/topics", (c) => c.json({ data: db.rows("SELECT * FROM topics ORDER BY updated_at DESC").map((row) => db.topic(row)) }));
  app.post("/topics", async (c) => { const input = await body(c, createTopicSchema); const topicId = id(); const timestamp = now(); db.run("INSERT INTO topics VALUES (?, ?, NULL, ?, ?)", topicId, input.title, timestamp, timestamp); const topic = db.topic(db.row("SELECT * FROM topics WHERE id=?", topicId)!); events.emit({ type: "topic.changed", conversationId: topicId, payload: topic }); return c.json({ data: topic }, 201); });
  app.get("/topics/:id", (c) => { const row = db.row("SELECT * FROM topics WHERE id=?", c.req.param("id")); return row ? c.json({ data: db.topic(row) }) : c.json({ error: "Topic not found" }, 404); });
  app.patch("/topics/:id", async (c) => { const input = await body(c, updateTopicSchema); const row = db.row("SELECT * FROM topics WHERE id=?", c.req.param("id")); if (!row) return c.json({ error: "Topic not found" }, 404); db.run("UPDATE topics SET title=?, updated_at=? WHERE id=?", input.title ?? row.title, now(), row.id); const topic = db.topic(db.row("SELECT * FROM topics WHERE id=?", row.id)!); events.emit({ type: "topic.changed", conversationId: String(row.id), payload: topic }); return c.json({ data: topic }); });
  app.delete("/topics/:id", (c) => { const topicId = c.req.param("id"); if (!db.row("SELECT id FROM topics WHERE id=?", topicId)) return c.json({ error: "Topic not found" }, 404); if (db.row("SELECT id FROM builds WHERE branch=?", `chief:${topicId}`)) return c.json({ error: "Topic has conversation history" }, 409); db.run("DELETE FROM topics WHERE id=?", topicId); events.emit({ type: "topic.deleted", conversationId: topicId, payload: { id: topicId } }); return c.body(null, 204); });
  app.post("/topics/:id/messages", async (c) => { const input = await body(c, topicMessageSchema); const topicId = c.req.param("id"); if (!db.row("SELECT id FROM topics WHERE id=?", topicId)) return c.json({ error: "Topic not found" }, 404); orchestrator.addMessage(topicId, null, "user", input.content, {}); db.run("UPDATE topics SET updated_at=? WHERE id=?", now(), topicId); return c.json({ data: { turnId: orchestrator.enqueueChief(topicId, input.content) } }, 202); });

  app.route("/conversations", queueRoutes(services));
  app.get("/usage", (c) => c.json({ data: usageReport(db) }));

  return app;
}
