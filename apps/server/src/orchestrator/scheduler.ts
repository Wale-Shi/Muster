import type { AgentEvent, Runtime, TurnCompletePayload, TurnJob, TurnKind } from "@muster/shared";
import { id, MusterDb, now } from "../db/index.js";
import type { EventBus } from "../events.js";
import { instructionsFor } from "./prompts.js";
import { Orchestrator, StateError } from "./state.js";

type Row = Record<string, unknown>;

const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

export class Scheduler {
  constructor(readonly db: MusterDb, readonly orchestrator: Orchestrator, readonly events: EventBus) {}

  enroll(name: string, runtimes: Runtime[], concurrency: number): { machineId: string; token: string } {
    const machineId = id();
    const token = `mst_machine_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = now();
    this.db.run("INSERT INTO machines VALUES (?, ?, ?, ?, ?, ?, ?)", machineId, name, token, concurrency, JSON.stringify(runtimes), timestamp, timestamp);
    this.events.emit({ type: "machine.changed", payload: { machineId } });
    return { machineId, token };
  }

  authenticate(token: string): Row {
    const machine = this.db.row("SELECT * FROM machines WHERE token = ?", token);
    if (!machine) throw new StateError("Invalid machine token", 401);
    return machine;
  }

  heartbeat(token: string, running: string[]): { stop: string[] } {
    const machine = this.authenticate(token);
    this.db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", now(), machine.id);
    const stop = running.filter((turnId) => {
      const row = this.db.row("SELECT stop_requested, machine_id, status FROM turns WHERE id = ?", turnId);
      return !row || row.machine_id !== machine.id || row.status !== "running" || row.stop_requested === 1;
    });
    this.failOfflineMachines();
    return { stop };
  }

  failOfflineMachines(): void {
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const turns = this.db.rows(`SELECT t.id FROM turns t JOIN machines m ON m.id = t.machine_id WHERE t.status = 'running' AND (m.last_seen_at IS NULL OR m.last_seen_at < ?)`, cutoff);
    for (const turn of turns) this.orchestrator.completeTurn(String(turn.id), "failed", "Machine went offline: no heartbeat for 30 seconds.");
  }

  claim(token: string): TurnJob | null {
    const machine = this.authenticate(token);
    this.failOfflineMachines();
    const running = Number((this.db.row("SELECT count(*) AS count FROM turns WHERE machine_id = ? AND status = 'running'", machine.id) ?? {}).count ?? 0);
    if (running >= Number(machine.concurrency)) return null;
    const runtimes = parseJson<Runtime[]>(machine.runtimes_json, []);

    return this.db.transaction(() => {
      const candidates = this.db.rows(`
        SELECT t.*, b.todo_id, b.branch, b.id AS actual_build_id,
               td.project_id, td.agent_id, td.plan_agent_id, td.previous_gate,
               p.repo_url, p.base_branch,
               a.id AS selected_agent_id, a.runtime, a.model, a.reasoning, a.role,
               chief.id AS chief_agent_id, chief.runtime AS chief_runtime, chief.model AS chief_model,
               chief.reasoning AS chief_reasoning, chief.role AS chief_role
        FROM turns t
        JOIN builds b ON b.id = t.build_id
        LEFT JOIN todos td ON td.id = b.todo_id
        LEFT JOIN projects p ON p.id = td.project_id
        LEFT JOIN agents a ON a.id = CASE WHEN t.kind = 'plan' OR (t.kind = 'revise' AND td.previous_gate = 'confirm') THEN COALESCE(td.plan_agent_id, td.agent_id) ELSE td.agent_id END
        LEFT JOIN agents chief ON chief.is_chief = 1
        WHERE t.status = 'queued' AND b.status = 'active'
        ORDER BY t.rowid
      `);
      const candidate = candidates.find((row) => runtimes.includes((row.todo_id ? row.runtime : row.chief_runtime) as Runtime));
      if (!candidate) return null;

      const changed = this.db.raw.prepare("UPDATE turns SET status = 'running', machine_id = ?, started_at = ? WHERE id = ? AND status = 'queued'").run(machine.id as string, now(), candidate.id as string);
      if (changed.changes !== 1) return null;
      this.db.run("UPDATE builds SET machine_id = ? WHERE id = ?", machine.id, candidate.actual_build_id);
      this.orchestrator.phaseForClaim(String(candidate.id));

      const mcpToken = `mst_turn_${crypto.randomUUID().replaceAll("-", "")}`;
      this.db.run("INSERT INTO mcp_tokens VALUES (?, ?, ?)", mcpToken, candidate.id, now());
      const isChief = !candidate.todo_id;
      const agent = {
        runtime: (isChief ? candidate.chief_runtime : candidate.runtime) as Runtime,
        model: String(isChief ? candidate.chief_model : candidate.model),
        reasoning: (isChief ? candidate.chief_reasoning : candidate.reasoning) as string | null,
        role: String(isChief ? candidate.chief_role : candidate.role),
      };
      const project = isChief ? null : { id: String(candidate.project_id), repoUrl: String(candidate.repo_url), baseBranch: String(candidate.base_branch) };
      const previous = this.db.row("SELECT session_state_json, kind FROM turns WHERE build_id = ? AND session_state_json IS NOT NULL AND id <> ? ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 1", candidate.actual_build_id, candidate.id);
      const previousUsedPlanAgent = previous?.kind === "plan" || (previous?.kind === "revise" && candidate.previous_gate === "confirm");
      const previousAgentId = previousUsedPlanAgent ? (candidate.plan_agent_id ?? candidate.agent_id) : candidate.agent_id;
      const canResume = isChief || previousAgentId === candidate.selected_agent_id;
      const job: TurnJob = {
        turnId: String(candidate.id), buildId: String(candidate.actual_build_id), todoId: candidate.todo_id as string | null,
        kind: candidate.kind as TurnKind, project, branch: isChief ? null : String(candidate.branch),
        agent, prompt: String(candidate.prompt), systemInstructions: instructionsFor(candidate.kind as TurnKind, { id: isChief ? String(candidate.chief_agent_id) : String(candidate.selected_agent_id), name: "", isChief, createdAt: "", avatar: null, ...agent }),
        sessionState: canResume ? parseJson(previous?.session_state_json, null) : null, readOnly: candidate.kind === "plan" || (candidate.kind === "revise" && candidate.previous_gate === "confirm"),
        mcp: { url: `${this.orchestrator.publicUrl}/mcp`, token: mcpToken },
      };
      const conversationId = isChief ? String(candidate.branch).replace(/^chief:/, "") : job.buildId;
      this.events.emit({ type: "turn.started", ...(job.todoId ? { todoId: job.todoId } : {}), conversationId, payload: { turnId: job.turnId, machineId: machine.id } });
      return job;
    });
  }

  ingestEvents(token: string, turnId: string, agentEvents: AgentEvent[]): void {
    const machine = this.authenticate(token);
    const turn = this.ownedTurn(machine, turnId);
    const buildId = String(turn.build_id);
    const conversationId = turn.todo_id ? buildId : String(turn.branch).replace(/^chief:/, "");
    const todoId = turn.todo_id as string | null;
    for (const event of agentEvents) {
      if (event.type === "message.delta") {
        let message = this.db.row("SELECT * FROM messages WHERE turn_id = ? AND role = 'agent' ORDER BY created_at DESC LIMIT 1", turnId);
        if (!message || !parseJson<Record<string, unknown>>(message.meta_json, {}).streaming) {
          const messageId = this.orchestrator.addMessage(conversationId, turnId, "agent", "", { streaming: true });
          message = this.db.row("SELECT * FROM messages WHERE id = ?", messageId);
        }
        this.db.run("UPDATE messages SET content = content || ? WHERE id = ?", event.content, message?.id);
      } else if (event.type === "message.completed") {
        const message = this.db.row("SELECT * FROM messages WHERE turn_id = ? AND role = 'agent' ORDER BY created_at DESC LIMIT 1", turnId);
        if (message) this.db.run("UPDATE messages SET content = COALESCE(?, content), meta_json = ? WHERE id = ?", event.content ?? null, JSON.stringify({ streaming: false }), message.id);
        else this.orchestrator.addMessage(conversationId, turnId, "agent", event.content ?? "", { streaming: false });
      } else if (event.type === "tool.started" || event.type === "tool.completed") {
        this.orchestrator.addMessage(conversationId, turnId, "tool", event.type === "tool.started" ? `Started ${event.tool}` : `Completed ${event.tool}`, event as unknown as Record<string, unknown>);
      } else if (event.type === "reasoning.delta") {
        this.orchestrator.addMessage(conversationId, turnId, "tool", event.content, { type: event.type });
      } else if (event.type === "usage") {
        this.db.run("UPDATE turns SET tokens_in = ?, tokens_out = ? WHERE id = ?", event.tokensIn, event.tokensOut, turnId);
      }
      this.events.emit({ type: event.type, ...(todoId ? { todoId } : {}), conversationId, payload: event });
    }
  }

  inbox(token: string, turnId: string): Array<{ id: string; content: string }> {
    const machine = this.authenticate(token);
    const turn = this.ownedTurn(machine, turnId);
    const rows = this.db.rows("SELECT id, content FROM queued_messages WHERE conversation_id = ? AND delivered_at IS NULL ORDER BY created_at", turn.build_id);
    if (rows.length) {
      const timestamp = now();
      for (const row of rows) this.db.run("UPDATE queued_messages SET delivered_at = ? WHERE id = ?", timestamp, row.id);
    }
    return rows.map((row) => ({ id: String(row.id), content: String(row.content) }));
  }

  complete(token: string, turnId: string, payload: TurnCompletePayload): void {
    const machine = this.authenticate(token);
    const turn = this.ownedTurn(machine, turnId);
    const usage = payload.usage ?? { tokensIn: 0, tokensOut: 0, durationMs: 0 };
    this.db.run("UPDATE turns SET tokens_in = ?, tokens_out = ?, session_state_json = ? WHERE id = ?", usage.tokensIn, usage.tokensOut, payload.sessionState ? JSON.stringify(payload.sessionState) : null, turnId);
    this.db.run("UPDATE builds SET head_commit = COALESCE(?, head_commit), tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, duration_ms = duration_ms + ? WHERE id = ?", payload.headCommit ?? null, usage.tokensIn, usage.tokensOut, usage.durationMs, turn.build_id);

    if (!turn.todo_id && payload.sessionState) this.db.run("UPDATE topics SET runtime_session_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(payload.sessionState), now(), String(turn.branch).replace(/^chief:/, ""));
    if (payload.plan) this.storeDocument(String(turn.build_id), "plan", payload.plan);
    if (payload.diff !== undefined) this.storeDocument(String(turn.build_id), "changes", payload.diff);

    if (turn.kind === "merge" && (payload.merge?.ok === false || payload.status !== "done")) {
      const error = payload.merge?.error ?? payload.error ?? "Merge failed";
      this.db.run("UPDATE turns SET status = 'failed', ended_at = ?, error = ? WHERE id = ?", now(), error, turnId);
      if (turn.todo_id) {
        const todo = this.orchestrator.getTodo(String(turn.todo_id));
        this.orchestrator.setPhase(todo, "review");
        this.orchestrator.addMessage(String(turn.build_id), turnId, "system", `Merge failed: ${error}`, { error });
      }
    } else {
      this.orchestrator.completeTurn(turnId, payload.status, payload.error);
    }
    const conversationId = turn.todo_id ? String(turn.build_id) : String(turn.branch).replace(/^chief:/, "");
    this.events.emit({ type: "turn.completed", ...(turn.todo_id ? { todoId: String(turn.todo_id) } : {}), conversationId, payload: { turnId, status: payload.status } });
  }

  private storeDocument(buildId: string, kind: "plan" | "changes", content: string): void {
    const version = Number((this.db.row("SELECT COALESCE(max(version), 0) + 1 AS version FROM documents WHERE build_id = ? AND kind = ?", buildId, kind) ?? {}).version ?? 1);
    this.db.run("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)", id(), buildId, kind, version, content, now());
    this.events.emit({ type: "document.created", conversationId: buildId, payload: { kind, version } });
  }

  private ownedTurn(machine: Row, turnId: string): Row {
    const turn = this.db.row("SELECT t.*, b.todo_id, b.branch FROM turns t JOIN builds b ON b.id = t.build_id WHERE t.id = ?", turnId);
    if (!turn) throw new StateError("Turn not found", 404);
    if (turn.machine_id !== machine.id) throw new StateError("Turn is not assigned to this machine", 403);
    if (turn.status !== "running") throw new StateError(`Turn is ${String(turn.status)}`);
    return turn;
  }
}
