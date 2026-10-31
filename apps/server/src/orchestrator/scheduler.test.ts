import { afterEach, describe, expect, it } from "vitest";
import type { TurnJob } from "@muster/shared";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("scheduler", () => {
  it("keeps resumed system instructions stable and puts the current instruction first in every task prompt", async () => {
    const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId);
    const { orchestrator, scheduler } = services;
    const claim = () => scheduler.claim(machine.token)!;
    const finish = (job: TurnJob, extra = {}) => scheduler.complete(machine.token, job.turnId, { status: "done", sessionState: { threadId: "same-thread" }, ...extra });
    orchestrator.start(todoId); const build = claim();
    expect(build.prompt).toMatch(/^Implement the task below completely\./);
    expect(orchestrator.getTodo(todoId).phase).toBe("building");
    finish(build, { diff: "changes" });
    expect(orchestrator.getTodo(todoId).phase).toBe("review");
    orchestrator.message(todoId, "Fix an edge case"); const revision = claim();
    expect(revision.prompt).toMatch(/^Address the feedback on your implementation/);
    expect(revision.prompt).toContain("Fix an edge case");
    finish(revision, { diff: "revised changes" });
    expect(orchestrator.getTodo(todoId).phase).toBe("review");
    orchestrator.done(todoId, true); const merge = claim();
    expect(merge.prompt).toMatch(/^Merging the build branch into the base branch is authorized\./);
    for (const job of [build, revision, merge]) {
      expect(job.task).toEqual({ number: 1, title: "Test todo", summary: "Implement the test", url: `http://127.0.0.1:7420/todos/${todoId}` });
      expect(job.systemInstructions).toBe(build.systemInstructions);
      expect(job.systemInstructions).toContain("Test agent");
      expect(job.systemInstructions).toContain("overrides any earlier instruction");
      expect(job.systemInstructions).toContain("Muster MCP tools");
    }
    for (const job of [revision, merge]) expect(job.sessionState).toEqual({ threadId: "same-thread" });
  });

  it.each(["build", "revise"] as const)("makes an empty %s diff visible at Review exactly once", async (kind) => {
    const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId);
    const { orchestrator, scheduler, db, events } = services;
    orchestrator.start(todoId); let job = scheduler.claim(machine.token)!;
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
    { status: "failed", diff: "" },
    { status: "done", diff: "actual changes" },
    { status: "done", diff: undefined },
  ] as const)("does not report an empty build for $status/$diff", async ({ status, diff }) => {
    const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId);
    services.orchestrator.start(todoId); const job = services.scheduler.claim(machine.token)!;
    services.scheduler.complete(machine.token, job.turnId, { status, diff });
    expect(services.db.rows("SELECT * FROM messages WHERE conversation_id=? AND role='system'", job.buildId)).toEqual([]);
  });

  it("respects machine concurrency", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app, 1);
    const first = await createTodo(app, projectId, agentId, "First"); const second = await createTodo(app, projectId, agentId, "Second");
    await requestJson(app, `/api/todos/${first}/start`, "POST", {}); await requestJson(app, `/api/todos/${second}/start`, "POST", {});
    const claim1 = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    expect(claim1).not.toBeNull();
    expect((await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json).toBeNull();
    await requestJson(app, `/api/machine/turns/${claim1.turnId}/complete`, "POST", { status: "done" }, machine.token);
    expect((await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json.todoId).toBe(second);
  });

  it("fails turns assigned to a machine with no heartbeat for 30 seconds", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
    const job = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    services.db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", machine.machineId);
    services.scheduler.failOfflineMachines();
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("failed");
    expect(services.db.row("SELECT status, error FROM turns WHERE id = ?", job.turnId)).toMatchObject({ status: "failed", error: "Machine went offline: no heartbeat for 30 seconds." });
  });
});


it("snapshots task metadata on claim and refreshes it only for the next turn", async () => {
  const { app, services } = createApp({ publicUrl: "https://muster.example/team/", autoFollowUp: false }); databases.push(services.db);
  const { projectId, agentId } = await seedProjectAndAgent(app); const machine = await enroll(app);
  const todoId = await createTodo(app, projectId, agentId);
  const { db, scheduler, orchestrator } = services;
  db.run("UPDATE todos SET spec=? WHERE id=?", "First paragraph\ncontinued\n\nSecond paragraph", todoId);
  orchestrator.start(todoId);
  const first = scheduler.claim(machine.token, "same-request")!;
  expect(first.task).toEqual({ number: 1, title: "Test todo", summary: "First paragraph continued", url: `https://muster.example/team/todos/${todoId}` });
  db.run("UPDATE todos SET title=?, spec='' WHERE id=?", "Updated title", todoId);
  orchestrator.publicUrl = "";
  expect(scheduler.claim(machine.token, "same-request")).toEqual(first);
  scheduler.complete(machine.token, first.turnId, { status: "done" });
  orchestrator.message(todoId, "Revise");
  expect(scheduler.claim(machine.token)!.task).toEqual({ number: 1, title: "Updated title", summary: "Updated title", url: `/todos/${todoId}` });
});
