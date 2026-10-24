import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Agent, Project, Todo, TurnJob } from "@muster/shared";
import type { RuntimeContext } from "./types.js";

// Uses the exact authenticated MCP endpoint used by real runtimes. No REST shortcut.
export async function splitChief(job: TurnJob, ctx: RuntimeContext): Promise<string> {
  const client = new Client({ name: "muster-mock-chief", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(job.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${job.mcp.token}` } } });
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const callId = crypto.randomUUID();
    ctx.emit({ type: "tool.started", tool: name, callId, input: args });
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(JSON.stringify(response.content));
    const value = (response.structuredContent as { result: T }).result;
    ctx.emit({ type: "tool.completed", tool: name, callId, output: value });
    return value;
  };
  try {
    await client.connect(transport);
    const project = (await call<Project[]>("list_projects"))[0];
    const agent = (await call<Agent[]>("list_agents")).find((item) => !item.isChief && item.runtime === "mock");
    if (!project || !agent) throw new Error("/split needs a project and a mock coding agent");
    const created: Todo[] = [];
    for (const part of [1, 2]) {
      const todo = await call<Todo>("create_todo", { projectId: project.id, agentId: agent.id, title: `${job.prompt.slice(6).trim() || "Mock task"} — part ${part}`, spec: `Implement independent part ${part}.`, mode: "run" });
      await call("start_todo", { todoId: todo.id, mode: "run" });
      created.push(todo);
    }
    return `Started ${created.map((todo) => `#${todo.number}`).join(" and ")} in parallel.`;
  } finally { await client.close(); }
}
