import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";

vi.mock("../api/queries", () => ({
  useTopics: () => ({ data: [{ id: "topic", title: "General", createdAt: "2026-01-01", activity: "idle" }] }),
  useTodos: () => ({ data: [] }),
  useProjects: () => ({ data: [] }),
  useAgents: () => ({ data: [] }),
}));
vi.mock("../components/Conversation", () => ({ Conversation: () => <div>Conversation fixture</div> }));
vi.mock("../components/Board", () => ({ Board: () => <div>Board fixture</div>, TaskCard: () => null }));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("starts with the board at the desktop minimum and lets the user switch to Chief", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  const { container } = render(<MemoryRouter><Workspace onNewTask={() => {}} /></MemoryRouter>);
  expect(container.querySelector(".split")).toHaveClass("mobile-right");
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(container.querySelector(".split")).toHaveClass("mobile-left");
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  expect(container.querySelector(".split")).toHaveClass("mobile-right");
});
it("keeps Chief as the initial pane outside the compact desktop range", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  const { container } = render(<MemoryRouter><Workspace onNewTask={() => {}} /></MemoryRouter>);
  expect(container.querySelector(".split")).toHaveClass("mobile-left");
  fireEvent.click(screen.getByRole("button", { name: "Maximize board" }));
  expect(container.querySelector(".split")).toHaveClass("right-maximized");
  fireEvent.click(screen.getByRole("button", { name: "Restore split view" }));
  expect(container.querySelector(".split")).not.toHaveClass("right-maximized");
});
