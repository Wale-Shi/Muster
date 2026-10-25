import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Agent, Build, Document, Todo, Turn } from "@muster/shared";
import { createApp } from "../../server/src/app.js";
import { Daemon } from "../src/daemon.js";
import { MachineClient } from "../src/client.js";
import { MockRuntime } from "../src/runtimes/mock.js";
import { fixture, until } from "./helpers.js";
import { git } from "../src/worktree.js";

type Details = Todo & { builds: Array<Build & { turns: Turn[]; documents: Document[] }> };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(chunkDelay = 3) {
  const f = await fixture();
  cleanup.push(() => rm(f.root, { recursive: true, force: true }));
  const data = join(f.root, "data"); await mkdir(data);
  const serverApp = createApp({ databasePath: join(data, "muster.db"), claimWaitMs: 30, autoFollowUp: false, serveWeb: false });
  const server = serve({ fetch: serverApp.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  serverApp.services.orchestrator.publicUrl = url;
  cleanup.push(async () => { if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); serverApp.services.db.close(); });
  async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(`${url}/api${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as { data: T; error?: string };
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result.data;
  }
  const project = await api<{ id: string }>("/projects", { name: "Fixture", repoUrl: f.origin, baseBranch: "main" });
  const agent = await api<{ id: string }>("/agents", { name: "Mock", role: "Implement", runtime: "mock", model: "mock-1" });
  const client = new MachineClient({ server: url, home: join(f.root, "home"), name: "test", concurrency: 2, runtimes: ["mock"], retryMs: 1 });
  const daemon = new Daemon({ client, workspacesDir: f.ws, log: () => {}, runtimes: { mock: new MockRuntime(chunkDelay) }, heartbeatMs: 30, inboxMs: 10, flushMs: 10 });
  await daemon.start(); cleanup.push(() => daemon.stop());
  const todo = async (title = "Greeting") => api<Todo>("/todos", { projectId: project.id, agentId: agent.id, title, spec: "Write a greeting" });
  const details = (id: string) => api<Details>(`/todos/${id}`);
  const phase = (id: string, target: string) => until(() => details(id), (value) => value.phase === target);
  return { ...f, client, daemon, api, todo, details, phase, services: serverApp.services };
}

describe("daemon against the real M1 HTTP server", () => {
  it("runs plan → confirm → build with steer → review → merge → done", async () => {
    const f = await setup(8); const todo = await f.todo();
    await f.api(`/todos/${todo.id}/start`, { mode: "plan" });
    const planned = await f.phase(todo.id, "confirm");
    const build = planned.builds[0]!;
    expect(build.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(build.documents.find((doc) => doc.kind === "plan")?.content).toContain("# Plan");
    await expect(readFile(join(f.ws, build.id, "MUSTER_MOCK.md"))).rejects.toThrow();
    await f.api(`/todos/${todo.id}/confirm`, {});
    await f.phase(todo.id, "building");
    await f.api(`/todos/${todo.id}/message`, { content: "Include tests" });
    const review = await f.phase(todo.id, "review");
    const changes = review.builds[0]!.documents.find((doc) => doc.kind === "changes");
    expect(changes?.content).toContain("MUSTER_MOCK.md");
    expect(await git(join(f.ws, build.id), "log", "-1", "--format=%B")).toBe(`#${todo.number} ${todo.title}\n\nTurn: 2`);
    const messages = await f.api<Array<{ content: string }>>(`/conversations/${build.id}/messages`);
    expect(messages.some((message) => message.content.includes("Steer: Include tests"))).toBe(true);
    expect(JSON.parse(String(f.services.db.row("SELECT session_state_json FROM turns WHERE id = ?", review.builds[0]!.turns[1]!.id)!.session_state_json))).toMatchObject({ turns: 2 });
    await f.api(`/todos/${todo.id}/done`, { merge: true });
    const done = await f.phase(todo.id, "done");
    expect(done.builds[0]!.turns.map((turn) => turn.status)).toEqual(["done", "done", "done"]);
    expect(await readFile(join(f.origin, "MUSTER_MOCK.md"), "utf8")).toContain("Greeting");
    expect(await git(f.origin, "status", "--porcelain")).toBe("");
    expect((await f.api<{ tokensIn: number }>("/usage")).tokensIn).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(f.root, "home", "machine.json"), "utf8"))).toMatchObject({ machineId: f.client.registration!.machineId });
  });
  it("returns a conflicting merge to review with merge failure details", async () => {
    const f = await setup(); const todo = await f.todo();
    await f.api(`/todos/${todo.id}/start`, { mode: "run" });
    await f.phase(todo.id, "review");
    await writeFile(join(f.origin, "MUSTER_MOCK.md"), "Competing user implementation\n");
    await git(f.origin, "add", "."); await git(f.origin, "commit", "-m", "competing change");
    await f.api(`/todos/${todo.id}/done`, { merge: true });
    const result = await until(() => f.details(todo.id), (value) => value.phase === "review" && value.builds[0]!.turns.some((turn) => turn.kind === "merge" && turn.status === "failed"));
    expect(result.builds[0]!.turns.at(-1)!.error).toContain("CONFLICT");
    expect(await readFile(join(f.origin, "MUSTER_MOCK.md"), "utf8")).toBe("Competing user implementation\n");
  });
  it("runs two builds concurrently and honors heartbeat stop requests", async () => {
    const f = await setup(30); const one = await f.todo("One"); const two = await f.todo("Two");
    await f.api(`/todos/${one.id}/start`, { mode: "run" }); await f.api(`/todos/${two.id}/start`, { mode: "run" });
    await until(async () => f.daemon.running.length, (count) => count === 2);
    await f.phase(one.id, "building"); await f.phase(two.id, "building");
    await f.api(`/todos/${one.id}/stop`, {});
    const failed = await f.phase(one.id, "failed"); expect(failed.builds[0]!.turns[0]!.status).toBe("stopped");
    expect((await f.phase(two.id, "review")).phase).toBe("review");
  });
  it("reports stopped turns on graceful shutdown", async () => {
    const f = await setup(40); const todo = await f.todo();
    await f.api(`/todos/${todo.id}/start`, { mode: "run" }); await f.phase(todo.id, "building");
    await f.daemon.stop();
    expect((await f.details(todo.id)).builds[0]!.turns[0]!.status).toBe("stopped");
  });
  it("runs the installed CLI with MUSTER_HOME, logs, and SIGTERM shutdown", async () => {
    const f = await setup(); await f.daemon.stop();
    const home = join(f.root, "cli-home");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "start", "--server", f.client.options.server], { env: { ...process.env, MUSTER_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    cleanup.push(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await closed; });
    await until(async () => stdout, (text) => text.includes("Machine enrolled"));
    const todo = await f.todo("Long task ".repeat(80));
    await f.api(`/todos/${todo.id}/start`, { mode: "run" }); await f.phase(todo.id, "building");
    child.kill("SIGTERM"); expect(await closed).toBe(0); expect(stderr).toBe("");
    expect((await f.details(todo.id)).builds[0]!.turns[0]!.status).toBe("stopped");
    const logged = await readFile(join(home, "daemon.log"), "utf8");
    expect(logged).toBe(stdout); expect(logged).toContain("Daemon stopped");
    expect(JSON.parse(await readFile(join(home, "running.json"), "utf8"))).toMatchObject({ turns: [] });
  });
  it("resolves Chief topic IDs using M1 conversations and resumes without a project", async () => {
    const f = await setup();
    const chief = (await f.api<Agent[]>("/agents")).find((agent) => agent.isChief)!;
    await f.api(`/agents/${chief.id}`, { runtime: "mock", model: "mock-1" }, "PATCH");
    const topic = await f.api<{ id: string }>("/topics", { title: "Other topic" });
    const run = await f.api<{ turnId: string }>(`/topics/${topic.id}/messages`, { content: "Organize the work" });
    await until(async () => f.services.db.row("SELECT status FROM turns WHERE id = ?", run.turnId), (row) => row?.status === "done");
    expect(await readFile(join(f.root, "home", "chief", topic.id, "MUSTER_MOCK.md"), "utf8").catch(() => "missing")).toBe("missing");
    const next = await f.api<{ turnId: string }>(`/topics/${topic.id}/messages`, { content: "Continue" });
    await until(async () => f.services.db.row("SELECT status, session_state_json FROM turns WHERE id = ?", next.turnId), (row) => row?.status === "done");
    const row = f.services.db.row("SELECT session_state_json FROM turns WHERE id = ?", next.turnId)!;
    expect(JSON.parse(String(row.session_state_json))).toMatchObject({ turns: 2 });
  });
});
