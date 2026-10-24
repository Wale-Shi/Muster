import { activePhaseForTurn, completedPhaseForTurn, type Agent, type Todo, type TurnKind } from "@muster/shared";
import { EventBus } from "../events.js";
import { id, MusterDb, now } from "../db/index.js";
import { buildPrompt } from "./prompts.js";

export class StateError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export class Orchestrator {
  constructor(readonly db: MusterDb, readonly events: EventBus, readonly publicUrl: string, readonly autoFollowUp = true) {}

  getTodo(todoId: string): Todo {
    const row = this.db.row("SELECT * FROM todos WHERE id = ?", todoId);
    if (!row) throw new StateError("Todo not found", 404);
    return this.db.todo(row);
  }

  private getAgent(agentId: string | null, kind: TurnKind): Agent {
    let row = agentId ? this.db.row("SELECT * FROM agents WHERE id = ?", agentId) : undefined;
    if (!row && kind === "chief") row = this.db.row("SELECT * FROM agents WHERE is_chief = 1 LIMIT 1");
    if (!row) row = this.db.row("SELECT * FROM agents WHERE is_chief = 0 ORDER BY created_at LIMIT 1");
    if (!row) row = this.db.row("SELECT * FROM agents ORDER BY is_chief DESC LIMIT 1");
    if (!row) throw new StateError("No agent available", 422);
    return this.db.agent(row);
  }

  private createBuild(todoId: string): string {
    const buildId = id();
    this.db.run("INSERT INTO builds VALUES (?, ?, ?, NULL, 'active', NULL, NULL, 0, 0, 0, ?)", buildId, todoId, `muster/conv-${buildId}`, now());
    return buildId;
  }

  private activeBuild(todoId: string): string {
    const row = this.db.row("SELECT id FROM builds WHERE todo_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", todoId);
    return row ? String(row.id) : this.createBuild(todoId);
  }

  private enqueue(todo: Todo, kind: TurnKind, feedback?: string, newBuild = false): string {
    if (newBuild) this.db.run("UPDATE builds SET status = 'failed' WHERE todo_id = ? AND status = 'active'", todo.id);
    const buildId = newBuild ? this.createBuild(todo.id) : this.activeBuild(todo.id);
    const usePlanAgent = kind === "plan" || (kind === "revise" && todo.previousGate === "confirm");
    const selectedAgent = usePlanAgent ? (todo.planAgentId ?? todo.agentId) : todo.agentId;
    const agent = this.getAgent(selectedAgent, kind);
    if (!selectedAgent) this.db.run(`UPDATE todos SET ${usePlanAgent ? "plan_agent_id" : "agent_id"} = ? WHERE id = ?`, agent.id, todo.id);
    const turnId = id();
    const prompt = buildPrompt(kind, todo, agent, feedback).prompt;
    this.db.run("INSERT INTO turns (id, build_id, kind, status, prompt, tokens_in, tokens_out) VALUES (?, ?, ?, 'queued', ?, 0, 0)", turnId, buildId, kind, prompt);
    this.db.run("UPDATE todos SET phase = 'queued', updated_at = ? WHERE id = ?", now(), todo.id);
    this.changed(todo.id, buildId, "turn.queued", { turnId, kind });
    return turnId;
  }

  start(todoId: string, mode: "plan" | "run", agentId?: string): string {
    const todo = this.getTodo(todoId);
    if (todo.phase !== "todo") throw new StateError(`Cannot start todo from ${todo.phase}`);
    if (agentId) this.db.run("UPDATE todos SET agent_id = ?, mode = ? WHERE id = ?", agentId, mode, todoId);
    else this.db.run("UPDATE todos SET mode = ? WHERE id = ?", mode, todoId);
    return this.enqueue(this.getTodo(todoId), mode === "plan" ? "plan" : "build");
  }

  confirm(todoId: string): string {
    const todo = this.getTodo(todoId);
    if (todo.phase !== "confirm") throw new StateError(`Cannot confirm todo from ${todo.phase}`);
    this.db.run("UPDATE todos SET previous_gate = 'confirm' WHERE id = ?", todoId);
    return this.enqueue(this.getTodo(todoId), "build");
  }

