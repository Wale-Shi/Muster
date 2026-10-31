import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workspaceSettingsSchema } from "@muster/shared";
import { SettingsPage, clientSnippets } from "./Settings";
import { WorkspaceDialog, WorkspaceSettingsPage } from "./Workspaces";
import { NewTaskDialog } from "../components/NewTaskDialog";

const workspace = { id: "p", name: "Studio", repoUrl: "/tmp/repo", baseBranch: "main", chiefAgentId: null, topicId: "topic", description: "", createdAt: "2026-01-01" };
const agents = [{ id: "chief", name: "Chief", isChief: true, runtime: "codex" }, { id: "lead", name: "Lead", isChief: false, runtime: "claude" }];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(element: React.ReactNode, path = "/", route = "*") {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => Response.json({ data: init?.method === "POST" ? { id: "created", key: "mst_test" } : init?.method === "PATCH" ? workspace : ({ "/api/settings": workspaceSettingsSchema.parse({}), "/api/api-keys": [], "/api/projects": [workspace], "/api/projects/p": workspace, "/api/agents": agents } as Record<string, unknown>)[url] ?? [] }));
  vi.stubGlobal("fetch", fetcher);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={element} /></Routes></MemoryRouter></QueryClientProvider>);
  return { user: userEvent.setup(), fetcher };
}

it("keeps only general, notification, API key and MCP settings", async () => {
  const { user } = setup(<SettingsPage />);
  expect(await screen.findByLabelText("显示名称")).toHaveValue("Muster");
  expect(within(screen.getByRole("tablist", { name: "设置" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["常规", "通知", "API 密钥", "MCP"]);
  await user.click(screen.getByRole("tab", { name: "通知" })); expect(screen.getByText(/适用于桌面应用/)).toBeInTheDocument(); expect(screen.getByRole("switch", { name: "程序坞角标" })).toBeChecked();
  await user.click(screen.getByRole("tab", { name: "API 密钥" })); expect(screen.getByText("尚无 API 密钥")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "MCP" }));
  expect(screen.getByText(`${location.origin}/api/mcp`)).toBeInTheDocument();
  expect(await screen.findByText(`${location.origin}/api/mcp/workspaces/p`)).toBeInTheDocument();
  expect(screen.getByText("assign_work")).toBeInTheDocument();
});

it("builds client snippets for any MCP endpoint", () => {
  const [claude, codex, json] = clientSnippets("https://host.test/api/mcp/workspaces/p", "muster-studio");
  expect(claude!.content).toBe('claude mcp add --transport http muster-studio https://host.test/api/mcp/workspaces/p --header "Authorization: Bearer <key>"');
  expect(codex!.content).toContain("[mcp_servers.muster_studio]");
  expect(JSON.parse(json!.content).mcpServers["muster-studio"].url).toBe("https://host.test/api/mcp/workspaces/p");
});

it("creates a workspace with its own master agent", async () => {
  const { user, fetcher } = setup(<WorkspaceDialog onClose={() => {}} />);
  await user.type(screen.getByLabelText("名称"), "Shop");
  await user.type(screen.getByLabelText(/仓库/), "/tmp/shop");
  expect(await screen.findByRole("option", { name: "默认（Chief）" })).toBeInTheDocument();
  await user.selectOptions(screen.getByRole("combobox", { name: "Master agent" }), "lead");
  await user.click(screen.getByRole("button", { name: "创建工作空间" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Shop", repoUrl: "/tmp/shop", baseBranch: "main", chiefAgentId: "lead" }) })));
});

it("switches a workspace's master agent and shows its scoped MCP endpoint", async () => {
  const { user, fetcher } = setup(<WorkspaceSettingsPage />, "/w/p/settings", "/w/:id/settings");
  expect(await screen.findByText(`${location.origin}/api/mcp/workspaces/p`)).toBeInTheDocument();
  expect(screen.getByText(/claude mcp add --transport http muster-studio/)).toBeInTheDocument();
  await user.selectOptions(await screen.findByRole("combobox", { name: "Master agent" }), "lead");
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/projects/p", expect.objectContaining({ method: "PATCH", body: '{"chiefAgentId":"lead"}' })));
});

it("creates and starts a task in one request", async () => {
  const { user, fetcher } = setup(<NewTaskDialog initialProjectId="p" onClose={() => {}} />);
  expect(await screen.findByRole("option", { name: "Studio" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /附件|标签/ })).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("任务标题"), "Task");
  fireEvent.keyDown(screen.getByLabelText("任务描述"), { key: "Enter", metaKey: true });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/todos", expect.objectContaining({ body: JSON.stringify({ projectId: "p", agentId: null, title: "Task", spec: "", start: true }) })));
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/start"))).toBe(false);
});
