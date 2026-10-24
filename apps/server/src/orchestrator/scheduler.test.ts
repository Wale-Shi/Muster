import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("scheduler", () => {
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
