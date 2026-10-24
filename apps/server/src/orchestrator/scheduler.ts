import type { Connections } from "../resources/connections.js";
import type { Memories } from "../resources/memories.js";
import type { Secrets } from "../resources/secrets.js";
import type { Skills } from "../resources/skills.js";
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
  constructor(readonly db: MusterDb, readonly orchestrator: Orchestrator, readonly events: EventBus, readonly memories?: Memories, readonly secrets?: Secrets, readonly skills?: Skills, readonly connections?: Connections) {}

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
    // Expire leases before reviving a machine after a long disconnection.
    this.failOfflineMachines();
    this.db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", now(), machine.id);
    const stop = running.filter((turnId) => {
      const row = this.db.row("SELECT stop_requested, machine_id, status FROM turns WHERE id = ?", turnId);
      if (!row || row.machine_id !== machine.id || row.status !== "running") return true;
      this.db.run("UPDATE turns SET last_reported_at=? WHERE id=?", now(), turnId);
      return row.stop_requested === 1;
    });
    return { stop };
  }

  failOfflineMachines(): void {
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const turns = this.db.rows(`SELECT t.id, m.last_seen_at FROM turns t JOIN machines m ON m.id=t.machine_id
      WHERE t.status='running' AND (m.last_seen_at IS NULL OR m.last_seen_at < ? OR COALESCE(t.last_reported_at,t.started_at) < ?)`, cutoff, cutoff);
    for (const turn of turns) {
      const offline = !turn.last_seen_at || String(turn.last_seen_at) < cutoff;
      this.orchestrator.completeTurn(String(turn.id), "failed", offline
        ? "Machine went offline: no heartbeat for 30 seconds."
        : "Machine lost turn: not reported in heartbeat for 30 seconds.");
    }
  }

  claim(token: string, requestId?: string): TurnJob | null {
    const machine = this.authenticate(token);
    this.failOfflineMachines();
    return this.db.transaction(() => {
      if (requestId) {
        const saved = this.db.row("SELECT job_json FROM machine_claims WHERE machine_id=? AND request_id=?", machine.id, requestId);
        if (saved) {
          const job = JSON.parse(String(saved.job_json)) as TurnJob;
          return this.db.row("SELECT id FROM turns WHERE id=? AND status='running'", job.turnId) ? this.withEnv(job) : null;
        }
      }
      const running = Number(this.db.row("SELECT count(*) AS count FROM turns WHERE machine_id=? AND status='running'", machine.id)?.count ?? 0);
      if (running >= Number(machine.concurrency)) return null;
      const runtimes = parseJson<Runtime[]>(machine.runtimes_json, []);
      const candidates = this.db.rows(`
        SELECT t.*, b.todo_id, b.branch, b.id AS actual_build_id,
               td.project_id, td.agent_id, td.plan_agent_id, td.previous_gate,
               p.repo_url, p.base_branch,
               a.id AS selected_agent_id, a.name, a.runtime, a.model, a.reasoning, a.role,
               chief.id AS chief_agent_id, chief.name AS chief_name, chief.runtime AS chief_runtime, chief.model AS chief_model,
               chief.reasoning AS chief_reasoning, chief.role AS chief_role
        FROM turns t JOIN builds b ON b.id=t.build_id
        LEFT JOIN todos td ON td.id=b.todo_id LEFT JOIN projects p ON p.id=td.project_id
        LEFT JOIN agents a ON a.id=COALESCE(b.scheduled_agent_id,CASE WHEN t.kind='plan' OR (t.kind='revise' AND td.previous_gate='confirm') THEN COALESCE(td.plan_agent_id,td.agent_id) ELSE td.agent_id END)
        LEFT JOIN agents chief ON chief.is_chief=1
        WHERE t.status='queued' AND b.status='active'
          AND (t.not_before IS NULL OR t.not_before<=?)
          AND (b.machine_id IS NULL OR b.machine_id=?)
          AND (b.required_machine_id IS NULL OR b.required_machine_id=?)
          AND NOT EXISTS (SELECT 1 FROM turns active WHERE active.build_id=b.id AND active.status='running')
        ORDER BY t.rowid`, now(), machine.id, machine.id);
      const candidate = candidates.find((row) => runtimes.includes((row.todo_id ? row.runtime : row.chief_runtime) as Runtime));
      if (!candidate) return null;
      const isChief = !candidate.todo_id;
      const agentId = String(isChief ? candidate.chief_agent_id : candidate.selected_agent_id);
      const agent = {
        runtime: (isChief ? candidate.chief_runtime : candidate.runtime) as Runtime,
        model: String(isChief ? candidate.chief_model : candidate.model),
        reasoning: (isChief ? candidate.chief_reasoning : candidate.reasoning) as string | null,
        role: String(isChief ? candidate.chief_role : candidate.role),
      };
      const profile = this.db.agent(this.db.row("SELECT * FROM agents WHERE id=?", agentId)!);
      const snapshot = { id: agentId, name: String(isChief ? candidate.chief_name : candidate.name), ...agent };
      this.db.run("UPDATE turns SET status='running', machine_id=?, started_at=?, last_reported_at=?, agent_snapshot_json=? WHERE id=?", machine.id, now(), now(), JSON.stringify(snapshot), candidate.id);
      this.db.run("UPDATE builds SET machine_id=? WHERE id=?", machine.id, candidate.actual_build_id);
      this.orchestrator.phaseForClaim(String(candidate.id));
      const mcpToken = `mst_turn_${crypto.randomUUID().replaceAll("-", "")}`;
      this.db.run("INSERT INTO mcp_tokens VALUES (?, ?, ?)", mcpToken, candidate.id, now());
      // Only the immediate predecessor can supply state; never resurrect an older session.
      const previous = this.db.row("SELECT session_state_json, agent_snapshot_json FROM turns WHERE build_id=? AND id<>? AND status NOT IN ('queued','running') ORDER BY rowid DESC LIMIT 1", candidate.actual_build_id, candidate.id);
      const previousAgent = parseJson<Record<string, unknown>>(previous?.agent_snapshot_json, {});
      const canResume = previousAgent.id === agentId && previousAgent.runtime === agent.runtime && previousAgent.model === agent.model;
      const topicId = isChief ? String(candidate.branch).replace(/^chief:/, "") : null;
      const readOnly = candidate.kind === "plan" || (candidate.kind === "revise" && candidate.previous_gate === "confirm");
      const job: TurnJob = {
        turnId: String(candidate.id), buildId: String(candidate.actual_build_id), todoId: candidate.todo_id as string | null, topicId,
        kind: candidate.kind as TurnKind,
        project: isChief ? null : { id: String(candidate.project_id), repoUrl: String(candidate.repo_url), baseBranch: String(candidate.base_branch) },
        branch: isChief ? null : String(candidate.branch), agent, prompt: String(candidate.prompt),
        systemInstructions: instructionsFor(profile) + (this.memories?.instructions(agentId) ?? ""),
        skills: this.skills?.list().filter((s) => profile.defaultSkillIds?.includes(s.id) || (!isChief && new RegExp(`@${s.slug}(?![a-zA-Z0-9_-])`).test(String(this.db.row("SELECT spec FROM todos WHERE id=?", candidate.todo_id)?.spec ?? "") + "\n" + this.db.rows("SELECT content FROM messages WHERE conversation_id=?", candidate.actual_build_id).map((r) => r.content).join("\n")))).map(({ slug, name, description, version }) => ({ slug, name, description, version })) ?? [],
        pushBranch: profile.permissions?.pushBranch ?? false,
        sessionState: canResume ? parseJson(previous?.session_state_json, null) : null, readOnly,
        mcp: { url: `${this.orchestrator.publicUrl}/mcp`, token: mcpToken },
      };
      if (requestId) this.db.run("INSERT INTO machine_claims VALUES (?,?,?)", machine.id, requestId, JSON.stringify(job));
      this.events.emit({ type: "turn.started", ...(job.todoId ? { todoId: job.todoId } : {}), conversationId: topicId ?? job.buildId, payload: { turnId: job.turnId, machineId: machine.id } });
      return this.withEnv(job);
    });
  }

  private withEnv(job: TurnJob): TurnJob {
    const turn = this.db.row("SELECT agent_snapshot_json,machine_id FROM turns WHERE id=?", job.turnId);
    const snapshot = parseJson<{ id?: string }>(turn?.agent_snapshot_json, {});
    const row = snapshot.id ? this.db.row("SELECT * FROM agents WHERE id=?", snapshot.id) : undefined;
    const profile = row ? this.db.agent(row) : undefined;
    const delivery = this.connections?.delivery(profile?.connectionIds ?? [], String(turn?.machine_id)) ?? { connections: [], omitted: [] };
    for (const name of delivery.omitted) {
      const content = `Connection ${name} omitted: it runs on another machine.`;
      if (!this.db.row("SELECT id FROM messages WHERE turn_id=? AND content=?", job.turnId, content)) this.orchestrator.addMessage(job.topicId ?? job.buildId, job.turnId, "system", content, { code: "connection_machine_mismatch", connectionName: name });
    }
    return { ...job, connections: delivery.connections, systemInstructions: job.systemInstructions + delivery.connections.map((c) => `\nTools from connection ${c.identifier} are available as mcp__${c.identifier}__*.`).join(""), ...(profile?.permissions?.secrets ? { env: this.secrets?.env(job.project?.id ?? null) ?? {} } : {}) };
  }

  // Roll back only a still-running, undelivered claim. A completed turn must never be requeued.
  releaseClaim(token: string, job: TurnJob, requestId?: string): void {
    const machine = this.authenticate(token);
    this.db.transaction(() => {
      const turn = this.db.row("SELECT id FROM turns WHERE id=? AND machine_id=? AND status='running'", job.turnId, machine.id);
      if (!turn) return;
      this.db.run("DELETE FROM mcp_tokens WHERE turn_id=?", job.turnId);
      if (requestId) this.db.run("DELETE FROM machine_claims WHERE machine_id=? AND request_id=?", machine.id, requestId);
      this.db.run("UPDATE turns SET status='queued', machine_id=NULL, started_at=NULL, last_reported_at=NULL, agent_snapshot_json=NULL WHERE id=?", job.turnId);
      // Preserve affinity to a machine that already holds this build's worktree.
      this.db.run("UPDATE builds SET machine_id=NULL WHERE id=? AND NOT EXISTS (SELECT 1 FROM turns WHERE build_id=? AND machine_id IS NOT NULL)", job.buildId, job.buildId);
      if (job.todoId) {
        this.db.run("UPDATE todos SET phase='queued', updated_at=? WHERE id=? AND phase IN ('planning','building')", now(), job.todoId);
        this.events.emit({ type: "todo.changed", todoId: job.todoId, payload: {} });
      }
    });
  }

  ingestEvents(token: string, turnId: string, agentEvents: AgentEvent[], batchId: string): void {
    const machine = this.authenticate(token);
    // An already accepted batch can be retried even after completion.
    const turn = this.ownedTurn(machine, turnId, false);
    const body = JSON.stringify(agentEvents);
    const previous = this.db.row("SELECT body_json FROM event_batches WHERE turn_id=? AND batch_id=?", turnId, batchId);
    if (previous) {
      if (previous.body_json !== body) throw new StateError("Batch id was already used with different events");
      return;
    }
    if (turn.status !== "running") throw new StateError(`Turn is ${String(turn.status)}`);
    this.db.transaction(() => {
      this.db.run("INSERT INTO event_batches VALUES (?,?,?)", turnId, batchId, body);
      const conversationId = this.conversation(turn);
      for (const event of agentEvents) {
        let messageId: string | undefined;
        if (event.type === "message.delta" || event.type === "message.completed") {
          const latest = this.db.row("SELECT * FROM messages WHERE turn_id=? AND role='agent' ORDER BY rowid DESC LIMIT 1", turnId);
          const streaming = parseJson<Record<string, unknown>>(latest?.meta_json, {}).streaming;
          if (latest && streaming === true) messageId = String(latest.id);
          else messageId = this.orchestrator.addMessage(conversationId, turnId, "agent", "", { streaming: true });
          const message = this.db.message(this.db.row("SELECT * FROM messages WHERE id=?", messageId)!);
          const content = event.type === "message.delta" ? message.content + event.content : event.content ?? message.content;
          const meta = { ...message.meta, streaming: event.type === "message.delta", revision: Number(message.meta.revision ?? 0) + 1 };
          this.db.run("UPDATE messages SET content=?, meta_json=? WHERE id=?", content, JSON.stringify(meta), messageId);
        } else if (event.type === "tool.started" || event.type === "tool.completed") {
          this.orchestrator.addMessage(conversationId, turnId, "tool", event.type === "tool.started" ? `Started ${event.tool}` : `Completed ${event.tool}`, event as unknown as Record<string, unknown>);
        } else if (event.type === "reasoning.delta") {
          this.orchestrator.addMessage(conversationId, turnId, "tool", event.content, { type: event.type });
        } else if (event.type === "usage") {
          this.db.run("UPDATE turns SET tokens_in=?, tokens_out=? WHERE id=?", event.tokensIn, event.tokensOut, turnId);
        }
        this.events.emit({ type: event.type, turnId, ...(turn.todo_id ? { todoId: String(turn.todo_id) } : {}), conversationId, payload: event,
          ...(messageId ? { messageId, message: this.db.message(this.db.row("SELECT * FROM messages WHERE id=?", messageId)!) } : {}) });
      }
    });
  }

  inbox(token: string, turnId: string): Array<{ id: string; content: string }> {
    const turn = this.ownedTurn(this.authenticate(token), turnId);
    const reserved = this.db.raw.prepare("UPDATE queued_messages SET delivery_turn_id=? WHERE conversation_id=? AND delivered_at IS NULL AND delivery_turn_id IS NULL").run(turnId, this.conversation(turn));
    if (reserved.changes) this.events.emit({ type: "message.queue_changed", conversationId: this.conversation(turn), payload: { delivering: true } });
    return this.db.rows("SELECT id,content FROM queued_messages WHERE conversation_id=? AND delivered_at IS NULL ORDER BY rowid", this.conversation(turn))
      .map((row) => ({ id: String(row.id), content: String(row.content) }));
  }

  ackInbox(token: string, turnId: string, ids: string[]): void {
    const turn = this.ownedTurn(this.authenticate(token), turnId);
    const conversationId = this.conversation(turn);
    for (const messageId of ids) {
      const updated = this.db.raw.prepare("UPDATE queued_messages SET delivered_at=? WHERE id=? AND conversation_id=? AND delivered_at IS NULL AND delivery_turn_id=?").run(now(), messageId, conversationId, turnId);
      if (updated.changes) this.events.emit({ type: "message.delivered", conversationId, payload: { id: messageId } });
    }
  }

  complete(token: string, turnId: string, payload: TurnCompletePayload): void {
    const turn = this.ownedTurn(this.authenticate(token), turnId, false);
    const serialized = JSON.stringify(payload);
    if (turn.completion_json === serialized) return;
    if (turn.status !== "running") throw new StateError(`Turn is ${String(turn.status)}`);
    this.db.transaction(() => {
      const usage = payload.usage ?? { tokensIn: Number(turn.tokens_in), tokensOut: Number(turn.tokens_out), durationMs: Math.max(0, Date.now() - Date.parse(String(turn.started_at))) };
      this.db.run("UPDATE turns SET tokens_in=?, tokens_out=?, duration_ms=?, session_state_json=?, completion_json=? WHERE id=?", usage.tokensIn, usage.tokensOut, usage.durationMs, payload.sessionState ? JSON.stringify(payload.sessionState) : null, serialized, turnId);
      this.db.run("UPDATE builds SET head_commit=COALESCE(?,head_commit), base_commit=COALESCE(base_commit,?) WHERE id=?", payload.headCommit ?? null, payload.baseCommit ?? null, turn.build_id);
      if (!turn.todo_id) this.db.run("UPDATE topics SET runtime_session_json=?, updated_at=? WHERE id=?", payload.sessionState ? JSON.stringify(payload.sessionState) : null, now(), this.conversation(turn));
      if (payload.plan !== undefined) this.storeDocument(String(turn.build_id), "plan", payload.plan);
      if (payload.diff !== undefined) this.storeDocument(String(turn.build_id), "changes", payload.diff);
      const isBuild = turn.kind === "build" || (turn.kind === "revise" && turn.todo_id && this.orchestrator.getTodo(String(turn.todo_id)).previousGate === "review");
      if (payload.status === "done" && payload.diff === "" && isBuild) {
        this.orchestrator.addMessage(String(turn.build_id), turnId, "system", "No file changes in this build", { code: "no_file_changes" });
      }
      const failedMerge = turn.kind === "merge" && (payload.merge?.ok !== true || payload.status !== "done");
      const error = failedMerge ? payload.merge?.error ?? payload.error ?? "Merge failed: daemon did not confirm publication" : payload.error;
      this.orchestrator.completeTurn(turnId, failedMerge ? "failed" : payload.status, error);
      if (failedMerge) this.orchestrator.addMessage(String(turn.build_id), turnId, "system", `Merge failed: ${error}`, { error });
    });
  }

  private storeDocument(buildId: string, kind: "plan" | "changes", content: string): void {
    const version = Number(this.db.row("SELECT COALESCE(max(version),0)+1 AS version FROM documents WHERE build_id=? AND kind=?", buildId, kind)?.version ?? 1);
    this.db.run("INSERT INTO documents VALUES (?,?,?,?,?,?)", id(), buildId, kind, version, content, now());
    this.events.emit({ type: "document.created", conversationId: buildId, payload: { kind, version } });
  }

  private conversation(turn: Row): string { return turn.todo_id ? String(turn.build_id) : String(turn.branch).replace(/^chief:/, ""); }

  private ownedTurn(machine: Row, turnId: string, requireRunning = true): Row {
    const turn = this.db.row("SELECT t.*, b.todo_id, b.branch FROM turns t JOIN builds b ON b.id=t.build_id WHERE t.id=?", turnId);
    if (!turn) throw new StateError("Turn not found", 404);
    if (turn.machine_id !== machine.id) throw new StateError("Turn is not assigned to this machine", 403);
    if (requireRunning && turn.status !== "running") throw new StateError(`Turn is ${String(turn.status)}`);
    return turn;
  }
}
