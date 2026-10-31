import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHIEF_MODEL, permissionsSchema } from "@muster/shared";
import type { Agent, Build, Document, Machine, Message, Project, Todo, Topic, Turn } from "@muster/shared";
import { migrations } from "./migrations.js";

type Row = Record<string, unknown>;
type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const bool = (value: unknown): boolean => value === 1;

export const now = (): string => new Date().toISOString();
export const id = (): string => crypto.randomUUID();

export class MusterDb {
  readonly raw: DatabaseSync;

  constructor(path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.seed();
  }

  close(): void { this.raw.close(); }

  private migrate(): void {
    const version = Number((this.raw.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    for (let index = version; index < migrations.length; index += 1) {
      const migration = migrations[index]!;
      const rebuild = typeof migration !== "string";
      // foreign_keys cannot change inside a transaction; table rebuilds need it off.
      if (rebuild) this.raw.exec("PRAGMA foreign_keys = OFF");
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        this.raw.exec(rebuild ? migration.sql : migration);
        if (rebuild && this.raw.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`Migration ${index + 1} broke foreign keys`);
        this.raw.exec(`PRAGMA user_version = ${index + 1}`);
        this.raw.exec("COMMIT");
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      } finally {
        if (rebuild) this.raw.exec("PRAGMA foreign_keys = ON");
      }
    }
  }

  private seed(): void {
    const timestamp = now();
    if (Number((this.raw.prepare("SELECT count(*) AS count FROM agents WHERE is_chief = 1").get() as Row).count) === 0) {
      this.raw.prepare("INSERT INTO agents (id,name,role,runtime,model,reasoning,avatar,is_chief,created_at,updated_at,permissions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id(), "Chief", "Coordinate the workspace: split goals into tasks, delegate them, follow them up and accept the results.", CHIEF_MODEL.runtime, CHIEF_MODEL.model, CHIEF_MODEL.reasoning, null, 1, timestamp, timestamp, JSON.stringify({ createSkills: true, updateSkills: true }));
    }
  }

  /** The master agent for a workspace, falling back to the default master agent. */
  chiefFor(projectId: string | null): Agent {
    const row = (projectId ? this.row("SELECT a.* FROM projects p JOIN agents a ON a.id=p.chief_agent_id WHERE p.id=?", projectId) : undefined)
      ?? this.row("SELECT * FROM agents WHERE is_chief = 1 ORDER BY created_at LIMIT 1");
    if (!row) throw new Error("No master agent configured");
    return this.agent(row);
  }

  project(row: Row): Project { return { description: String(row.description ?? ""), id: String(row.id), name: String(row.name), repoUrl: String(row.repo_url), baseBranch: String(row.base_branch), chiefAgentId: row.chief_agent_id as string | null, topicId: String(this.row("SELECT id FROM topics WHERE project_id=?", row.id)?.id ?? ""), createdAt: String(row.created_at) }; }
  agent(row: Row): Agent { return { id: String(row.id), name: String(row.name), role: String(row.role), runtime: row.runtime as Agent["runtime"], model: String(row.model), reasoning: row.reasoning as string | null, avatar: row.avatar as string | null, isChief: bool(row.is_chief), permissions: permissionsSchema.parse(json(row.permissions_json, {})), defaultSkillIds: json(row.default_skill_ids_json, []), connectionIds: json(row.connection_ids_json, []), updatedAt: String(row.updated_at), createdAt: String(row.created_at) }; }
  machine(row: Row): Machine { return { id: String(row.id), name: String(row.name), concurrency: Number(row.concurrency), runtimes: json(row.runtimes_json, []), models: json(row.models_json, {}), lastSeenAt: row.last_seen_at as string | null, createdAt: String(row.created_at) }; }
  todo(row: Row): Todo { return { id: String(row.id), number: Number(row.number), projectId: String(row.project_id), title: String(row.title), spec: String(row.spec), phase: row.phase as Todo["phase"], agentId: row.agent_id as string | null, createdBy: row.created_by as Todo["createdBy"], topicId: row.topic_id as string | null, previousGate: row.previous_gate as Todo["previousGate"], createdAt: String(row.created_at), updatedAt: String(row.updated_at), doneAt: row.done_at as string | null }; }
  build(row: Row): Build { return { id: String(row.id), todoId: row.todo_id as string | null, branch: String(row.branch), machineId: row.machine_id as string | null, status: row.status as Build["status"], baseCommit: row.base_commit as string | null, headCommit: row.head_commit as string | null, tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out), durationMs: Number(row.duration_ms), createdAt: String(row.created_at) }; }
  turn(row: Row): Turn { return { id: String(row.id), buildId: String(row.build_id), kind: row.kind as Turn["kind"], status: row.status as Turn["status"], machineId: row.machine_id as string | null, prompt: String(row.prompt), startedAt: row.started_at as string | null, endedAt: row.ended_at as string | null, error: row.error as string | null, tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out) }; }
  message(row: Row): Message { return { id: String(row.id), conversationId: String(row.conversation_id), turnId: row.turn_id as string | null, role: row.role as Message["role"], content: String(row.content), meta: json(row.meta_json, {}), createdAt: String(row.created_at) }; }
  document(row: Row): Document { return { id: String(row.id), buildId: String(row.build_id), kind: row.kind as Document["kind"], version: Number(row.version), content: String(row.content), createdAt: String(row.created_at) }; }
  topic(row: Row): Topic { return { id: String(row.id), projectId: row.project_id as string | null, title: String(row.title), runtimeSession: json(row.runtime_session_json, null), ...this.topicActivity(String(row.id)), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }

  private topicActivity(topicId: string): Pick<Topic, "activity" | "activeTurnId"> {
    const turn = this.row("SELECT t.id, t.status FROM turns t JOIN builds b ON b.id=t.build_id WHERE b.branch=? AND t.status IN ('queued','running') ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.rowid LIMIT 1", `chief:${topicId}`);
    return { activity: turn ? turn.status as "queued" | "running" : "idle", activeTurnId: turn ? String(turn.id) : null };
  }

  rows(sql: string, ...params: unknown[]): Row[] { return this.raw.prepare(sql).all(...params as SqlValue[]) as Row[]; }
  row(sql: string, ...params: unknown[]): Row | undefined { return this.raw.prepare(sql).get(...params as SqlValue[]) as Row | undefined; }
  run(sql: string, ...params: unknown[]): void { this.raw.prepare(sql).run(...params as SqlValue[]); }
  transaction<T>(operation: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.raw.exec("COMMIT"); return result; }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
}
