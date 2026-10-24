import type { Hono } from "hono";

export async function requestJson(app: Hono, path: string, method = "GET", value?: unknown, token?: string, extraHeaders?: HeadersInit): Promise<{ response: Response; json: any }> {
  const headers = new Headers(extraHeaders);
  if (value !== undefined) headers.set("content-type", "application/json");
  if (path === "/mcp") headers.set("accept", "application/json, text/event-stream");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await app.request(path, { method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

export async function seedProjectAndAgent(app: Hono): Promise<{ projectId: string; agentId: string }> {
  const project = await requestJson(app, "/api/projects", "POST", { name: "Test", repoUrl: "/tmp/test-repo", baseBranch: "main" });
  const agent = await requestJson(app, "/api/agents", "POST", { name: "Mock", role: "Test agent", runtime: "mock", model: "mock-1" });
  return { projectId: project.json.data.id, agentId: agent.json.data.id };
}

export async function createTodo(app: Hono, projectId: string, agentId: string, mode: "plan" | "run" = "plan", title = "Test todo"): Promise<string> {
  const todo = await requestJson(app, "/api/todos", "POST", { projectId, title, spec: "Implement the test", agentId, mode });
  return todo.json.data.id;
}

export async function enroll(app: Hono, concurrency = 1): Promise<{ machineId: string; token: string }> {
  const enrolled = await requestJson(app, "/api/machine/enroll", "POST", { name: "test-machine", runtimes: ["mock"], concurrency });
  return enrolled.json;
}