  message(todoId: string, content: string): { queued: boolean; turnId?: string } {
    const todo = this.getTodo(todoId);
    const buildId = this.activeBuild(todoId);
    this.addMessage(buildId, null, "user", content, {});
    const running = this.db.row("SELECT id FROM turns WHERE build_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1", buildId);
    if (running) {
      this.db.run("INSERT INTO queued_messages VALUES (?, ?, ?, NULL, ?)", id(), buildId, content, now());
      this.changed(todoId, buildId, "message.queued", { content });
      return { queued: true };
    }
    if (todo.phase === "confirm" || todo.phase === "review") {
      this.db.run("UPDATE todos SET previous_gate = ? WHERE id = ?", todo.phase, todoId);
      return { queued: false, turnId: this.enqueue(this.getTodo(todoId), "revise", content) };
    }
    throw new StateError(`Messages can only steer a running turn or revise at a gate (current: ${todo.phase})`);
  }

  done(todoId: string, merge: boolean): string | null {
    const todo = this.getTodo(todoId);
    if (todo.phase !== "review") throw new StateError(`Cannot complete todo from ${todo.phase}`);
    if (merge) {
      this.db.run("UPDATE todos SET previous_gate = 'review' WHERE id = ?", todoId);
      return this.enqueue(this.getTodo(todoId), "merge");
    }
    this.setPhase(todo, "done");
    this.db.run("UPDATE builds SET status = 'done' WHERE todo_id = ? AND status = 'active'", todoId);
    return null;
  }

  close(todoId: string): void {
    const todo = this.getTodo(todoId);
    const prior = todo.phase === "confirm" || todo.phase === "review" ? todo.phase : todo.previousGate;
    this.db.run("UPDATE todos SET phase = 'closed', previous_gate = ?, updated_at = ? WHERE id = ?", prior, now(), todoId);
    this.db.run("UPDATE turns SET stop_requested = 1 WHERE build_id IN (SELECT id FROM builds WHERE todo_id = ?) AND status = 'running'", todoId);
    this.db.run("UPDATE turns SET status = 'stopped', ended_at = ?, error = 'Todo closed' WHERE build_id IN (SELECT id FROM builds WHERE todo_id = ?) AND status = 'queued'", now(), todoId);
    this.db.run("UPDATE builds SET status = 'closed' WHERE todo_id = ? AND status = 'active'", todoId);
    this.changed(todoId, null, "todo.changed", { phase: "closed" });
  }

  reopen(todoId: string): void {
    const todo = this.getTodo(todoId);
    if (todo.phase !== "done" && todo.phase !== "closed") throw new StateError(`Cannot reopen todo from ${todo.phase}`);
    const phase = todo.phase === "done" ? "review" : (todo.previousGate ?? "todo");
    this.db.run("UPDATE todos SET phase = ?, done_at = NULL, updated_at = ? WHERE id = ?", phase, now(), todoId);
    this.db.run("UPDATE builds SET status = 'active' WHERE id = (SELECT id FROM builds WHERE todo_id = ? ORDER BY created_at DESC LIMIT 1)", todoId);
    this.changed(todoId, null, "todo.changed", { phase });
  }

  rerun(todoId: string, strategy: "continue" | "restart"): string {
    const todo = this.getTodo(todoId);
    if (todo.phase !== "failed") throw new StateError(`Cannot rerun todo from ${todo.phase}`);
    const last = this.db.row("SELECT kind FROM turns WHERE build_id IN (SELECT id FROM builds WHERE todo_id = ?) ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 1", todoId);
    let kind = (last?.kind ?? (todo.mode === "plan" ? "plan" : "build")) as TurnKind;
    if (kind === "merge") kind = "merge";
    return this.enqueue(todo, kind, strategy === "restart" ? "Restart from a clean worktree." : "Continue from the previous attempt.", strategy === "restart");
  }

  stop(todoId: string): void {
    this.getTodo(todoId);
    const result = this.db.row("SELECT id FROM turns WHERE build_id IN (SELECT id FROM builds WHERE todo_id = ?) AND status = 'running' LIMIT 1", todoId);
    if (!result) throw new StateError("Todo has no running turn");
    this.db.run("UPDATE turns SET stop_requested = 1 WHERE id = ?", result.id);
    this.changed(todoId, null, "turn.stop_requested", { turnId: result.id });
  }

