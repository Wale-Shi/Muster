import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentPage } from "./Agent";
import { SkillsPage, NewSkillPage, SkillPage } from "./Skills";
import { MentionInput } from "../components/MentionInput";
import { I18nProvider } from "../i18n";

const agent = { id: "a", name: "Atlas", role: "Build useful things", runtime: "mock", model: "mock", reasoning: null, isChief: false, createdAt: "2026-10-01T00:00:00Z", permissions: { createSkills: false, updateSkills: false }, defaultSkillIds: ["s"], inProgress: [{ id: "todo", number: 1, title: "Build" }], workspaces: [{ id: "w", name: "Shop", baseBranch: "main" }], skillCount: 1 };
const skill = { id: "s", slug: "testing", name: "Testing", description: "Test behavior", source: { type: "folder" }, instructions: "# Test behavior", files: ["SKILL.md"], agents: [agent] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(element: React.ReactNode, path = "/", route = "*", handler?: (path: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const pathname = url.split("?")[0]!; const result = handler?.(url, init);
    if (result instanceof Response) return result;
    const data = result ?? (pathname === "/api/agents/a" ? agent : pathname === "/api/agents" ? [agent] : pathname === "/api/skills" ? [skill] : pathname === "/api/skills/testing" ? skill : pathname === "/api/projects" ? [{ id: "p", name: "项目" }] : []);
    return Response.json({ data });
  }); vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={element} /></Routes></MemoryRouter></I18nProvider></QueryClientProvider>);
  return { user: userEvent.setup(), fetcher };
}
it("shows agent profile sections, the workspaces it leads, saves permissions and shows deletion conflicts inline", async () => {
  const { user, fetcher } = setup(<AgentPage />, "/agents/a", "/agents/:id", (_path, init) => init?.method === "DELETE" ? Response.json({ error: "Agent has running work" }, { status: 409 }) : undefined);
  expect(await screen.findByRole("heading", { name: "默认运行配置" })).toBeInTheDocument(); expect(screen.getByRole("link", { name: "#1 Build" })).toHaveAttribute("href", "/todos/todo");
  expect(screen.getByRole("link", { name: "Shop" })).toHaveAttribute("href", "/w/w");
  expect(screen.queryByRole("tab", { name: /记忆/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole("switch")).toHaveLength(2);
  await user.click(screen.getAllByRole("switch")[0]!); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/agents/a", expect.objectContaining({ method: "PATCH", body: '{"permissions":{"createSkills":true,"updateSkills":false}}' })));
  vi.spyOn(window, "confirm").mockReturnValue(true); await user.click(screen.getByRole("button", { name: "删除 Agent" })); expect(await screen.findByRole("alert")).toHaveTextContent("Agent 有尚未结束的任务");
});
it("links skills to detail pages", async () => { setup(<SkillsPage />); expect(await screen.findByRole("link", { name: /Testing/ })).toHaveAttribute("href", "/skills/testing"); expect(screen.getByRole("link", { name: "新建技能" })).toHaveAttribute("href", "/skills/new"); });
it("renders skill instructions, file list and default users", async () => { setup(<SkillPage />, "/skills/testing", "/skills/:slug"); expect(await screen.findByRole("heading", { name: "Test behavior" })).toBeInTheDocument(); expect(screen.getByRole("heading", { name: "SKILL.md" })).toBeInTheDocument(); expect(screen.getAllByText("SKILL.md")).toHaveLength(2); expect(screen.getByRole("link", { name: "Atlas" })).toHaveAttribute("href", "/agents/a"); });
it("previews GitHub metadata for editing before import", async () => {
  const { user, fetcher } = setup(<NewSkillPage />, "/skills/new", "*", (path) => path.includes("preview") ? [{ name: "Testing", description: "Test behavior", source: { type: "github", url: "https://github.com/org/repo" }, files: [] }] : undefined);
  await user.click(screen.getByRole("tab", { name: "从 GitHub 导入" })); await user.type(screen.getByRole("textbox", { name: /GitHub 地址/ }), "https://github.com/org/repo"); await user.click(screen.getByRole("button", { name: "预览技能" })); expect(await screen.findByRole("textbox", { name: "名称" })).toHaveValue("Testing"); await user.clear(screen.getByRole("textbox", { name: "名称" })); await user.type(screen.getByRole("textbox", { name: "名称" }), "Renamed"); await user.click(screen.getByRole("button", { name: "导入" })); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/skills/import", expect.objectContaining({ body: expect.stringContaining('"name":"Renamed"') })));
});
it("navigates mentions with the keyboard and reports selected agents", async () => {
  const selected = vi.fn(); function Input() { const [value, setValue] = useState(""); return <MentionInput aria-label="Compose" value={value} onValue={setValue} onAgent={selected} />; }
  const { user } = setup(<Input />); await user.type(screen.getByRole("textbox"), "@At"); expect(await screen.findByRole("option", { name: /Atlas/ })).toBeInTheDocument(); await user.keyboard("{Enter}"); expect(screen.getByRole("textbox")).toHaveValue("@atlas "); expect(selected).toHaveBeenCalledWith("a");
  await user.clear(screen.getByRole("textbox")); await user.type(screen.getByRole("textbox"), "@test"); expect(await screen.findByRole("option", { name: /Testing/ })).toBeInTheDocument(); await user.keyboard("{Enter}"); expect(screen.getByRole("textbox")).toHaveValue("@testing ");
});
