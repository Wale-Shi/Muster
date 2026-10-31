import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Todo } from "@muster/shared";
import { api } from "../api/client";
import { I18nProvider } from "../i18n";
import { DoneDialog } from "./DoneDialog";

const todo: Todo = {
  id: "task", number: 5, title: "Action copy", spec: "", phase: "review",
  projectId: "project", agentId: null,
  createdBy: "user", topicId: null, previousGate: null,
  createdAt: "2026-10-25", updatedAt: "2026-10-25", doneAt: null,
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const copy = { done: "完成", merge: "完成并合并", pending: "正在完成…" };
{
  it.each([true, false])("switches action copy and submits merge=%s", async (merge) => {
    let finish!: () => void;
    const action = vi.spyOn(api, "action").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(<I18nProvider><QueryClientProvider client={client}>
      <DoneDialog todo={todo} onClose={onClose} />
    </QueryClientProvider></I18nProvider>);
    const user = userEvent.setup();
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    expect(screen.getByRole("button", { name: copy.merge })).toBeEnabled();
    await user.click(checkbox);
    expect(screen.getByRole("button", { name: copy.done })).toBeEnabled();
    await user.click(checkbox);
    expect(screen.getByRole("button", { name: copy.merge })).toBeEnabled();
    if (!merge) await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: merge ? copy.merge : copy.done }));
    await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith(todo.id, "done", { merge }));
    expect(await screen.findByRole("button", { name: copy.pending })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
}
