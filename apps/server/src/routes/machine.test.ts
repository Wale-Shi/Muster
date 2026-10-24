import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe("machine protocol", () => {
  it("accepts and broadcasts warnings without turning them into status or conversation messages", async () => {
    const { app, services } = createApp({ claimWaitMs: 0 }); databases.push(services.db);
    const { projectId, agentId } = await seedProjectAndAgent(app);
    const todoId = await createTodo(app, projectId, agentId); const machine = await enroll(app);
    services.orchestrator.start(todoId, "plan");
    const job = services.scheduler.claim(machine.token)!;
    const warning = { type: "warning", detail: "Selected model is at capacity." };
    const body = { batchId: "warning-batch", events: [warning] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await requestJson(app, `/api/machine/turns/${job.turnId}/events`, "POST", body, machine.token);
      expect(response.response.status).toBe(200);
      expect(response.json).toEqual({ accepted: 1 });
    }
    const events = services.events.replay("0");
    expect(events.filter((event) => event.type === "warning")).toEqual([
      expect.objectContaining({ conversationId: job.buildId, turnId: job.turnId, payload: warning }),
    ]);
    expect(events.some((event) => event.type === "status")).toBe(false);
    expect(services.db.rows("SELECT * FROM messages WHERE conversation_id=?", job.buildId)).toHaveLength(0);
    expect(services.db.row("SELECT status FROM turns WHERE id=?", job.turnId)?.status).toBe("running");
  });
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

it("releases an assigned claim when the socket closes before the response is sent", async () => {
  const { app, services } = createApp({ claimWaitMs: 25_000 }); databases.push(services.db);
  const { projectId, agentId } = await seedProjectAndAgent(app);
  const todoId = await createTodo(app, projectId, agentId);
  const machine = await enroll(app);
  let responseReady!: () => void;
  const ready = new Promise<void>((resolve) => { responseReady = resolve; });
  let finishResponse!: () => void;
  const hold = new Promise<void>((resolve) => { finishResponse = resolve; });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async (request, env) => {
    const response = await app.fetch(request, env);
    responseReady();
    await hold;
    return response;
  } });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const abort = new AbortController();
  const pending = fetch(`http://127.0.0.1:${address.port}/api/machine/claim`, {
    method: "POST", headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "aborted-claim" }), signal: abort.signal,
  }).catch(() => null);
  try {
    // Start with an idle long poll, then assign a turn on its next scheduler pass.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await requestJson(app, `/api/todos/${todoId}/start`, "POST", { mode: "plan" });
    await ready;
    expect(services.db.row("SELECT status FROM turns")?.status).toBe("running");
    abort.abort(); await pending;
    await vi.waitFor(() => expect(services.db.row("SELECT status, machine_id FROM turns")).toMatchObject({ status: "queued", machine_id: null }));
    expect(services.db.rows("SELECT * FROM mcp_tokens")).toHaveLength(0);
    expect(services.db.rows("SELECT * FROM machine_claims")).toHaveLength(0);
    expect(services.db.row("SELECT machine_id FROM builds")?.machine_id).toBeNull();
    expect(services.orchestrator.getTodo(todoId).phase).toBe("queued");
    const other = services.scheduler.enroll("other", ["mock"], 1);
    expect(services.scheduler.claim(other.token)?.todoId).toBe(todoId);
  } finally {
    abort.abort(); finishResponse(); await pending;
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("does not assign work after a pending long poll is aborted", async () => {
  const { app, services } = createApp({ claimWaitMs: 25_000 }); databases.push(services.db);
  const { projectId, agentId } = await seedProjectAndAgent(app);
  const todoId = await createTodo(app, projectId, agentId);
  const machine = await enroll(app);
  const abort = new AbortController();
  const pending = app.request("/api/machine/claim", {
    method: "POST", headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" }, body: "{}", signal: abort.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  await requestJson(app, `/api/todos/${todoId}/start`, "POST", { mode: "plan" });
  expect(await (await pending).json()).toBeNull();
  expect(services.db.row("SELECT status, machine_id FROM turns")).toMatchObject({ status: "queued", machine_id: null });
});
