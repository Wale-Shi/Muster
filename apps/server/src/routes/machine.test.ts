import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("machine protocol", () => {
  it("enrolls, claims, persists events, completes and advances phase", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app); const todoId = await createTodo(app, projectId, agentId); const machine = await enroll(app);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", { mode: "plan" });
    const job = (await requestJson(app, "/api/machine/claim", "POST", {}, machine.token)).json;
    expect(job).toMatchObject({ todoId, kind: "plan", readOnly: true, branch: expect.stringMatching(/^muster\/conv-/), agent: { runtime: "mock" } });
    await requestJson(app, `/api/todos/${todoId}/message`, "POST", { content: "Include edge cases" });
    expect((await requestJson(app, `/api/machine/turns/${job.turnId}/inbox`, "GET", undefined, machine.token)).json).toEqual([expect.objectContaining({ content: "Include edge cases" })]);
    const pending = (await requestJson(app, `/api/machine/turns/${job.turnId}/inbox`, "GET", undefined, machine.token)).json;
    expect(pending).toHaveLength(1);
    await requestJson(app, `/api/machine/turns/${job.turnId}/inbox/ack`, "POST", { ids: [pending[0].id] }, machine.token);
    expect((await requestJson(app, `/api/machine/turns/${job.turnId}/inbox`, "GET", undefined, machine.token)).json).toEqual([]);
    const events = await requestJson(app, `/api/machine/turns/${job.turnId}/events`, "POST", { batchId: "events-1", events: [{ type: "message.delta", content: "Plan " }, { type: "message.delta", content: "it" }, { type: "message.completed" }, { type: "tool.started", tool: "read" }, { type: "tool.completed", tool: "read", output: "ok" }] }, machine.token);
    expect(events.json.accepted).toBe(5);
    await requestJson(app, `/api/machine/turns/${job.turnId}/complete`, "POST", { status: "done", plan: "1. Implement\n2. Test", usage: { tokensIn: 10, tokensOut: 20, durationMs: 30 }, sessionState: { sessionId: "s1" } }, machine.token);
    const todo = (await requestJson(app, `/api/todos/${todoId}`)).json.data;
    expect(todo.phase).toBe("confirm");
    expect(todo.builds[0].documents).toEqual([expect.objectContaining({ kind: "plan", version: 1, content: "1. Implement\n2. Test" })]);
    const messages = (await requestJson(app, `/api/conversations/${job.buildId}/messages`)).json.data;
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "agent", content: "Plan it" }), expect.objectContaining({ role: "tool" })]));
  });
});
