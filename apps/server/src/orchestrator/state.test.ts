import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("todo state machine", () => {
  it("runs through building, review, done and reopen", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app);
    const todoId = await createTodo(app, projectId, agentId);
    const machine = await enroll(app);

    expect((await requestJson(app, `/api/todos/${todoId}/start`, "POST", {})).response.status).toBe(202);
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("queued");
    const claim = await requestJson(app, "/api/machine/claim", "POST", {}, machine.token);
    expect(claim.json.kind).toBe("build");
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("building");
    await requestJson(app, `/api/machine/turns/${claim.json.turnId}/complete`, "POST", { status: "done", diff: "diff --git a/a b/a", usage: { tokensIn: 3, tokensOut: 4, durationMs: 5 } }, machine.token);
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("review");
    await requestJson(app, `/api/todos/${todoId}/done`, "POST", { merge: false });
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("done");
    await requestJson(app, `/api/todos/${todoId}/reopen`, "POST", {});
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("review");
  });

  it("queues a revise turn when feedback arrives at review and merges to done", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const todoId = await createTodo(app, projectId, agentId); const machine = await enroll(app);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
    const build = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    expect(build.kind).toBe("build");
    await requestJson(app, `/api/machine/turns/${build.turnId}/complete`, "POST", { status: "done", diff: "diff" }, machine.token);
    const feedback = await requestJson(app, `/api/todos/${todoId}/message`, "POST", { content: "Add tests" });
    expect(feedback.json.data.queued).toBe(false);
    const revised = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    expect(revised.kind).toBe("revise");
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("building");
    await requestJson(app, `/api/machine/turns/${revised.turnId}/complete`, "POST", { status: "done", diff: "diff v2" }, machine.token);
    await requestJson(app, `/api/todos/${todoId}/done`, "POST", { merge: true });
    const merge = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    expect(merge.kind).toBe("merge");
    await requestJson(app, `/api/machine/turns/${merge.turnId}/complete`, "POST", { status: "done", merge: { ok: true } }, machine.token);
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("done");
  });

  it("creates and starts a task in one request", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app);
    const created = (await requestJson(app, "/api/todos", "POST", { projectId, title: "Now", agentId, start: true })).json.data;
    expect(created).toMatchObject({ phase: "queued", topicId: services.orchestrator.topicFor(projectId) });
  });

  it("stops queued work when closed and reopens backlog work to todo", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const todoId = await createTodo(app, projectId, agentId); const machine = await enroll(app);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
    await requestJson(app, `/api/todos/${todoId}/close`, "POST", {});
    expect((await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json).toBeNull();
    await requestJson(app, `/api/todos/${todoId}/reopen`, "POST", {});
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("todo");
  });
});
