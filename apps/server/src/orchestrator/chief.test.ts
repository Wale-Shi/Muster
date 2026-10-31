import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { Orchestrator } from "./state.js";
import { createTodo, requestJson, seedProjectAndAgent } from "../test/helpers.js";

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
  const { projectId, agentId } = await seedProjectAndAgent(app);
  const topicId = orchestrator.topicFor(projectId);
  const first = await createTodo(app, projectId, agentId, "First");
  const second = await createTodo(app, projectId, agentId, "Second");
  const machine = scheduler.enroll("Chief test", ["mock"], 4);
  const notify = (todoId: string, phase: "review" | "done" | "failed") => orchestrator.setPhase(orchestrator.getTodo(todoId), phase);
  const chiefTurns = () => db.rows("SELECT t.* FROM turns t JOIN builds b ON b.id=t.build_id WHERE b.branch=? ORDER BY t.rowid", `chief:${topicId}`);
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  return { ...services, app, projectId, agentId, topicId, first, second, machine, notify, chiefTurns, advance };
}
const notice = (number: number, title: string, phase: string) => new RegExp(`Task #${number} ${title} \\(taskId [^)]+\\) entered ${phase}\\.`);

it("debounces successive notices into one master-agent turn with every notice", async () => {
  const f = await fixture();
  f.notify(f.first, "review");
  f.advance(1000); f.notify(f.second, "failed");
  f.advance(1000); f.notify(f.first, "done");
  expect(f.chiefTurns()).toHaveLength(1);
  expect(f.db.rows("SELECT * FROM messages WHERE conversation_id=? AND role='system'", f.topicId)).toHaveLength(3);
  // The debounce runs from the last notice that needs a follow-up; "done" is only recorded.
  f.advance(1999);
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
  f.advance(1);
  const job = f.scheduler.claim(f.machine.token)!;
  expect(job.task).toBeUndefined();
  expect(job.prompt).toMatch(/^Automatic follow-up:/);
  expect(job.prompt).toMatch(notice(1, "First", "review"));
  expect(job.prompt).toMatch(notice(2, "Second", "failed"));
  expect(job.prompt).not.toMatch(notice(1, "First", "done"));
  expect(job.systemInstructions).toContain("only what changed since your last message");
  expect(job.systemInstructions).toContain(`workspaceId ${f.projectId}`);
  f.scheduler.complete(f.machine.token, job.turnId, { status: "done" });
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
});

it("does not wake the master agent for tasks that are done", async () => {
  const f = await fixture();
  f.notify(f.first, "done");
  expect(f.chiefTurns()).toHaveLength(0);
  expect(f.db.rows("SELECT * FROM messages WHERE conversation_id=? AND role='system'", f.topicId)).toHaveLength(1);
});

it.each(["done", "failed", "stopped"] as const)("accumulates only one successor while the master agent runs, including when it ends %s", async (status) => {
  const f = await fixture();
  f.notify(f.first, "review"); f.advance(3000);
  const running = f.scheduler.claim(f.machine.token)!;
  f.notify(f.first, "failed"); f.advance(1000);
  f.notify(f.second, "review");
  expect(f.chiefTurns().map((turn) => turn.status)).toEqual(["running", "queued"]);
  expect(f.db.row("SELECT prompt FROM turns WHERE id=?", running.turnId)!.prompt).toBe(running.prompt);
  f.advance(3000);
  const other = f.scheduler.enroll("Other", ["mock"], 4);
  expect(f.scheduler.claim(other.token)).toBeNull();
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
  f.scheduler.complete(f.machine.token, running.turnId, { status });
  const next = f.scheduler.claim(f.machine.token)!;
  expect(next.prompt).toMatch(notice(1, "First", "failed"));
  expect(next.prompt).not.toMatch(notice(1, "First", "review"));
  expect(next.prompt).toMatch(notice(2, "Second", "review"));
  f.scheduler.complete(f.machine.token, next.turnId, { status: "done" });
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
});

