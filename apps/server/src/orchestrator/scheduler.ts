import { taskMetadata } from "@muster/shared";
import type { Connections } from "../resources/connections.js";
import type { Skills } from "../resources/skills.js";
import type { AgentEvent, MachineModels, Runtime, TurnCompletePayload, TurnJob, TurnKind } from "@muster/shared";
import { id, MusterDb, now } from "../db/index.js";
import type { EventBus } from "../events.js";
import { instructionsFor } from "./prompts.js";
import { Orchestrator, StateError } from "./state.js";

type Row = Record<string, unknown>;
const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

export class Scheduler {
  constructor(readonly db: MusterDb, readonly orchestrator: Orchestrator, readonly events: EventBus, readonly skills?: Skills, readonly connections?: Connections) {}

  enroll(name: string, runtimes: Runtime[], concurrency: number, previousToken?: string): { machineId: string; token: string } {
    // A daemon re-enrolls when its name, concurrency or runtimes change. Keeping its identity
    // keeps the conversations and builds pinned to it claimable.
    const existing = previousToken ? this.db.row("SELECT id, token FROM machines WHERE token = ?", previousToken) : undefined;
    if (existing) {
      this.db.run("UPDATE machines SET name = ?, concurrency = ?, runtimes_json = ?, last_seen_at = ?, models_requested = 1 WHERE id = ?", name, concurrency, JSON.stringify(runtimes), now(), existing.id);
      this.events.emit({ type: "machine.changed", payload: { machineId: existing.id } });
      return { machineId: String(existing.id), token: String(existing.token) };
    }
    const machineId = id();
    const token = `mst_machine_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = now();
    this.db.run("INSERT INTO machines (id, name, token, concurrency, runtimes_json, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", machineId, name, token, concurrency, JSON.stringify(runtimes), timestamp, timestamp);
    this.events.emit({ type: "machine.changed", payload: { machineId } });
    return { machineId, token };
  }

  authenticate(token: string): Row {
    const machine = this.db.row("SELECT * FROM machines WHERE token = ?", token);
    if (!machine) throw new StateError("Invalid machine token", 401);
    return machine;
  }

  heartbeat(token: string, running: string[]): { stop: string[]; refreshModels: boolean } {
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
    // Machines report models after starting; later reports happen only on request.
    const refreshModels = this.db.row("SELECT models_requested FROM machines WHERE id = ?", machine.id)?.models_requested === 1;
    return { stop, refreshModels };
  }
  reportModels(token: string, models: MachineModels): void {
    const machine = this.authenticate(token);
    this.db.run("UPDATE machines SET models_json = ?, models_requested = 0 WHERE id = ?", JSON.stringify(models), machine.id);
    this.events.emit({ type: "machine.changed", payload: { machineId: machine.id } });
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
      // A task turn runs its assigned agent; a master-agent turn runs its workspace's master agent.
      const candidates = this.db.rows(`
        SELECT t.*, b.todo_id, b.branch, b.id AS actual_build_id,
               td.number AS todo_number, td.title AS todo_title, td.spec AS todo_spec,
               COALESCE(td.project_id, tp.project_id) AS project_id, p.repo_url, p.base_branch,
               a.id AS selected_agent_id, a.runtime
        FROM turns t JOIN builds b ON b.id=t.build_id
        LEFT JOIN todos td ON td.id=b.todo_id
        LEFT JOIN topics tp ON b.todo_id IS NULL AND b.branch='chief:'||tp.id
        LEFT JOIN projects p ON p.id=COALESCE(td.project_id, tp.project_id)
        LEFT JOIN agents a ON a.id=CASE WHEN b.todo_id IS NULL
          THEN COALESCE(p.chief_agent_id, (SELECT id FROM agents WHERE is_chief=1 ORDER BY created_at LIMIT 1))
          ELSE td.agent_id END
        WHERE t.status='queued' AND b.status='active'
          AND (t.not_before IS NULL OR t.not_before<=?)
          AND (b.machine_id IS NULL OR b.machine_id=?
            -- Muster runs on one computer, so work may leave an executor that went offline (for
            -- example one that re-enrolled under a new identity); its worktree is on the same disk.
            OR NOT EXISTS (SELECT 1 FROM machines pinned WHERE pinned.id=b.machine_id AND pinned.last_seen_at>=?))
          AND NOT EXISTS (SELECT 1 FROM turns active WHERE active.build_id=b.id AND active.status='running')
        ORDER BY t.rowid`, now(), machine.id, new Date(Date.now() - 30_000).toISOString());
      const candidate = candidates.find((row) => runtimes.includes(row.runtime as Runtime));
      if (!candidate) return null;
      const isChief = !candidate.todo_id;
      const agentId = String(candidate.selected_agent_id);
      const profile = this.db.agent(this.db.row("SELECT * FROM agents WHERE id=?", agentId)!);
      const agent = { runtime: profile.runtime, model: profile.model, reasoning: profile.reasoning, role: profile.role };
      const snapshot = { id: agentId, name: profile.name, ...agent };
      this.db.run("UPDATE turns SET status='running', machine_id=?, started_at=?, last_reported_at=?, agent_snapshot_json=? WHERE id=?", machine.id, now(), now(), JSON.stringify(snapshot), candidate.id);
      this.db.run("UPDATE builds SET machine_id=? WHERE id=?", machine.id, candidate.actual_build_id);
      this.orchestrator.phaseForClaim(String(candidate.id));
      const mcpToken = `mst_turn_${crypto.randomUUID().replaceAll("-", "")}`;
      this.db.run("INSERT INTO mcp_tokens VALUES (?, ?, ?)", mcpToken, candidate.id, now());
      // Only the immediate predecessor can supply state; never resurrect an older session.
      const previous = this.db.row("SELECT session_state_json, agent_snapshot_json, machine_id FROM turns WHERE build_id=? AND id<>? AND status NOT IN ('queued','running') ORDER BY rowid DESC LIMIT 1", candidate.actual_build_id, candidate.id);
      const previousAgent = parseJson<Record<string, unknown>>(previous?.agent_snapshot_json, {});
      // Runtime sessions live on the machine that ran them.
      const canResume = previousAgent.id === agentId && previousAgent.runtime === agent.runtime && previousAgent.model === agent.model && (!previous?.machine_id || previous.machine_id === machine.id);
      const topicId = isChief ? String(candidate.branch).replace(/^chief:/, "") : null;
      const projectRow = candidate.project_id ? this.db.row("SELECT * FROM projects WHERE id=?", candidate.project_id) : undefined;
      const mentioned = isChief ? "" : String(candidate.todo_spec) + "\n" + this.db.rows("SELECT content FROM messages WHERE conversation_id=?", candidate.actual_build_id).map((r) => r.content).join("\n");
      const job: TurnJob = {
        turnId: String(candidate.id), buildId: String(candidate.actual_build_id), todoId: candidate.todo_id as string | null, topicId,
        kind: candidate.kind as TurnKind,
        ...(isChief ? {} : { task: taskMetadata({ id: String(candidate.todo_id), number: Number(candidate.todo_number), title: String(candidate.todo_title), spec: String(candidate.todo_spec) }, this.orchestrator.publicUrl) }),
        project: isChief ? null : { id: String(candidate.project_id), repoUrl: String(candidate.repo_url), baseBranch: String(candidate.base_branch) },
        branch: isChief ? null : String(candidate.branch), agent, prompt: String(candidate.prompt),
        systemInstructions: instructionsFor(profile, isChief, projectRow ? this.db.project(projectRow) : null),
        skills: this.skills?.list().filter((s) => profile.defaultSkillIds?.includes(s.id) || new RegExp(`@${s.slug}(?![a-zA-Z0-9_-])`).test(mentioned)).map(({ slug, name, description, version }) => ({ slug, name, description, version })) ?? [],
        sessionState: canResume ? parseJson(previous?.session_state_json, null) : null,
        mcp: { url: `${this.orchestrator.publicUrl}/mcp`, token: mcpToken },
      };
      if (requestId) this.db.run("INSERT INTO machine_claims VALUES (?,?,?)", machine.id, requestId, JSON.stringify(job));
      this.events.emit({ type: "turn.started", ...(job.todoId ? { todoId: job.todoId } : {}), conversationId: topicId ?? job.buildId, payload: { turnId: job.turnId, machineId: machine.id } });
      return this.withEnv(job);
    });
  }

  private withEnv(job: TurnJob): TurnJob {
    const turn = this.db.row("SELECT agent_snapshot_json FROM turns WHERE id=?", job.turnId);
    const snapshot = parseJson<{ id?: string }>(turn?.agent_snapshot_json, {});
    const row = snapshot.id ? this.db.row("SELECT * FROM agents WHERE id=?", snapshot.id) : undefined;
    const connections = this.connections?.delivery(row ? this.db.agent(row).connectionIds ?? [] : []) ?? [];
    return { ...job, connections, systemInstructions: job.systemInstructions + connections.map((c) => `\nTools from connection ${c.identifier} are available as mcp__${c.identifier}__*.`).join("") };
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
        this.db.run("UPDATE todos SET phase='queued', updated_at=? WHERE id=? AND phase='building'", now(), job.todoId);
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
      if (payload.diff !== undefined) this.storeDocument(String(turn.build_id), payload.diff);
      if (payload.status === "done" && payload.diff === "" && (turn.kind === "build" || turn.kind === "revise")) {
        this.orchestrator.addMessage(String(turn.build_id), turnId, "system", "No file changes in this build", { code: "no_file_changes" });
      }
      const failedMerge = turn.kind === "merge" && (payload.merge?.ok !== true || payload.status !== "done");
      const error = failedMerge ? payload.merge?.error ?? payload.error ?? "Merge failed: daemon did not confirm publication" : payload.error;
      this.orchestrator.completeTurn(turnId, failedMerge ? "failed" : payload.status, error);
      if (failedMerge) this.orchestrator.addMessage(String(turn.build_id), turnId, "system", `Merge failed: ${error}`, { error });
    });
  }

  private storeDocument(buildId: string, content: string): void {
    const version = Number(this.db.row("SELECT COALESCE(max(version),0)+1 AS version FROM documents WHERE build_id=? AND kind='changes'", buildId)?.version ?? 1);
    this.db.run("INSERT INTO documents VALUES (?,?,'changes',?,?,?)", id(), buildId, version, content, now());
    this.events.emit({ type: "document.created", conversationId: buildId, payload: { kind: "changes", version } });
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
