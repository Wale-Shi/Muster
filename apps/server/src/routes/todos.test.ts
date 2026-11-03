import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

function setup(): Hono {
  return setupWithServices().app;
}

function setupWithServices() {
  const created = createApp({ claimWaitMs: 0, autoFollowUp: false });
  databases.push(created.services.db);
  return created;
}

describe("todo routes", () => {
  it("reports unknown workspace and agent references as 422 instead of an in-use conflict", async () => {
    const app = setup(); const { projectId, agentId } = await seedProjectAndAgent(app);
    const base = { projectId, title: "Bad references", spec: "" };
    for (const [input, error] of [
      [{ ...base, agentId: "missing" }, "Agent not found"],
      [{ ...base, projectId: "missing" }, "Workspace not found"],
    ] as const) {
      const { response, json } = await requestJson(app, "/api/todos", "POST", input);
      expect(response.status).toBe(422); expect(json).toEqual({ error });
    }
    expect((await requestJson(app, "/api/todos")).json.data).toEqual([]);

    const todoId = await createTodo(app, projectId, agentId);
    for (const input of [{ agentId: "missing" }]) {
      const { response, json } = await requestJson(app, `/api/todos/${todoId}`, "PATCH", input);
      expect(response.status).toBe(422); expect(json).toEqual({ error: "Agent not found" });
    }
    const untouched = (await requestJson(app, `/api/todos/${todoId}`)).json.data;
    expect(untouched).toMatchObject({ agentId, title: "Test todo" });
  });

  it("stops a queued turn that no machine has claimed", async () => {
    const app = setup(); const { projectId, agentId } = await seedProjectAndAgent(app);
    const todoId = await createTodo(app, projectId, agentId);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("queued");

    expect((await requestJson(app, `/api/todos/${todoId}/stop`, "POST", {})).response.status).toBe(202);
    const stopped = (await requestJson(app, `/api/todos/${todoId}`)).json.data;
    expect(stopped.phase).toBe("failed");
    expect(stopped.builds.at(-1).turns.at(-1)).toMatchObject({ status: "stopped", error: "Stopped before claim" });
  });

  it("shows each turn's runtime session and agent, and totals token use by agent, model and workspace", async () => {
    const { app, services } = setupWithServices(); const { projectId, agentId } = await seedProjectAndAgent(app);
    const machine = await enroll(app);
    const todoId = await createTodo(app, projectId, agentId);
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
    const job = services.scheduler.claim(machine.token)!;
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.builds[0].turns[0]).toMatchObject({ sessionId: null, agent: { name: "Mock", runtime: "mock", model: "mock-1" } });
    await requestJson(app, `/api/machine/turns/${job.turnId}/complete`, "POST", { status: "done", diff: "", usage: { tokensIn: 100, tokensOut: 25, durationMs: 40 }, sessionState: { threadId: "thread-1" } }, machine.token);
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.builds[0].turns[0]).toMatchObject({ sessionId: "thread-1" });

    const usage = (await requestJson(app, "/api/usage?days=7")).json.data;
    expect(usage).toEqual([expect.objectContaining({ agentId, agentName: "Mock", runtime: "mock", model: "mock-1", projectId, tokensIn: 100, tokensOut: 25, durationMs: 40, turns: 1 })]);
  });
});
