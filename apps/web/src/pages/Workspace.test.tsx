import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";

vi.mock("../api/queries", () => ({
  useProject: () => ({ data: { id: "shop", name: "Shop", repoUrl: "/repo", baseBranch: "main", chiefAgentId: "lead", topicId: "topic" } }),
  useTopic: () => ({ data: { id: "topic", activity: "idle" } }),
  useTodos: () => ({ data: [] }),
  useProjects: () => ({ data: [] }),
  useAgents: () => ({ data: [{ id: "chief", name: "Chief", isChief: true }, { id: "lead", name: "Lead", isChief: false, runtime: "mock" }] }),
}));
vi.mock("../components/Conversation", () => ({ Conversation: () => <div>Conversation fixture</div> }));
vi.mock("../components/Board", () => ({ Board: () => <div>Board fixture</div>, TaskCard: () => null }));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("starts with the board at the desktop minimum and lets the user switch to the conversation", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Workspace onNewTask={() => {}} /></MemoryRouter></QueryClientProvider>);
  expect(container.querySelector(".split")).toHaveClass("mobile-right");
  fireEvent.click(screen.getByRole("button", { name: "对话" }));
  expect(container.querySelector(".split")).toHaveClass("mobile-left");
  fireEvent.click(screen.getByRole("button", { name: "看板" }));
  expect(container.querySelector(".split")).toHaveClass("mobile-right");
});
it("talks to the workspace's own master agent and links its settings", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Workspace onNewTask={() => {}} /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText("Shop 的 master agent")).toBeInTheDocument();
  expect(screen.getAllByText("Lead").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Agent 设置" })).toHaveAttribute("href", "/agents/lead");
  expect(screen.getByRole("link", { name: "工作空间设置" })).toHaveAttribute("href", "/w/shop/settings");
});
it("keeps the conversation as the initial pane outside the compact desktop range", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Workspace onNewTask={() => {}} /></MemoryRouter></QueryClientProvider>);
  expect(container.querySelector(".split")).toHaveClass("mobile-left");
  fireEvent.click(screen.getByRole("button", { name: "最大化看板" }));
  expect(container.querySelector(".split")).toHaveClass("right-maximized");
  fireEvent.click(screen.getByRole("button", { name: "恢复分栏视图" }));
  expect(container.querySelector(".split")).not.toHaveClass("right-maximized");
});