it("routes each workspace's notices to its own master agent", async () => {
  const f = await fixture();
  const lead = (await requestJson(f.app, "/api/agents", "POST", { name: "Lead", role: "Lead the second workspace.", runtime: "mock", model: "mock" })).json.data;
  const workspace = (await requestJson(f.app, "/api/projects", "POST", { name: "Second", repoUrl: "/tmp/second", baseBranch: "main", chiefAgentId: lead.id })).json.data;
  expect(workspace).toMatchObject({ chiefAgentId: lead.id, topicId: expect.any(String) });
  const otherTask = await createTodo(f.app, workspace.id, f.agentId, "Elsewhere");
  f.notify(f.first, "review");
  f.advance(1000); f.notify(otherTask, "review");
  expect(f.chiefTurns()).toHaveLength(1);
  f.advance(3000);
  const jobs = [f.scheduler.claim(f.machine.token)!, f.scheduler.claim(f.machine.token)!];
  const mine = jobs.find((job) => job.topicId === f.topicId)!;
  const theirs = jobs.find((job) => job.topicId === workspace.topicId)!;
  expect(mine.prompt).toMatch(notice(1, "First", "review"));
  expect(mine.prompt).not.toContain("Elsewhere");
  expect(theirs.prompt).toMatch(notice(3, "Elsewhere", "review"));
  expect(theirs.agent.role).toBe("Lead the second workspace.");
  expect(theirs.systemInstructions).toContain(`workspaceId ${workspace.id}`);
  expect(mine.agent.role).toContain("Coordinate the workspace");
});

it("waits out the successor's debounce even if the running turn finishes sooner", async () => {
  const f = await fixture();
  f.orchestrator.enqueueChief(f.topicId, "Check progress");
  const running = f.scheduler.claim(f.machine.token)!;
  f.notify(f.first, "review");
  f.scheduler.complete(f.machine.token, running.turnId, { status: "done", sessionState: { threadId: "chief-session" } });
  f.advance(2999);
  expect(f.scheduler.claim(f.machine.token)).toBeNull();
  f.advance(1);
  expect(f.scheduler.claim(f.machine.token)).toMatchObject({ topicId: f.topicId, sessionState: { threadId: "chief-session" } });
});

it("merges notices into an already queued user turn without delaying it", async () => {
  const f = await fixture();
  const manual = f.orchestrator.enqueueChief(f.topicId, "What needs attention?");
  f.notify(f.first, "review"); f.notify(f.second, "failed");
  expect(f.chiefTurns()).toHaveLength(1);
  const job = f.scheduler.claim(f.machine.token)!;
  expect(job.turnId).toBe(manual);
  expect(job.prompt).toContain("What needs attention?");
  expect(job.prompt).toMatch(notice(1, "First", "review"));
  expect(job.prompt).toMatch(notice(2, "Second", "failed"));
});

it("persists pending batches and their debounce across a server restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "muster-chief-")); roots.push(root);
  const databasePath = join(root, "test.db");
  const f = await fixture({ databasePath });
  f.notify(f.first, "review"); f.advance(1000);
  f.db.close(); databases.delete(f.db);
  const { services } = createApp({ databasePath, claimWaitMs: 0 }); databases.add(services.db);
  services.orchestrator.setPhase(services.orchestrator.getTodo(f.second), "failed");
  expect(services.db.rows("SELECT * FROM turns WHERE status='queued'")).toHaveLength(1);
  f.advance(2999); expect(services.scheduler.claim(f.machine.token)).toBeNull();
  f.advance(1);
  const job = services.scheduler.claim(f.machine.token)!;
  expect(job.prompt).toMatch(notice(1, "First", "review"));
  expect(job.prompt).toMatch(notice(2, "Second", "failed"));
});

it("keeps notices without automatic turns when follow-up is disabled", async () => {
  const f = await fixture({ autoFollowUp: false });
  f.notify(f.first, "review");
  expect(f.chiefTurns()).toHaveLength(0);
  const enabled = new Orchestrator(f.db, f.events, "http://localhost", true);
  enabled.setPhase(enabled.getTodo(f.second), "review");
  expect(f.chiefTurns()).toHaveLength(1);
  expect(f.db.rows("SELECT * FROM messages WHERE conversation_id=?", f.topicId)).toHaveLength(2);
});
