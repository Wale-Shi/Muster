import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo } from "@muster/shared";
import { Sidebar, connectionStatus, workspaceStatus } from "./Sidebar";

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
  useTodos: () => ({ data: [{ id: "task", projectId: "docs", phase: "review" }] }),
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
  it("lists workspaces with their status and only the kept sections", async () => {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Sidebar collapsed={false} mobileOpen={false} onToggle={vi.fn()} onCloseMobile={vi.fn()} onNewTask={vi.fn()} /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole("link", { name: /Shop/ })).toHaveAttribute("href", "/w/shop");
    expect(screen.getByRole("link", { name: /Docs/ })).toHaveAttribute("href", "/w/docs");
    expect(screen.getByLabelText("运行中")).toBeInTheDocument();
    expect(screen.getByLabelText("待你处理")).toBeInTheDocument();
    for (const name of ["Agent", "技能", "连接", "设置"]) expect(screen.getByRole("link", { name })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /定时|Schedules/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "新建工作空间" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
