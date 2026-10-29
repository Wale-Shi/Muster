import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import { createTodo, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

function setup(): Hono {
  const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false });
  databases.push(services.db);
  return app;
}

describe("todo routes", () => {
  it("reports unknown agent and topic references as 422 instead of an in-use conflict", async () => {
    const app = setup(); const { projectId, agentId } = await seedProjectAndAgent(app);
    const base = { projectId, title: "Bad references", spec: "", mode: "plan" as const };
    for (const [input, error] of [
      [{ ...base, agentId: "missing" }, "Agent not found"],
      [{ ...base, planAgentId: "missing" }, "Agent not found"],
      [{ ...base, topicId: "missing" }, "Topic not found"],
    ] as const) {
      const { response, json } = await requestJson(app, "/api/todos", "POST", input);
      expect(response.status).toBe(422); expect(json).toEqual({ error });
    }
    expect((await requestJson(app, "/api/todos")).json.data).toEqual([]);

    const todoId = await createTodo(app, projectId, agentId);
    for (const input of [{ agentId: "missing" }, { planAgentId: "missing" }]) {
      const { response, json } = await requestJson(app, `/api/todos/${todoId}`, "PATCH", input);
      expect(response.status).toBe(422); expect(json).toEqual({ error: "Agent not found" });
    }
    const untouched = (await requestJson(app, `/api/todos/${todoId}`)).json.data;
    expect(untouched).toMatchObject({ agentId, planAgentId: null, title: "Test todo" });
  });

  it("stops a queued turn that no machine has claimed", async () => {
    const app = setup(); const { projectId, agentId } = await seedProjectAndAgent(app);
    const todoId = await createTodo(app, projectId, agentId, "run");
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", { mode: "run" });
    expect((await requestJson(app, `/api/todos/${todoId}`)).json.data.phase).toBe("queued");

    expect((await requestJson(app, `/api/todos/${todoId}/stop`, "POST", {})).response.status).toBe(202);
    const stopped = (await requestJson(app, `/api/todos/${todoId}`)).json.data;
    expect(stopped.phase).toBe("failed");
    expect(stopped.builds.at(-1).turns.at(-1)).toMatchObject({ status: "stopped", error: "Stopped before claim" });
  });
});
