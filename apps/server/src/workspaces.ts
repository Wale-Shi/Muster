import type { CreateProjectInput, CreateTodoInput, Project, Todo } from "@muster/shared";
import { id, now } from "./db/index.js";
import { StateError } from "./orchestrator/state.js";
import type { AppServices } from "./services.js";

// Shared by the REST API and MCP tools, so every entry point creates the same records.

export function createWorkspace({ db, events }: AppServices, input: CreateProjectInput): Project {
  const projectId = id(); const timestamp = now();
  db.transaction(() => {
    db.run("INSERT INTO projects (id,name,repo_url,base_branch,created_at,description,chief_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)", projectId, input.name, input.repoUrl, input.baseBranch, timestamp, input.description ?? "", input.chiefAgentId ?? null);
    db.run("INSERT INTO topics (id,title,runtime_session_json,created_at,updated_at,project_id) VALUES (?, ?, NULL, ?, ?, ?)", id(), input.name, timestamp, timestamp, projectId);
  });
  const project = db.project(db.row("SELECT * FROM projects WHERE id = ?", projectId)!);
  events.emit({ type: "project.changed", payload: project });
  return project;
}

export function createTask({ db, events, orchestrator }: AppServices, input: CreateTodoInput): Todo {
  if (!db.row("SELECT id FROM projects WHERE id = ?", input.projectId)) throw new StateError("Workspace not found", 422);
  if (input.agentId && !db.row("SELECT id FROM agents WHERE id = ?", input.agentId)) throw new StateError("Agent not found", 422);
  const todoId = id(); const timestamp = now();
  const number = Number(db.row("SELECT COALESCE(max(number), 0) + 1 AS number FROM todos")?.number ?? 1);
  db.run("INSERT INTO todos (id,number,project_id,title,spec,phase,agent_id,plan_agent_id,mode,tags_json,created_by,topic_id,previous_gate,created_at,updated_at,done_at) VALUES (?, ?, ?, ?, ?, 'todo', ?, NULL, 'run', '[]', ?, ?, NULL, ?, ?, NULL)",
    todoId, number, input.projectId, input.title, input.spec, input.agentId ?? null, input.createdBy, orchestrator.topicFor(input.projectId), timestamp, timestamp);
  events.emit({ type: "todo.created", todoId, payload: orchestrator.getTodo(todoId) });
  if (input.start) orchestrator.start(todoId);
  return orchestrator.getTodo(todoId);
}

/** Post a message to a workspace's master agent and queue its turn. */
export function postToChief({ db, orchestrator }: AppServices, topicId: string, content: string): string {
  if (!db.row("SELECT id FROM topics WHERE id=?", topicId)) throw new StateError("Topic not found", 404);
  orchestrator.addMessage(topicId, null, "user", content, {});
  db.run("UPDATE topics SET updated_at=? WHERE id=?", now(), topicId);
  return orchestrator.enqueueChief(topicId, content);
}
