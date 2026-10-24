import { afterEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "@muster/shared";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });
async function fixture(concurrency = 3) {
  const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false }); databases.push(services.db);
  const { projectId, agentId } = await seedProjectAndAgent(app);
  const todoId = await createTodo(app, projectId, agentId);
  const machine = await enroll(app, concurrency);
  const api = (path: string, value?: unknown, method = value === undefined ? "GET" : "POST") => requestJson(app, path, method, value);
  const claim = (token = machine.token, requestId?: string) => services.scheduler.claim(token, requestId)!;
  const finish = (turnId: string, payload: Parameters<typeof services.scheduler.complete>[2] = { status: "done" }) => services.scheduler.complete(machine.token, turnId, payload);
  const start = (mode: "run" | "plan" = "run") => services.orchestrator.start(todoId, mode);
  return { app, services, projectId, agentId, todoId, machine, api, claim, finish, start };
}

describe("M4 state regression checks", () => {
  it.each(["run", "plan"] as const)("promotes late %s feedback into exactly one gate revision, including unacknowledged inbox delivery", async (mode) => {
    const f = await fixture(); f.start(mode); const job = f.claim();
    const queue = `/api/conversations/${job.buildId}/queued-messages`;
    const history = `/api/conversations/${job.buildId}/messages`;
    // Successfully accepted feedback must not be repeated in the next prompt.
    f.services.orchestrator.message(f.todoId, "Already delivered");
    const [accepted] = f.services.scheduler.inbox(f.machine.token, job.turnId);
    f.services.scheduler.ackInbox(f.machine.token, job.turnId, [accepted!.id]);
    f.services.orchestrator.message(f.todoId, "Reserved but not acknowledged");
    const [reserved] = f.services.scheduler.inbox(f.machine.token, job.turnId);
    f.services.orchestrator.message(f.todoId, "Arrived after the final inbox poll");
    const originals = (await f.api(history)).json.data;
    expect((await f.api(queue)).json.data).toHaveLength(2);
    const completion = { status: "done" as const, sessionState: { thread: "continue" } };
    f.finish(job.turnId, completion); f.finish(job.turnId, completion); // lost completion response
    expect(f.services.orchestrator.getTodo(f.todoId)).toMatchObject({ phase: "queued", previousGate: mode === "plan" ? "confirm" : "review" });
    expect((await f.api(queue)).json.data).toEqual([]);
    expect(() => f.services.scheduler.ackInbox(f.machine.token, job.turnId, [reserved!.id])).toThrow("Turn is done");
    const revision = f.claim();
    expect(revision).toMatchObject({ buildId: job.buildId, kind: "revise", readOnly: mode === "plan", sessionState: { thread: "continue" } });
    expect(revision.prompt).toContain("Reserved but not acknowledged\n\nArrived after the final inbox poll");
    expect(revision.prompt).not.toContain("Already delivered");
    const messages = (await f.api(history)).json.data;
    expect(messages.map((message: { id: string }) => message.id)).toEqual(originals.map((message: { id: string }) => message.id));
    expect(messages.slice(1).every((message: { turnId: string }) => message.turnId === revision.turnId)).toBe(true);
    expect(f.services.scheduler.inbox(f.machine.token, revision.turnId)).toEqual([]);
    // The same boundary can be hit again during a revise turn.
    f.services.orchestrator.message(f.todoId, "Late revision feedback");
    f.finish(revision.turnId);
    const next = f.claim(); expect(next.kind).toBe("revise"); expect(next.prompt).toContain("Late revision feedback");
    f.finish(next.turnId);
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe(mode === "plan" ? "confirm" : "review");
    expect(f.services.scheduler.claim(f.machine.token)).toBeNull();
    expect(f.services.events.replay("0")).toContainEqual(expect.objectContaining({ type: "message.queue_changed", conversationId: job.buildId }));
  });

  it("keeps pending feedback without automatically restarting failed or closed work", async () => {
    for (const closed of [false, true]) {
      const f = await fixture(); f.start(); const job = f.claim();
      f.services.orchestrator.message(f.todoId, "Keep this feedback");
      f.services.scheduler.inbox(f.machine.token, job.turnId);
      if (closed) f.services.orchestrator.close(f.todoId);
      f.finish(job.turnId, { status: closed ? "done" : "failed" });
      expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe(closed ? "closed" : "failed");
      expect(f.services.scheduler.claim(f.machine.token)).toBeNull();
      expect((await f.api(`/api/conversations/${job.buildId}/queued-messages`)).json.data).toMatchObject([{ content: "Keep this feedback", delivering: false }]);
    }
  });

  it("rejects invalid feedback without creating messages or builds", async () => {
    const f = await fixture();
    expect((await f.api(`/api/todos/${f.todoId}/message`, { content: "invalid" })).response.status).toBe(409);
    expect(f.services.db.rows("SELECT * FROM builds")).toHaveLength(0);
    expect(f.services.db.rows("SELECT * FROM messages")).toHaveLength(0);
  });

  it("revises at both gates and sends the accepted plan to the build agent", async () => {
    const f = await fixture(); f.start("plan"); const plan = f.claim();
    f.finish(plan.turnId, { status: "done", plan: "Initial plan", sessionState: { step: 1 } });
    f.services.orchestrator.message(f.todoId, "Add edge cases");
    const revised = f.claim();
    expect(revised).toMatchObject({ kind: "revise", readOnly: true, sessionState: { step: 1 } });
    expect(revised.systemInstructions).toContain("Do not modify");
    f.finish(revised.turnId, { status: "done", plan: "Accepted plan with edge cases" });
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("confirm");
    f.services.orchestrator.confirm(f.todoId);
    const build = f.claim(); expect(build.prompt).toContain("Accepted plan with edge cases");
    f.finish(build.turnId, { status: "done", diff: "v1" });
    f.services.orchestrator.message(f.todoId, "Fix implementation");
    const revise = f.claim(); expect(revise).toMatchObject({ kind: "revise", readOnly: false });
    f.finish(revise.turnId, { status: "done", diff: "v2" });
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("review");
    expect(f.services.db.rows("SELECT kind,version FROM documents ORDER BY rowid")).toEqual([
      { kind: "plan", version: 1 }, { kind: "plan", version: 2 }, { kind: "changes", version: 1 }, { kind: "changes", version: 2 },
    ]);
  });

  it("continues a failed build but restarts on a fresh branch and session", async () => {
    const f = await fixture(); f.start(); const first = f.claim();
    f.finish(first.turnId, { status: "failed", sessionState: { threadId: "resume" }, error: "test" });
    f.services.orchestrator.rerun(f.todoId, "continue"); const continued = f.claim();
    expect(continued).toMatchObject({ buildId: first.buildId, sessionState: { threadId: "resume" } });
    f.finish(continued.turnId, { status: "failed", sessionState: { threadId: "resume" } });
    f.services.orchestrator.rerun(f.todoId, "restart"); const restarted = f.claim();
    expect(restarted.buildId).not.toBe(first.buildId); expect(restarted.branch).not.toBe(first.branch);
    expect(restarted.sessionState).toBeNull();
  });

  it("never resurrects stale state or resumes an edited model", async () => {
    const f = await fixture(); f.start(); const first = f.claim();
    f.finish(first.turnId, { status: "failed", sessionState: { threadId: "old" } });
    f.services.orchestrator.rerun(f.todoId, "continue"); const second = f.claim();
    f.finish(second.turnId, { status: "failed" });
    f.services.orchestrator.rerun(f.todoId, "continue"); const third = f.claim(); expect(third.sessionState).toBeNull();
    f.finish(third.turnId, { status: "failed", sessionState: { threadId: "different-model" } });
    await f.api(`/api/agents/${f.agentId}`, { model: "edited" }, "PATCH");
    f.services.orchestrator.rerun(f.todoId, "continue"); expect(f.claim().sessionState).toBeNull();
  });

  it("respects close while merge fails, waits for stopping before reopen, and restores gates", async () => {
    const f = await fixture(); f.start(); f.finish(f.claim().turnId);
    f.services.orchestrator.done(f.todoId, true); const merge = f.claim();
    f.services.orchestrator.close(f.todoId);
    expect(() => f.services.orchestrator.reopen(f.todoId)).toThrow("Wait");
    f.finish(merge.turnId, { status: "failed", merge: { ok: false, error: "conflict" } });
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("closed");
    f.services.orchestrator.reopen(f.todoId);
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("review");
    f.services.orchestrator.done(f.todoId, true); f.finish(f.claim().turnId, { status: "done" });
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("review"); // No publication confirmation.
  });

  it("stops queued and running work and does not reopen a closed plan on completion", async () => {
    const f = await fixture(); f.start("plan"); f.services.orchestrator.stop(f.todoId);
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("failed");
    f.services.orchestrator.rerun(f.todoId, "continue"); const plan = f.claim();
    f.services.orchestrator.stop(f.todoId);
    expect(f.services.scheduler.heartbeat(f.machine.token, [plan.turnId]).stop).toContain(plan.turnId);
    f.services.orchestrator.close(f.todoId); f.finish(plan.turnId, { status: "stopped" });
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("closed");
  });
});

