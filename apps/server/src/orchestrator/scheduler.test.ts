import { afterEach, describe, expect, it } from "vitest";
import type { TurnJob } from "@muster/shared";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("scheduler", () => {
  it("keeps resumed system instructions phase-agnostic and puts current permissions first in every todo prompt", async () => {
    const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId);
    const { orchestrator, scheduler } = services;
    const claim = () => scheduler.claim(machine.token)!;
    const finish = (job: TurnJob, extra = {}) => scheduler.complete(machine.token, job.turnId, { status: "done", sessionState: { threadId: "same-thread" }, ...extra });
    orchestrator.start(todoId, "plan"); const plan = claim();
    expect(plan.prompt).toMatch(/^PHASE: PLAN\. Read and inspect only\. Do not modify repository files\./);
    finish(plan, { plan: "Initial plan" });
    orchestrator.message(todoId, "Cover edge cases"); const confirmRevision = claim();
    expect(confirmRevision.prompt).toMatch(/^PHASE: REVISE-AT-CONFIRM\. Read and inspect only\. Do not modify repository files\./);
    expect(confirmRevision.prompt).toContain("Cover edge cases");
    finish(confirmRevision, { plan: "Confirmed plan including edge cases" });
    orchestrator.confirm(todoId); const build = claim();
    expect(build.prompt).toMatch(/^PHASE: BUILD\. You may and should modify files/);
    expect(build.prompt).toContain("Earlier read-only planning restrictions no longer apply.");
    expect(build.prompt).toContain("Current plan:\nConfirmed plan including edge cases");
    finish(build, { diff: "changes" });
    orchestrator.message(todoId, "Fix an edge case"); const reviewRevision = claim();
    expect(reviewRevision.prompt).toMatch(/^PHASE: REVISE-AT-REVIEW\. You may and should modify files/);
    expect(reviewRevision.prompt).toContain("Fix an edge case");
    finish(reviewRevision, { diff: "revised changes" });
    orchestrator.done(todoId, true); const merge = claim();
    expect(merge.prompt).toMatch(/^PHASE: MERGE\. Merging the build branch/);
    expect(merge.prompt).toContain("now authorized");
    for (const job of [plan, confirmRevision, build, reviewRevision, merge]) {
      expect(job.systemInstructions).toBe(plan.systemInstructions);
      expect(job.systemInstructions).toContain("Test agent");
      expect(job.systemInstructions).toContain("overrides any earlier phase instruction");
      expect(job.systemInstructions).toContain("Muster MCP tools");
      expect(job.systemInstructions).not.toMatch(/Read and inspect only|Do not modify|PHASE:|Implement the accepted task|Merge the build branch/);
    }
    expect([plan.readOnly, confirmRevision.readOnly, build.readOnly, reviewRevision.readOnly, merge.readOnly]).toEqual([true, true, false, false, false]);
    for (const job of [confirmRevision, build, reviewRevision, merge]) expect(job.sessionState).toEqual({ threadId: "same-thread" });
  });

  it.each(["build", "revise"] as const)("makes an empty %s diff visible at Review exactly once", async (kind) => {
    const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId, "run");
    const { orchestrator, scheduler, db, events } = services;
    orchestrator.start(todoId, "run"); let job = scheduler.claim(machine.token)!;
    if (kind === "revise") {
      scheduler.complete(machine.token, job.turnId, { status: "done", diff: "first changes" });
      orchestrator.message(todoId, "Revise implementation"); job = scheduler.claim(machine.token)!;
    }
    const payload = { status: "done" as const, diff: "" };
    scheduler.complete(machine.token, job.turnId, payload);
    scheduler.complete(machine.token, job.turnId, payload); // A lost completion response must not duplicate the notice.
    expect(orchestrator.getTodo(todoId).phase).toBe("review");
    const notices = db.rows("SELECT * FROM messages WHERE turn_id=? AND role='system'", job.turnId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ conversation_id: job.buildId, content: "No file changes in this build" });
    expect(events.replay("0")).toContainEqual(expect.objectContaining({ type: "message.created", conversationId: job.buildId, payload: expect.objectContaining({ role: "system", content: "No file changes in this build" }) }));
    expect(db.rows("SELECT content FROM documents WHERE build_id=? AND kind='changes' ORDER BY rowid DESC LIMIT 1", job.buildId)).toEqual([{ content: "" }]);
    const history = (await requestJson(app, `/api/conversations/${job.buildId}/messages`)).json.data;
    expect(history).toContainEqual(expect.objectContaining({ role: "system", turnId: job.turnId, content: "No file changes in this build" }));
  });

  it.each([
    { mode: "plan", revise: false, status: "done", diff: "" },
    { mode: "plan", revise: true, status: "done", diff: "" },
    { mode: "run", revise: false, status: "failed", diff: "" },
    { mode: "run", revise: false, status: "done", diff: "actual changes" },
    { mode: "run", revise: false, status: "done", diff: undefined },
  ] as const)("does not report an empty build for $mode/$revise/$status/$diff", async ({ mode, revise, status, diff }) => {
    const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId, mode);
    services.orchestrator.start(todoId, mode); let job = services.scheduler.claim(machine.token)!;
    if (revise) {
      services.scheduler.complete(machine.token, job.turnId, { status: "done", plan: "Plan" });
      services.orchestrator.message(todoId, "Revise plan"); job = services.scheduler.claim(machine.token)!;
    }
    services.scheduler.complete(machine.token, job.turnId, { status, diff });
    expect(services.db.rows("SELECT * FROM messages WHERE conversation_id=? AND role='system'", job.buildId)).toEqual([]);
  });

  it("respects machine concurrency", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app, 1);
    const first = await createTodo(app, projectId, agentId, "run", "First"); const second = await createTodo(app, projectId, agentId, "run", "Second");
    await requestJson(app, `/api/todos/${first}/start`, "POST", { mode: "run" }); await requestJson(app, `/api/todos/${second}/start`, "POST", { mode: "run" });
    const claim1 = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    expect(claim1).not.toBeNull();
    expect((await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json).toBeNull();
    await requestJson(app, `/api/machine/turns/${claim1.turnId}/complete`, "POST", { status: "done" }, machine.token);
    expect((await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json.todoId).toBe(second);
  });

  it("fails turns assigned to a machine with no heartbeat for 30 seconds", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId, "run");
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", { mode: "run" });
    const job = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    services.db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", machine.machineId);
    services.scheduler.failOfflineMachines();
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("failed");
    expect(services.db.row("SELECT status, error FROM turns WHERE id = ?", job.turnId)).toMatchObject({ status: "failed", error: "Machine went offline: no heartbeat for 30 seconds." });
  });
});
