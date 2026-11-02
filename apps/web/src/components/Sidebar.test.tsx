import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo } from "@muster/shared";
import { Sidebar, activeTasks, connectionStatus, workspaceStatus } from "./Sidebar";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});

describe("sidebar connection status", () => {
  it("requires both a connected server and an online machine", () => {
    expect(connectionStatus(true, 2)).toBe("online");
    expect(connectionStatus(true, 0)).toBe("offline");
    expect(connectionStatus(false, 2)).toBe("connecting");
    expect(connectionStatus(false, 0)).toBe("connecting");
  });
  it("does not claim machines are online before their status is known", () => {
    expect(connectionStatus(true, undefined)).toBe("unknown");
    expect(connectionStatus(false, undefined)).toBe("connecting");
  });
});

vi.mock("../api/queries", () => ({
  useProjects: () => ({ data: [
    { id: "shop", name: "Shop", topicId: "shop-topic" },
    { id: "docs", name: "Docs", topicId: "docs-topic" },
  ] }),
  useTodos: () => ({ data: [
    { id: "task", number: 3, title: "Fix links", projectId: "docs", phase: "review" },
    { id: "old", number: 1, title: "Old", projectId: "docs", phase: "done" },
  ] }),
  useMachines: () => ({ data: [] }),
  useAgents: () => ({ data: [] }),
}));
vi.mock("../api/realtime", () => ({
  useRealtime: () => ({ connected: true, activity: { "shop-topic": { status: "running", unread: false } }, live: {} }),
}));
vi.mock("../pages/Settings", () => ({
  useWorkspaceSettings: () => ({ data: { workspaceName: "Muster" } }),
}));

describe("workspace navigation", () => {
  const project = { id: "p", name: "P", repoUrl: "/r", baseBranch: "main", chiefAgentId: null, topicId: "t", createdAt: "" };
  const task = (phase: Todo["phase"], projectId = "p") => ({ id: phase, projectId, phase }) as Todo;
  it("summarizes each workspace from its master agent and its own tasks", () => {
    expect(workspaceStatus(project, [task("review")], true, false)).toBe("running");
    expect(workspaceStatus(project, [task("building")], false, false)).toBe("running");
    expect(workspaceStatus(project, [task("review"), task("failed")], false, false)).toBe("failed");
    expect(workspaceStatus(project, [task("review")], false, true)).toBe("needs-you");
    expect(workspaceStatus(project, [task("building", "other")], false, true)).toBe("unread");
    expect(workspaceStatus(project, [task("done")], false, false)).toBe("idle");
  });
  it("orders active tasks by what needs you first", () => {
    const todo = (id: string, phase: Todo["phase"], number: number) => ({ id, phase, number, projectId: "p" }) as Todo;
    const list = activeTasks([todo("a", "building", 1), todo("b", "review", 2), todo("c", "done", 3), todo("d", "failed", 4), todo("e", "review", 5)], "p");
    expect(list.map((item) => item.id)).toEqual(["d", "e", "b", "a"]);
  });
  it("shows the current workspace's conversation and tasks, with configuration at the bottom", async () => {
    const onNewTask = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/w/docs"]}><Sidebar collapsed={false} mobileOpen={false} onToggle={vi.fn()} onCloseMobile={vi.fn()} onNewTask={onNewTask} /></MemoryRouter></QueryClientProvider>);
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: /Docs/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /主会话/ })).toHaveAttribute("href", "/w/docs");
    expect(screen.getByRole("link", { name: /#3 Fix links/ })).toHaveAttribute("href", "/todos/task");
    expect(screen.queryByRole("link", { name: /#1 Old/ })).not.toBeInTheDocument();
    for (const name of ["Agent", "技能", "连接", "设置"]) expect(screen.getByRole("link", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新建任务" }));
    expect(onNewTask).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Docs/ }));
    expect(screen.getByRole("menuitem", { name: /Shop/ })).toHaveAttribute("href", "/w/shop");
    expect(screen.getByLabelText("运行中")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "新建工作空间" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