describe("M4 machine reliability", () => {
  it("serializes Chief turns across machines and resolves resume state at claim time", async () => {
    const f = await fixture(); const other = await enroll(f.app, 3);
    const chief = f.services.db.row("SELECT id FROM agents WHERE is_chief=1")!;
    await f.api(`/api/agents/${chief.id}`, { runtime: "mock", model: "mock" }, "PATCH");
    const topicId = String(f.services.db.row("SELECT id FROM topics")!.id);
    f.services.orchestrator.enqueueChief(topicId, "first"); f.services.orchestrator.enqueueChief(topicId, "second");
    expect((await f.api(`/api/topics/${topicId}`)).json.data.activity).toBe("queued");
    const first = f.claim(); expect(first.topicId).toBe(topicId);
    expect(f.services.scheduler.claim(f.machine.token)).toBeNull(); expect(f.services.scheduler.claim(other.token)).toBeNull();
    f.finish(first.turnId, { status: "done", sessionState: { turns: 1 } });
    expect((await f.api(`/api/topics/${topicId}`)).json.data.activity).toBe("queued");
    const next = f.claim(); expect(next.sessionState).toEqual({ turns: 1 });
    f.finish(next.turnId);
    expect((await f.api(`/api/topics/${topicId}`)).json.data).toMatchObject({ activity: "idle", activeTurnId: null, runtimeSession: null });
  });

  it("replays a claim with the same token/job and recovers a lost turn on an online machine", async () => {
    const f = await fixture(); f.start(); const first = f.claim(f.machine.token, "request-1");
    expect(f.claim(f.machine.token, "request-1")).toEqual(first);
    f.services.db.run("UPDATE turns SET last_reported_at=? WHERE id=?", "2000-01-01T00:00:00.000Z", first.turnId);
    f.services.scheduler.heartbeat(f.machine.token, []);
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("failed");
    expect(String(f.services.db.row("SELECT error FROM turns WHERE id=?", first.turnId)!.error)).toContain("lost turn");
    expect(f.services.scheduler.claim(f.machine.token, "request-1")).toBeNull();
  });

  it("returns offline merge work to review and emits a terminal conversation event", async () => {
    const f = await fixture(); f.start(); f.finish(f.claim().turnId);
    f.services.orchestrator.done(f.todoId, true); const merge = f.claim();
    const events: ServerEvent[] = []; const off = f.services.events.subscribe((event) => events.push(event));
    f.services.db.run("UPDATE machines SET last_seen_at=? WHERE id=?", "2000-01-01T00:00:00.000Z", f.machine.machineId);
    f.services.scheduler.failOfflineMachines(); off();
    expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("review");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", conversationId: merge.buildId, payload: { turnId: merge.turnId, status: "failed" } }));
  });

  it("deduplicates event uploads and completion, preserving stable message identity and exact usage", async () => {
    const f = await fixture(); f.start(); const job = f.claim();
    const events = [{ type: "message.delta" as const, content: "Hello " }, { type: "message.delta" as const, content: "world" }, { type: "message.completed" as const }];
    f.services.scheduler.ingestEvents(f.machine.token, job.turnId, events, "batch-1");
    f.services.scheduler.ingestEvents(f.machine.token, job.turnId, events, "batch-1");
    expect(() => f.services.scheduler.ingestEvents(f.machine.token, job.turnId, [], "batch-1")).toThrow("different events");
    const messages = (await f.api(`/api/conversations/${job.buildId}/messages`)).json.data;
    expect(messages).toHaveLength(1); expect(messages[0].content).toBe("Hello world");
    const deltas = f.services.events.replay("0").filter((event) => event.type === "message.delta");
    expect(deltas).toHaveLength(2); expect(deltas.every((event) => event.turnId === job.turnId && event.messageId === messages[0].id && event.message?.turnId === job.turnId)).toBe(true);
    const payload = { status: "done" as const, usage: { tokensIn: 3, tokensOut: 4, durationMs: 5 } };
    f.finish(job.turnId, payload); f.finish(job.turnId, payload);
    f.services.scheduler.ingestEvents(f.machine.token, job.turnId, events, "batch-1");
    const usage = (await f.api("/api/usage")).json.data;
    expect(usage).toMatchObject({ tokensIn: 3, tokensOut: 4, durationMs: 5 });
    await f.api(`/api/agents/${f.agentId}`, { name: "Renamed", model: "new-model" }, "PATCH");
    const afterEdit = (await f.api("/api/usage")).json.data;
    expect(afterEdit.entries[0]).toMatchObject({ agentName: "Mock", model: "mock-1", tokensIn: 3 });
    const cutoff = deltas[0]!.id!;
    expect(f.services.events.replay(cutoff).every((event) => Number(event.id) > Number(cutoff))).toBe(true);
  });

  it("lists, edits and retracts queued steer messages and only consumes them after ACK", async () => {
    const f = await fixture(); f.start();
    f.services.orchestrator.message(f.todoId, "before claim"); const job = f.claim();
    const path = `/api/conversations/${job.buildId}/queued-messages`;
    const first = (await f.api(path)).json.data[0];
    expect((await f.api(`${path}/${first.id}`, { content: "edited" }, "PATCH")).response.status).toBe(200);
    f.services.orchestrator.message(f.todoId, "retract me"); const queued = (await f.api(path)).json.data;
    expect((await f.api(`${path}/${queued[1].id}`, undefined, "DELETE")).response.status).toBe(204);
    const history = (await f.api(`/api/conversations/${job.buildId}/messages`)).json.data;
    expect(history.map((message: { content: string }) => message.content)).toEqual(["edited"]);
    const inbox = f.services.scheduler.inbox(f.machine.token, job.turnId);
    expect(inbox).toEqual([{ id: first.id, content: "edited" }]); expect(f.services.scheduler.inbox(f.machine.token, job.turnId)).toEqual(inbox);
    expect((await f.api(`${path}/${first.id}`, { content: "too late" }, "PATCH")).response.status).toBe(409);
    f.services.scheduler.ackInbox(f.machine.token, job.turnId, [first.id]);
    f.services.scheduler.ackInbox(f.machine.token, job.turnId, [first.id]);
    expect(f.services.scheduler.inbox(f.machine.token, job.turnId)).toEqual([]); expect((await f.api(path)).json.data).toEqual([]);
  });
});

it("retries a failed revision with its feedback even when restarting the runtime", async () => {
  const f = await fixture(); f.start("plan"); f.finish(f.claim().turnId, { status: "done", plan: "Original plan" });
  f.services.orchestrator.message(f.todoId, "Keep the required audit trail");
  f.finish(f.claim().turnId, { status: "failed" });
  f.services.orchestrator.rerun(f.todoId, "restart");
  const retry = f.claim();
  expect(retry.readOnly).toBe(true); expect(retry.prompt).toContain("Keep the required audit trail"); expect(retry.sessionState).toBeNull();
  f.finish(retry.turnId, { status: "done", plan: "Revised plan" });
  expect(f.services.orchestrator.getTodo(f.todoId).phase).toBe("confirm");
});