  enqueueChief(topicId: string, prompt: string): string {
    const topic = this.db.row("SELECT * FROM topics WHERE id = ?", topicId);
    if (!topic) throw new StateError("Topic not found", 404);
    const agent = this.getAgent(null, "chief");
    let build = this.db.row("SELECT id FROM builds WHERE todo_id IS NULL AND branch = ? LIMIT 1", `chief:${topicId}`);
    if (!build) {
      const buildId = id();
      this.db.run("INSERT INTO builds VALUES (?, NULL, ?, NULL, 'active', NULL, NULL, 0, 0, 0, ?)", buildId, `chief:${topicId}`, now());
      build = { id: buildId };
    }
    const turnId = id();
    this.db.run("INSERT INTO turns (id, build_id, kind, status, prompt, tokens_in, tokens_out) VALUES (?, ?, 'chief', 'queued', ?, 0, 0)", turnId, build.id, buildPrompt("chief", null, agent, prompt).prompt);
    this.changed(null, topicId, "turn.queued", { turnId, kind: "chief" });
    return turnId;
  }

  setPhase(todo: Todo, phase: Todo["phase"]): void {
    const doneAt = phase === "done" ? now() : null;
    const previousGate = phase === "confirm" || phase === "review" ? phase : todo.previousGate;
    this.db.run("UPDATE todos SET phase = ?, previous_gate = ?, updated_at = ?, done_at = ? WHERE id = ?", phase, previousGate, now(), doneAt, todo.id);
    this.changed(todo.id, null, "todo.changed", { phase });
    if (["confirm", "review", "failed", "done"].includes(phase)) this.notifyChief(this.getTodo(todo.id), phase);
  }

  private notifyChief(todo: Todo, phase: Todo["phase"]): void {
    const topicRow = todo.topicId ? this.db.row("SELECT id FROM topics WHERE id = ?", todo.topicId) : this.db.row("SELECT id FROM topics ORDER BY created_at LIMIT 1");
    if (!topicRow) return;
    const topicId = String(topicRow.id);
    const content = `Todo #${todo.number} ${todo.title} entered ${phase}.`;
    this.addMessage(topicId, null, "system", content, { todoId: todo.id, phase });
    if (this.autoFollowUp && todo.createdBy === "chief") this.enqueueChief(topicId, content);
  }

  addMessage(conversationId: string, turnId: string | null, role: "user" | "agent" | "system" | "tool", content: string, meta: Record<string, unknown>): string {
    const messageId = id();
    this.db.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)", messageId, conversationId, turnId, role, content, JSON.stringify(meta), now());
    this.changed(null, conversationId, "message.created", { id: messageId, role, content, meta });
    return messageId;
  }

  completeTurn(turnId: string, status: "done" | "failed" | "stopped", error?: string): void {
    const row = this.db.row("SELECT t.*, b.todo_id FROM turns t JOIN builds b ON b.id = t.build_id WHERE t.id = ?", turnId);
    if (!row) throw new StateError("Turn not found", 404);
    this.db.run("UPDATE turns SET status = ?, ended_at = ?, error = ? WHERE id = ?", status, now(), error ?? null, turnId);
    if (!row.todo_id) return;
    const todo = this.getTodo(String(row.todo_id));
    if (todo.phase === "closed") return;
    if (status !== "done") { this.setPhase(todo, "failed"); return; }
    const next = completedPhaseForTurn(row.kind as TurnKind, todo.previousGate);
    if (next) this.setPhase(todo, next);
    if (next === "done") this.db.run("UPDATE builds SET status = 'done' WHERE id = ?", row.build_id);
  }

  changed(todoId: string | null, conversationId: string | null, type: string, payload: unknown): void {
    this.events.emit({ type, ...(todoId ? { todoId } : {}), ...(conversationId ? { conversationId } : {}), payload });
  }

  phaseForClaim(turnId: string): void {
    const row = this.db.row("SELECT t.kind, b.todo_id FROM turns t JOIN builds b ON b.id = t.build_id WHERE t.id = ?", turnId);
    if (!row?.todo_id) return;
    const todo = this.getTodo(String(row.todo_id));
    const phase = activePhaseForTurn(row.kind as TurnKind, todo.previousGate);
    if (phase) this.setPhase(todo, phase);
  }
}
