import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { TodoDetail } from "../api/client";
import { I18nProvider } from "../i18n";
import { TodoActions } from "./TodoActions";

const todo: TodoDetail = {
  id: "task", number: 5, title: "Action copy", spec: "", phase: "review",
  projectId: "project", agentId: null, planAgentId: null, mode: "plan", tags: [],
  createdBy: "user", topicId: null, previousGate: null,
  createdAt: "2026-10-25", updatedAt: "2026-10-25", doneAt: null, builds: [],
};
afterEach(() => localStorage.clear());

it.each([
  { locale: "en" as const, done: "Done", confirm: "Confirm plan", reopen: "Reopen" },
  { locale: "zh-CN" as const, done: "完成", confirm: "确认计划", reopen: "重新打开" },
])("uses action copy for review, confirm and reopen in $locale", async ({ locale, done, confirm, reopen }) => {
  const onDone = vi.fn();
  const client = new QueryClient();
  const view = (phase: TodoDetail["phase"]) => (
    <I18nProvider initial={locale}><QueryClientProvider client={client}>
      <TodoActions todo={{ ...todo, phase }} onDone={onDone} />
    </QueryClientProvider></I18nProvider>
  );
  const { rerender } = render(view("review"));
  await userEvent.setup().click(screen.getByRole("button", { name: done }));
  expect(onDone).toHaveBeenCalledTimes(1);
  rerender(view("confirm"));
  expect(screen.getByRole("button", { name: confirm })).toBeEnabled();
  expect(screen.queryByRole("button", { name: done })).not.toBeInTheDocument();
  for (const phase of ["done", "closed"] as const) {
    rerender(view(phase));
    expect(screen.getByRole("button", { name: reopen })).toBeEnabled();
  }
});
