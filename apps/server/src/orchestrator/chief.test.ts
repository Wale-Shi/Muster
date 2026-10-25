import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { Orchestrator } from "./state.js";
import { createTodo, seedProjectAndAgent } from "../test/helpers.js";

const databases = new Set<ReturnType<typeof createApp>["services"]["db"]>();
const roots: string[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function fixture(options: Parameters<typeof createApp>[0] = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
  const { app, services } = createApp({ claimWaitMs: 0, ...options });
  databases.add(services.db);
  const { db, orchestrator, scheduler } = services;
  db.run("UPDATE agents SET runtime='mock', model='mock' WHERE is_chief=1");
  const topicId = String(db.row("SELECT id FROM topics LIMIT 1")!.id);
  const { projectId, agentId } = await seedProjectAndAgent(app);
  const first = await createTodo(app, projectId, agentId, "run", "First");
  const second = await createTodo(app, projectId, agentId, "run", "Second");
  db.run("UPDATE todos SET created_by='chief', topic_id=?", topicId);
  const machine = scheduler.enroll("Chief test", ["mock"], 4);
  const notify = (todoId: string, phase: "confirm" | "review" | "done" | "failed") => orchestrator.setPhase(orchestrator.getTodo(todoId), phase);
  const chiefTurns = () => db.rows("SELECT t.* FROM turns t JOIN builds b ON b.id=t.build_id WHERE b.branch=? ORDER BY t.rowid", `chief:${topicId}`);
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  return { ...services, topicId, first, second, machine, notify, chiefTurns, advance };
}

it("debounces successive gates into one Chief turn with every notice", async () => {
  const f = await fixture();
  f.notify(f.first, "done");
  f.advance(1000); f.notify(f.second, "review");
  f.advance(1000); f.notify(f.second, "done");
  expect(f.chiefTurns()).toHaveLength(1);
  expect(f.db.rows("SELECT * FROM messages WHERE conversation_id=? AND role='system'", f.topicId)).toHaveLength(3);
  f.advance(2999);
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
  f.advance(1);
  const job = f.scheduler.claim(f.machine.token)!;
  expect(job.task).toBeUndefined();
  expect(job.prompt).toMatch(/^Automatic follow-up:/);
  expect(job.prompt).toContain("Todo #1 First entered done.");
  expect(job.prompt).toContain("Todo #2 Second entered review.");
  expect(job.prompt).toContain("Todo #2 Second entered done.");
  expect(job.systemInstructions).toContain("only what changed since your last message");
  expect(job.systemInstructions).toContain("single short line");
  f.scheduler.complete(f.machine.token, job.turnId, { status: "done" });
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
});

it.each(["done", "failed", "stopped"] as const)("accumulates only one successor while Chief runs, including when it ends %s", async (status) => {
  const f = await fixture();
  f.notify(f.first, "review"); f.advance(3000);
  const running = f.scheduler.claim(f.machine.token)!;
  f.notify(f.first, "done"); f.advance(1000);
  f.notify(f.second, "review"); f.advance(1000);
  f.notify(f.second, "done");
  expect(f.chiefTurns().map((turn) => turn.status)).toEqual(["running", "queued"]);
  expect(f.db.row("SELECT prompt FROM turns WHERE id=?", running.turnId)!.prompt).toBe(running.prompt);
  f.advance(3000);
  const other = f.scheduler.enroll("Other", ["mock"], 4);
  expect(f.scheduler.claim(other.token)).toBeNull();
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
  f.scheduler.complete(f.machine.token, running.turnId, { status });
  const next = f.scheduler.claim(f.machine.token)!;
  expect(next.prompt).toContain("Todo #1 First entered done.");
  expect(next.prompt).not.toContain("Todo #1 First entered review.");
  expect(next.prompt).toContain("Todo #2 Second entered review.");
  expect(next.prompt).toContain("Todo #2 Second entered done.");
  f.scheduler.complete(f.machine.token, next.turnId, { status: "done" });
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
});

it("keeps topics independent and leaves unrelated work claimable during debounce", async () => {
  const f = await fixture();
  const other = "other-topic";
  f.db.run("INSERT INTO topics VALUES (?, 'Other', NULL, ?, ?)", other, new Date().toISOString(), new Date().toISOString());
  f.db.run("UPDATE todos SET topic_id=? WHERE id=?", other, f.second);
  f.notify(f.first, "review");
  f.advance(1000); f.notify(f.second, "done");
  const manual = f.orchestrator.enqueueChief(other, "User request");
  expect(f.scheduler.claim(f.machine.token)?.turnId).toBe(manual);
  f.advance(2000);
  expect(f.scheduler.claim(f.machine.token)?.topicId).toBe(f.topicId);
});

it("waits out the successor's debounce even if the running turn finishes sooner", async () => {
  const f = await fixture();
  f.orchestrator.enqueueChief(f.topicId, "Check progress");
  const running = f.scheduler.claim(f.machine.token)!;
  f.notify(f.first, "done");
  f.scheduler.complete(f.machine.token, running.turnId, { status: "done", sessionState: { threadId: "chief-session" } });
  f.advance(2999);
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
  f.advance(1);
  expect(f.scheduler.claim(f.machine.token)).toMatchObject({ topicId: f.topicId, sessionState: { threadId: "chief-session" } });
});

it("merges notices into an already queued user turn without delaying it", async () => {
  const f = await fixture();
  const manual = f.orchestrator.enqueueChief(f.topicId, "What needs attention?");
  f.notify(f.first, "confirm"); f.notify(f.second, "failed");
  expect(f.chiefTurns()).toHaveLength(1);
  const job = f.scheduler.claim(f.machine.token)!;
  expect(job.turnId).toBe(manual);
  expect(job.prompt).toContain("What needs attention?");
  expect(job.prompt).toContain("Todo #1 First entered confirm.");
  expect(job.prompt).toContain("Todo #2 Second entered failed.");
});

it("persists pending batches and their debounce across a server restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "muster-chief-")); roots.push(root);
  const databasePath = join(root, "test.db");
  const f = await fixture({ databasePath });
  f.notify(f.first, "done"); f.advance(1000); f.notify(f.second, "review");
  f.db.close(); databases.delete(f.db);
  const { services } = createApp({ databasePath, claimWaitMs: 0 }); databases.add(services.db);
  services.orchestrator.setPhase(services.orchestrator.getTodo(f.second), "done");
  expect(services.db.rows("SELECT * FROM turns WHERE status='queued'")).toHaveLength(1);
  f.advance(2999); expect(services.scheduler.claim(f.machine.token)).toBeNull();
  f.advance(1);
  const job = services.scheduler.claim(f.machine.token)!;
  expect(job.prompt).toContain("Todo #1 First entered done.");
  expect(job.prompt).toContain("Todo #2 Second entered review.");
  expect(job.prompt).toContain("Todo #2 Second entered done.");
});

it("keeps notices without auto turns when disabled or when work was user-created", async () => {
  const f = await fixture({ autoFollowUp: false });
  f.notify(f.first, "done");
  expect(f.chiefTurns()).toHaveLength(0);
  const enabled = new Orchestrator(f.db, f.events, "http://localhost", true);
  f.db.run("UPDATE todos SET created_by='user' WHERE id=?", f.second);
  enabled.setPhase(enabled.getTodo(f.second), "review");
  expect(f.chiefTurns()).toHaveLength(0);
  expect(f.db.rows("SELECT * FROM messages WHERE conversation_id=?", f.topicId)).toHaveLength(2);
});
