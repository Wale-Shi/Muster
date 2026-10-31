import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api, type TodoDetail } from "../api/client";
import { I18nProvider } from "../i18n";
import { TodoActions } from "./TodoActions";

const todo: TodoDetail = {
  id: "task", number: 5, title: "Action copy", spec: "", phase: "review",
  projectId: "project", agentId: null,
  createdBy: "user", topicId: null, previousGate: null,
  createdAt: "2026-10-25", updatedAt: "2026-10-25", doneAt: null, builds: [],
};
const build = (status: TodoDetail["builds"][number]["turns"][number]["status"]): TodoDetail["builds"] => [{
  id: "build", todoId: "task", branch: "muster/conv-build", machineId: null, status: "active",
  baseCommit: null, headCommit: null, tokensIn: 0, tokensOut: 0, durationMs: 0, createdAt: "2026-10-25",
  turns: [{ id: "turn", buildId: "build", kind: "build", status, machineId: null, prompt: "", startedAt: null, endedAt: null, error: null, tokensIn: 0, tokensOut: 0 }],
  documents: [],
}];
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it.each([
  { phase: "queued" as const, turn: "queued" as const },
  { phase: "building" as const, turn: "running" as const },
])("enables Stop while the last turn is $turn", ({ phase, turn }) => {
  const client = new QueryClient();
  render(
    <I18nProvider><QueryClientProvider client={client}>
      <TodoActions todo={{ ...todo, phase, builds: build(turn) }} onDone={() => {}} />
    </QueryClientProvider></I18nProvider>,
  );
  expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
});

it("starts in one click and offers review, rerun and reopen actions", async () => {
  const onDone = vi.fn();
  const action = vi.spyOn(api, "action").mockResolvedValue(undefined);
  const client = new QueryClient();
  const view = (phase: TodoDetail["phase"]) => (
    <I18nProvider><QueryClientProvider client={client}>
      <TodoActions todo={{ ...todo, phase }} onDone={onDone} />
    </QueryClientProvider></I18nProvider>
  );
  const user = userEvent.setup();
  const { rerender } = render(view("todo"));
  await user.click(screen.getByRole("button", { name: "启动" }));
  expect(action).toHaveBeenCalledWith(todo.id, "start", undefined);
  rerender(view("review"));
  await user.click(screen.getByRole("button", { name: "完成" }));
  expect(onDone).toHaveBeenCalledTimes(1);
  rerender(view("failed"));
  expect(screen.getByRole("button", { name: /重新执行/ })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "完成" })).not.toBeInTheDocument();
  for (const phase of ["done", "closed"] as const) {
    rerender(view(phase));
    expect(screen.getByRole("button", { name: "重新打开" })).toBeEnabled();
  }
});
