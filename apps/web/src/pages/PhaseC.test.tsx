import { App } from "../App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workspaceSettingsSchema } from "@muster/shared";
import { SettingsPage, ShortcutsList, clientSnippets } from "./Settings";
import { ProjectPage } from "./Project";
import { Sidebar } from "../components/Sidebar";
import { NewTaskDialog } from "../components/NewTaskDialog";
import { TopicMenu } from "../components/TopicMenu";
import { matchShortcut, shortcuts } from "../lib/shortcuts";
const project = { id: "p", name: "Studio", repoUrl: "/tmp/repo", baseBranch: "main", createdAt: "2026-01-01" };
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(element: React.ReactNode, path = "/", data: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => data[url] instanceof Response ? data[url] : Response.json({ data: init?.method === "POST" ? { id: "task", key: "mst_test" } : data[url] ?? ({ "/api/settings": workspaceSettingsSchema.parse({}), "/api/api-keys": [], "/api/projects": [project], "/api/projects/p": project, "/api/projects/p/tree?path=": [{ name: "README.md", path: "README.md", type: "blob" }], "/api/projects/p/file?path=README.md": { content: "# Preview", notice: null }, "/api/projects/p/commits": [], "/api/agents": [], "/api/topics": [], "/api/todos": [], "/api/machines": [] } as Record<string, unknown>)[url] ?? [] }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[path]}>{element}</MemoryRouter></QueryClientProvider>);
  return { ...view, user: userEvent.setup(), fetcher };
}
it("shows all Settings tabs, native notification explanation, and current-origin MCP snippets", async () => {
  const { user } = setup(<SettingsPage />);
  expect(await screen.findByLabelText("Workspace name")).toHaveValue("Muster");
  await user.click(screen.getByRole("tab", { name: "Notifications" })); expect(screen.getByText(/preferences apply to the desktop app/)).toBeInTheDocument(); expect(screen.getByRole("switch", { name: "Dock badge" })).toBeChecked();
  await user.click(screen.getByRole("tab", { name: "API keys" })); expect(screen.getByText("No API keys yet")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "MCP" })); expect(screen.getByText(`${location.origin}/api/mcp`)).toBeInTheDocument(); expect(screen.getByText(/claude mcp add --transport/)).toBeInTheDocument();
  expect(clientSnippets("https://workspace.test")[1]!.content).toContain('url = "https://workspace.test/api/mcp"');
  await user.click(screen.getByRole("tab", { name: "Keyboard shortcuts" })); for (const shortcut of shortcuts) expect(screen.getByText(shortcut.keys)).toBeInTheDocument();
});
it("renders grouped settings navigation and selects deep links", async () => {
  setup(<SettingsPage />, "/settings?tab=usage");
  for (const heading of ["Workspace", "System", "Developer", "Help"]) expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Usage", selected: true })).toBeInTheDocument();
});
it.each([["machines", "Machines"], ["secrets", "Secrets"], ["usage", "Usage"]])("redirects /%s to its Settings tab", async (path, label) => {
  setup(<App />, `/${path}`);
  expect(await screen.findByRole("tab", { name: label, selected: true })).toBeInTheDocument();
});
it("uses one shortcut table for display and matching, preserving input typing", () => {
  setup(<ShortcutsList />);
  for (const shortcut of shortcuts) {
    const event = new KeyboardEvent("keydown", { code: shortcut.code, metaKey: !!shortcut.mod, altKey: !!shortcut.alt, shiftKey: !!shortcut.shift });
    expect(matchShortcut(event)?.command).toBe(shortcut.command); expect(screen.getByText(shortcut.keys)).toBeInTheDocument();
  }
  const input = document.createElement("textarea"); document.body.append(input);
  const event = new KeyboardEvent("keydown", { code: "KeyN", bubbles: true }); input.dispatchEvent(event); expect(matchShortcut(event)).toBeUndefined();
  const complete = new KeyboardEvent("keydown", { code: "Enter", metaKey: true, altKey: true }); input.dispatchEvent(complete); expect(matchShortcut(complete)).toBeUndefined(); input.remove();
});
it("persists sidebar groups and highlights a project on nested settings routes", async () => {
  const props = { collapsed: false, mobileOpen: false, onToggle() {}, onCloseMobile() {}, onSearch() {}, onNewTask() {} };
  const { user, unmount } = setup(<Sidebar {...props} />, "/projects/p/settings");
  const link = await screen.findByRole("link", { name: "Studio" }); expect(link).toHaveClass("active");
  await user.click(screen.getByRole("button", { name: "Projects" })); expect(localStorage.getItem("muster.projects-expanded")).toBe("false"); expect(screen.queryByRole("link", { name: "Studio" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Resources" })).not.toBeInTheDocument(); unmount();
  setup(<Sidebar {...props} collapsed />, "/projects/p/settings"); expect(await screen.findByTitle("Studio")).toBeInTheDocument(); expect(screen.getByTitle("Agents")).toBeInTheDocument();
});
it("switches project Files / History / Tasks and uses the markdown viewer", async () => {
  const { user } = setup(<Routes><Route path="/projects/:id" element={<ProjectPage />} /></Routes>, "/projects/p");
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
  expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(3);
  await user.click(await screen.findByRole("button", { name: "README.md" })); expect(await screen.findByRole("heading", { name: "Preview" })).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "History" })); await user.click(screen.getByRole("tab", { name: "Tasks" })); expect(screen.getByLabelText("Search tasks")).toBeInTheDocument(); expect(screen.getByLabelText("All phases")).toBeInTheDocument();
});
it("shows one quiet notice and no browser panes for an unreadable repository", async () => {
  setup(<Routes><Route path="/projects/:id" element={<ProjectPage />} /></Routes>, "/projects/p", { "/api/projects/p/tree?path=": Response.json({ error: "unreadable" }, { status: 403 }) });
  expect(await screen.findByText("/tmp/repo")).toBeInTheDocument();
  expect(screen.getAllByText(/File browsing is available for repositories on this computer/)).toHaveLength(1);
  expect(document.querySelector(".project-browser")).not.toBeInTheDocument();
});
it("creates a task with template, tags, attachments and remembered split action", async () => {
  const { user, fetcher } = setup(<NewTaskDialog initialProjectId="p" onClose={() => {}} />);
  expect(screen.getByLabelText("Task description")).toHaveAttribute("placeholder", expect.stringContaining("What I want:"));
  expect(await screen.findByRole("option", { name: "Studio" })).toBeInTheDocument();
  await user.type(screen.getByLabelText("Task title"), "Task"); await user.click(screen.getByRole("button", { name: "Tags" })); await user.type(screen.getByLabelText("Tags", { selector: "input" }), "ui{Enter}");
  const file = new File(["content"], "input.txt", { type: "text/plain" }); await user.upload(screen.getByLabelText("Attachments", { selector: "input" }), file); expect(screen.getByText("input.txt")).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Save & start", { selector: "select" }), "run"); expect(localStorage.getItem("muster.new-task-mode")).toBe('"run"');
  fireEvent.keyDown(screen.getByLabelText("Task description"), { key: "Enter", metaKey: true });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/todos/task/start", expect.objectContaining({ body: '{"mode":"run"}' })));
  expect(fetcher).toHaveBeenCalledWith("/api/todos", expect.objectContaining({ body: expect.stringContaining('"tags":["ui"]') }));
  expect(fetcher).toHaveBeenCalledWith("/api/todos/task/attachments", expect.objectContaining({ body: expect.any(FormData) }));
});
it("renames a topic and links Chief settings", async () => {
  const { user, fetcher } = setup(<TopicMenu chiefId="chief" topic={{ id: "topic", title: "General", activity: "idle", activeTurnId: null, runtimeSession: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" }} />);
  await user.click(screen.getByLabelText("Topic actions")); expect(screen.getByRole("link", { name: "Chief settings" })).toHaveAttribute("href", "/agents/chief");
  await user.click(screen.getByRole("button", { name: "Rename topic" })); const dialog = screen.getByRole("dialog"); await user.clear(within(dialog).getByLabelText("Topic name")); await user.type(within(dialog).getByLabelText("Topic name"), "Roadmap"); await user.click(within(dialog).getByRole("button", { name: "Save" })); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/topics/topic", expect.objectContaining({ method: "PATCH", body: '{"title":"Roadmap"}' })));
});

it("routes global keyboard commands through the table and opens filtered search", async () => {
  setup(<App />, "/settings");
  await screen.findByLabelText("Workspace name");
  fireEvent.keyDown(window, { code: "Slash", key: "/", metaKey: true });
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Keyboard shortcuts");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close dialog" }));
  fireEvent.keyDown(window, { code: "KeyP", key: "p", metaKey: true });
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Search workspace");
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Tasks" })).toHaveClass("active");
});
