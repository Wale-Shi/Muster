import { afterEach, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { DesktopIntegration } from "./DesktopIntegration";
import { Markdown } from "./Conversation";
import type { DesktopCommand } from "../../../desktop/src/bridge";
afterEach(() => { delete window.muster; });
it("receives native new-task and notification navigation commands and unsubscribes", () => {
  let callback: (command: DesktopCommand) => void = () => {};
  const unsubscribe = vi.fn(), onNewTask = vi.fn();
  window.muster = { desktop: true, setLocale: vi.fn().mockResolvedValue(undefined), platform: "darwin", chooseFolder: vi.fn(), openPath: vi.fn(), onCommand: (listener) => { callback = listener; return unsubscribe; } };
  function Location() { return <div>{useLocation().pathname}</div>; }
  const view = render(<MemoryRouter><DesktopIntegration onNewTask={onNewTask} /><Location /></MemoryRouter>);
  act(() => callback({ type: "new-task" })); expect(onNewTask).toHaveBeenCalledOnce();
  act(() => callback({ type: "open-todo", id: "todo-123" })); expect(screen.getByText("/todos/todo-123")).toBeInTheDocument();
  const priorCleanupCount = unsubscribe.mock.calls.length;
  view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(priorCleanupCount + 1);
});
it("opens absolute conversation paths through the desktop bridge", async () => {
  const openPath = vi.fn().mockResolvedValue("");
  window.muster = { desktop: true, setLocale: vi.fn().mockResolvedValue(undefined), platform: "darwin", chooseFolder: vi.fn(), openPath, onCommand: vi.fn() };
  render(<Markdown>{"Open /Users/me/repo and `/Users/me/My Repo`."}</Markdown>);
  act(() => screen.getByRole("link", { name: "/Users/me/repo" }).click());
  act(() => screen.getByRole("button", { name: "/Users/me/My Repo" }).click());
  expect(openPath).toHaveBeenCalledWith("/Users/me/repo"); expect(openPath).toHaveBeenCalledWith("/Users/me/My Repo");
});
it("keeps ordinary browser conversations free of native path actions", () => {
  render(<Markdown>{"Open /Users/me/repo and `/Users/me/My Repo`."}</Markdown>);
  expect(screen.queryByRole("link")).not.toBeInTheDocument(); expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
