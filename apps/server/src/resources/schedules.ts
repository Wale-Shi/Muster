import { nextRun, scheduleSchema, type Schedule } from "@muster/shared";
import { id, now, type MusterDb } from "../db/index.js";
import { StateError, type Orchestrator } from "../orchestrator/state.js";

export class Schedules {
  constructor(readonly db: MusterDb, readonly orchestrator: Orchestrator) {}
  list(todoId?: string): Schedule[] {
    return this.db.rows(`SELECT * FROM schedules ${todoId ? "WHERE todo_id=?" : ""} ORDER BY created_at`, ...(todoId ? [todoId] : [])).map((r) => ({ id: String(r.id), todoId: String(r.todo_id), cadence: r.cadence as Schedule["cadence"], minute: Number(r.minute), hour: r.hour as number | null, weekday: r.weekday as number | null, runAt: r.run_at as string | null, timezone: String(r.timezone), mode: r.mode as Schedule["mode"], agentId: r.agent_id as string | null, machineId: r.machine_id as string | null, enabled: r.enabled === 1, nextRunAt: r.next_run_at as string | null, lastRunAt: r.last_run_at as string | null, lastResult: r.last_result as Schedule["lastResult"], lastError: r.last_error as string | null, createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }
  get(scheduleId: string): Schedule { const s = this.list().find((s) => s.id === scheduleId); if (!s) throw new StateError("Schedule not found", 404); return s; }
  save(value: unknown, scheduleId?: string): Schedule {
    const old = scheduleId ? this.get(scheduleId) : undefined;
    const input = scheduleSchema.parse(old ? { ...old, ...value as object } : value);
    this.orchestrator.getTodo(input.todoId);
    for (const [table, key] of [["agents", input.agentId], ["machines", input.machineId]]) if (key && !this.db.row(`SELECT id FROM ${table} WHERE id=?`, key)) throw new StateError("Resource not found", 400);
    const next = nextRun(input, new Date()); const key = scheduleId ?? id();
    this.db.run(`INSERT INTO schedules (id,todo_id,cadence,minute,hour,weekday,run_at,timezone,mode,agent_id,machine_id,enabled,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET todo_id=excluded.todo_id,cadence=excluded.cadence,minute=excluded.minute,hour=excluded.hour,weekday=excluded.weekday,run_at=excluded.run_at,timezone=excluded.timezone,mode=excluded.mode,agent_id=excluded.agent_id,machine_id=excluded.machine_id,enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`, key, input.todoId, input.cadence, input.minute, input.hour ?? null, input.weekday ?? null, input.runAt ?? null, input.timezone, input.mode, input.agentId ?? null, input.machineId ?? null, Number(input.enabled && !!next), next?.toISOString() ?? null, now(), now());
    this.changed(); return this.get(key);
  }
  delete(key: string): void { this.get(key); this.db.run("DELETE FROM schedules WHERE id=?", key); this.changed(); }
  tick(at = new Date()): void {
    for (const s of this.list().filter((s) => s.enabled && s.nextRunAt && s.nextRunAt <= at.toISOString())) this.run(s.id, at, true);
  }
  run(key: string, at = new Date(), due = false): Schedule {
    this.db.transaction(() => {
      const s = this.get(key);
      if (due && (!s.enabled || !s.nextRunAt || s.nextRunAt > at.toISOString())) return;
      const next = s.cadence === "once" ? null : nextRun(s, at);
      this.db.run("UPDATE schedules SET next_run_at=?,enabled=?,last_run_at=?,updated_at=? WHERE id=?", next?.toISOString() ?? null, Number(s.enabled && !!next), at.toISOString(), at.toISOString(), key);
      try {
        const todo = this.orchestrator.getTodo(s.todoId);
        const busy = ["planning", "building", "queued"].includes(todo.phase) || this.db.row("SELECT t.id FROM turns t JOIN builds b ON b.id=t.build_id WHERE b.todo_id=? AND t.status IN ('queued','running')", todo.id);
        if (busy) this.db.run("UPDATE schedules SET last_result='skipped_busy',last_error=NULL WHERE id=?", key);
        else {
          this.db.raw.exec("SAVEPOINT scheduled_run");
          try {
            const turnId = this.orchestrator.scheduledRestart(todo.id, s.mode, s.agentId ?? null, s.machineId ?? null);
            const build = this.db.row("SELECT build_id FROM turns WHERE id=?", turnId)!;
            this.orchestrator.addMessage(String(build.build_id), null, "system", "Scheduled run started", { scheduleId: key });
            this.db.run("UPDATE schedules SET last_result='started',last_error=NULL WHERE id=?", key);
            this.db.raw.exec("RELEASE scheduled_run");
          } catch (error) { this.db.raw.exec("ROLLBACK TO scheduled_run; RELEASE scheduled_run"); throw error; }
        }
      } catch { this.db.run("UPDATE schedules SET last_result='error',last_error='Scheduled run could not start' WHERE id=?", key); }
    });
    this.changed(); return this.get(key);
  }
  private changed(): void { this.orchestrator.events.emit({ type: "schedule.changed", payload: {} }); }
}
