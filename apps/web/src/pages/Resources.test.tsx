import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentPage } from "./Agent";
import { SkillsPage, NewSkillPage, SkillPage } from "./Skills";
import { SecretsPage, SecretCard } from "./Secrets";
import { MentionInput } from "../components/MentionInput";
import { I18nProvider } from "../i18n";

const agent = { id: "a", name: "Atlas", role: "Build useful things", runtime: "mock", model: "mock", reasoning: null, isChief: false, createdAt: "2026-10-01T00:00:00Z", permissions: { pushBranch: false, secrets: false, createSkills: false, updateSkills: false }, defaultSkillIds: ["s"], inProgress: [{ id: "todo", number: 1, title: "Build" }], memoryCount: 0, skillCount: 1 };
const skill = { id: "s", slug: "testing", name: "Testing", description: "Test behavior", source: { type: "folder" }, instructions: "# Test behavior", files: ["SKILL.md"], agents: [agent] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(element: React.ReactNode, path = "/", route = "*", handler?: (path: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const pathname = url.split("?")[0]!; const result = handler?.(url, init);
    if (result instanceof Response) return result;
    const data = result ?? (pathname === "/api/agents/a" ? agent : pathname === "/api/agents" ? [agent] : pathname === "/api/skills" ? [skill] : pathname === "/api/skills/testing" ? skill : pathname === "/api/projects" ? [{ id: "p", name: "Project" }] : []);
    return Response.json({ data });
  }); vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={element} /></Routes></MemoryRouter></I18nProvider></QueryClientProvider>);
  return { user: userEvent.setup(), fetcher };
}
it("shows agent profile sections, saves permissions, adds memory and shows deletion conflicts inline", async () => {
  const { user, fetcher } = setup(<AgentPage />, "/agents/a", "/agents/:id", (_path, init) => init?.method === "DELETE" ? Response.json({ error: "Agent has running work" }, { status: 409 }) : undefined);
  expect(await screen.findByRole("heading", { name: "Default run configuration" })).toBeInTheDocument(); expect(screen.getByRole("link", { name: "#1 Build" })).toHaveAttribute("href", "/todos/todo");
  await user.click(screen.getByRole("switch", { name: /Team secrets/ })); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/agents/a", expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"secrets":true') })));
  vi.spyOn(window, "confirm").mockReturnValue(true); await user.click(screen.getByRole("button", { name: "Delete agent" })); expect(await screen.findByRole("alert")).toHaveTextContent("Agent has running work");
  await user.click(screen.getByRole("tab", { name: "Memory" })); await user.type(screen.getByRole("textbox", { name: "Add memory" }), "Use small modules"); await user.click(screen.getByRole("button", { name: "Add memory" })); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/agents/a/memories", expect.objectContaining({ method: "POST", body: '{"content":"Use small modules"}' })));
});
it("links skills to detail pages", async () => { setup(<SkillsPage />); expect(await screen.findByRole("link", { name: /Testing/ })).toHaveAttribute("href", "/skills/testing"); expect(screen.getByRole("link", { name: "New skill" })).toHaveAttribute("href", "/skills/new"); });
it("renders skill instructions, file list and default users", async () => { setup(<SkillPage />, "/skills/testing", "/skills/:slug"); expect(await screen.findByRole("heading", { name: "Test behavior" })).toBeInTheDocument(); expect(screen.getByRole("heading", { name: "SKILL.md" })).toBeInTheDocument(); expect(screen.getAllByText("SKILL.md")).toHaveLength(2); expect(screen.getByRole("link", { name: "Atlas" })).toHaveAttribute("href", "/agents/a"); });
it("previews GitHub metadata for editing before import", async () => {
  const { user, fetcher } = setup(<NewSkillPage />, "/skills/new", "*", (path) => path.includes("preview") ? [{ name: "Testing", description: "Test behavior", source: { type: "github", url: "https://github.com/org/repo" }, files: [] }] : undefined);
  await user.click(screen.getByRole("tab", { name: "From GitHub" })); await user.type(screen.getByRole("textbox", { name: /GitHub URL/ }), "https://github.com/org/repo"); await user.click(screen.getByRole("button", { name: "Review skills" })); expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Testing"); await user.clear(screen.getByRole("textbox", { name: "Name" })); await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed"); await user.click(screen.getByRole("button", { name: "Import" })); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/skills/import", expect.objectContaining({ body: expect.stringContaining('"name":"Renamed"') })));
});
it("shows team and project secret sections without values", async () => { setup(<SecretsPage />); expect(await screen.findByRole("heading", { name: "Team secrets" })).toBeInTheDocument(); expect(await screen.findByRole("heading", { name: "Project" })).toBeInTheDocument(); expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(2); expect(screen.getByRole("button", { name: "Add secret" })).toBeInTheDocument(); });
it("saves secure input directly to secrets and clears the password", async () => {
  const { user, fetcher } = setup(<SecretCard message={{ id: "request", conversationId: "topic", turnId: null, role: "system", content: "Access", createdAt: "", meta: { secretRequest: { name: "API_TOKEN", scope: "team", reason: "Access" } } }} />);
  const value = screen.getByLabelText("Value"); expect(value).toHaveAttribute("type", "password"); await user.type(value, "private-fixture"); await user.click(screen.getByRole("button", { name: "Save" })); expect(await screen.findByRole("status")).toHaveTextContent("Secret saved"); expect(screen.queryByLabelText("Value")).not.toBeInTheDocument(); expect(fetcher).toHaveBeenCalledWith("/api/secrets", expect.objectContaining({ method: "PUT", body: expect.stringContaining('"requestId":"request"') })); expect(fetcher.mock.calls.every(([path]) => !path.includes("messages"))).toBe(true);
});
it("navigates mentions with the keyboard and reports selected agents", async () => {
  const selected = vi.fn(); function Input() { const [value, setValue] = useState(""); return <MentionInput aria-label="Compose" value={value} onValue={setValue} onAgent={selected} />; }
  const { user } = setup(<Input />); await user.type(screen.getByRole("textbox"), "@At"); expect(await screen.findByRole("option", { name: /Atlas/ })).toBeInTheDocument(); await user.keyboard("{Enter}"); expect(screen.getByRole("textbox")).toHaveValue("@atlas "); expect(selected).toHaveBeenCalledWith("a");
  await user.clear(screen.getByRole("textbox")); await user.type(screen.getByRole("textbox"), "@test"); expect(await screen.findByRole("option", { name: /Testing/ })).toBeInTheDocument(); await user.keyboard("{Enter}"); expect(screen.getByRole("textbox")).toHaveValue("@testing ");
});
