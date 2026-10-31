import type {
  Agent,
  Document,
  Machine,
  Message,
  Project,
  Runtime,
  Todo,
  Topic,
  QueuedMessage,
  TodoDetail,
} from "@muster/shared";

export type { TodoDetail } from "@muster/shared";
export type AgentInput = {
  name: string;
  role: string;
  runtime: Runtime;
  model: string;
  reasoning: string | null;
};
export type ProjectInput = Pick<Project, "name" | "repoUrl" | "baseBranch" | "chiefAgentId"> & { description?: string };
export type TodoInput = {
  projectId: string;
  title: string;
  spec: string;
  agentId: string | null;
  start?: boolean;
};
export type TodoAction =
  "start" | "done" | "rerun" | "stop" | "close" | "reopen";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        }),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      json &&
      typeof json === "object" &&
      "error" in json &&
      typeof json.error === "string"
        ? json.error
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  if (!json || typeof json !== "object" || !("data" in json))
    throw new Error("Unexpected server response");
  return json.data as T;
}
const pathId = (id: string) => encodeURIComponent(id);

export const api = {
  projects: () => request<Project[]>("/projects"),
  project: (id: string) => request<Project>(`/projects/${pathId(id)}`),
  createProject: (input: ProjectInput) =>
    request<Project>("/projects", "POST", input),
  updateProject: (id: string, input: Partial<ProjectInput>) =>
    request<Project>(`/projects/${pathId(id)}`, "PATCH", input),
  deleteProject: (id: string) => request<void>(`/projects/${pathId(id)}`, "DELETE"),
  agents: () => request<Agent[]>("/agents"),
  saveAgent: (input: AgentInput, id?: string) =>
    request<Agent>(
      id ? `/agents/${pathId(id)}` : "/agents",
      id ? "PATCH" : "POST",
      input,
    ),
  machines: () => request<Machine[]>("/machines"),
  refreshModels: () => request<{ requested: boolean }>("/machines/refresh-models", "POST", {}),
  todos: () => request<Todo[]>("/todos"),
  todo: (id: string) => request<TodoDetail>(`/todos/${pathId(id)}`),
  createTodo: (input: TodoInput) => request<Todo>("/todos", "POST", input),
  action: (
    id: string,
    action: TodoAction,
    input?: {
      strategy?: "continue" | "restart";
      merge?: boolean;
      agentId?: string;
    },
  ) => request<unknown>(`/todos/${pathId(id)}/${action}`, "POST", input),
  sendTodo: (id: string, content: string) =>
    request<{ queued: boolean; turnId?: string }>(
      `/todos/${pathId(id)}/message`,
      "POST",
      { content },
    ),
  messages: (id: string, signal?: AbortSignal) =>
    request<Message[]>(
      `/conversations/${pathId(id)}/messages`,
      "GET",
      undefined,
      signal,
    ),
  documents: (id: string) =>
    request<Document[]>(`/todos/${pathId(id)}/documents`),
  topic: (id: string) => request<Topic>(`/topics/${pathId(id)}`),
  sendTopic: (id: string, content: string) =>
    request<{ turnId: string }>(`/topics/${pathId(id)}/messages`, "POST", {
      content,
    }),
  queuedMessages: (id: string) => request<QueuedMessage[]>(`/conversations/${pathId(id)}/queued-messages`),
  editQueued: (id: string, messageId: string, content: string) => request(`/conversations/${pathId(id)}/queued-messages/${pathId(messageId)}`, "PATCH", { content }),
  retractQueued: (id: string, messageId: string) => request(`/conversations/${pathId(id)}/queued-messages/${pathId(messageId)}`, "DELETE"),
};
