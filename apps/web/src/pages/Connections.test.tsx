import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ConnectionsPage } from "./Connections";
import { AgentPage } from "./Agent";
const ids = { task: "00000000-0000-4000-8000-000000000001", project: "00000000-0000-4000-8000-000000000002", agent: "00000000-0000-4000-8000-000000000003" };
const connection = { id: "connection", identifier: "linear", name: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", catalogId: "linear", secretKeys: ["Authorization"], args: [] };
beforeEach(() => { Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(element: React.ReactNode, data: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => Response.json({ data: init?.method && init.method !== "GET" ? url.endsWith("/test") ? { ok: true, toolCount: 1, tools: ["find_issue"] } : {} : data[url] ?? ({ "/api/todos": [{ id: ids.task, number: 1, title: "Repeat me", projectId: ids.project }], "/api/projects": [{ id: ids.project, name: "项目" }], "/api/agents": [], "/api/machines": [{ id: ids.agent, name: "Online machine", online: true }], "/api/connections": [] } as Record<string, unknown>)[url] ?? [] }));
  vi.stubGlobal("fetch", fetcher); render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>); return { user: userEvent.setup(), fetcher };
}
it("filters catalog and explains OAuth without a connect action", async () => {
  const { user } = setup(<ConnectionsPage />); await screen.findByRole("button", { name: /Linear/ }); await user.click(screen.getByRole("tab", { name: "文档" })); expect(screen.queryByRole("button", { name: /Linear/ })).not.toBeInTheDocument(); await user.click(screen.getByRole("button", { name: /Notion/ })); const dialog = screen.getByRole("dialog"); expect(within(dialog).getByText(/暂不支持 OAuth 登录/)).toBeInTheDocument(); expect(within(dialog).queryByRole("button", { name: "连接" })).not.toBeInTheDocument();
});
it("shows connected details and inline test results without returning saved values", async () => {
  const { user, fetcher } = setup(<ConnectionsPage />, { "/api/connections": [connection] }); await user.click(await screen.findByRole("button", { name: /Linear/ })); await user.click(screen.getByRole("button", { name: "测试连接" })); expect(await screen.findByRole("status")).toHaveTextContent("连接成功 · 1 个工具"); expect(fetcher).toHaveBeenCalledWith("/api/connections/connection/test", expect.objectContaining({ method: "POST" })); await user.click(screen.getByRole("button", { name: "编辑" })); expect(screen.getByLabelText(/API 令牌/)).toHaveValue("");
});
it("validates custom identifiers, supports secret rows and stdio machine selection", async () => {
  const { user } = setup(<ConnectionsPage />); await user.click(screen.getByRole("button", { name: "自定义连接" })); await user.type(screen.getByLabelText("名称"), "Example"); expect(screen.getByLabelText(/标识符/)).toHaveValue("example"); await user.clear(screen.getByLabelText(/标识符/)); await user.type(screen.getByLabelText(/标识符/), "muster"); await user.type(screen.getByLabelText("服务器 URL"), "https://example.test/mcp"); expect(screen.getByRole("button", { name: "连接" })).toBeDisabled(); await user.clear(screen.getByLabelText(/标识符/)); await user.type(screen.getByLabelText(/标识符/), "example"); expect(screen.getByRole("button", { name: "连接" })).toBeEnabled(); await user.click(screen.getByRole("button", { name: "添加值" })); expect(screen.getByLabelText("密钥值 1")).toHaveAttribute("type", "password"); await user.click(screen.getByRole("tab", { name: "本地命令" })); expect(screen.getByLabelText("命令")).toBeInTheDocument(); expect(screen.getByLabelText("机器")).toBeInTheDocument();
});
it("grants an existing connection on the agent page", async () => {
  const { user, fetcher } = setup(<Routes><Route path="*" element={<AgentPage />} /></Routes>, { "/api/connections": [connection], "/api/agents/": { id: ids.agent, name: "Atlas", role: "Builder", runtime: "mock", model: "mock", inProgress: [], workspaces: [], connectionIds: [], createdAt: "2026-01-01T00:00:00Z", skillCount: 0 } });
  await user.selectOptions(await screen.findByLabelText("添加连接"), "connection"); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/agents/", expect.objectContaining({ method: "PATCH", body: '{"connectionIds":["connection"]}' })));
});
