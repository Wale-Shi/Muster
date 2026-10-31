import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { Board } from "./Board";
import type { Todo } from "@muster/shared";

const task: Todo = {
  id: "one",
  number: 7,
  title: "Add streaming updates",
  spec: "",
  phase: "review",
  projectId: "project",
  agentId: "agent",
  createdBy: "user",
  topicId: null,
  previousGate: null,
  createdAt: "2026-10-24T00:00:00Z",
  updatedAt: "2026-10-24T00:00:00Z",
  doneAt: null,
};
describe("board", () => {
  it("renders Review under Needs you with task metadata and the exact empty states", () => {
    render(
      <MemoryRouter>
        <DndContext>
          <Board
            todos={[task]}
            agents={[
              {
                id: "agent",
                name: "Atlas",
                role: "Builder",
                runtime: "mock",
                model: "mock",
                reasoning: null,
                avatar: null,
                isChief: false,
                createdAt: task.createdAt,
              },
            ]}
            onNew={() => {}}
          />
        </DndContext>
      </MemoryRouter>,
    );
    const column = screen
      .getByRole("heading", { name: "待你处理" })
      .closest("section");
    expect(column).not.toBeNull();
    expect(
      within(column!).getByRole("link", { name: task.title }),
    ).toHaveAttribute("href", "/todos/one");
    expect(within(column!).getByText("#7")).toBeInTheDocument();
    expect(within(column!).getByText("待验收")).toHaveClass("card-gate", "review");
    expect(within(column!).getByText("Atlas", { selector: ".card-agent" })).toHaveAttribute("title", "Atlas");
    expect(screen.getByText("暂无待办任务")).toBeInTheDocument();
    expect(screen.getByText("暂无进行中的任务")).toBeInTheDocument();
    expect(screen.getByText("还没有已完成的任务")).toBeInTheDocument();
    expect(
      screen.queryByText("暂无待你处理的任务"),
    ).not.toBeInTheDocument();
  });

  it("labels review and failure and opens mobile paging on Needs you without moving the user's chosen page on refresh", () => {
    const tasks = [task, { ...task, id: "again", title: "Review again" }, { ...task, id: "failed", phase: "failed" as const }];
    const board = (todos: Todo[]) => <MemoryRouter><DndContext><Board todos={todos} agents={[]} onNew={() => {}} /></DndContext></MemoryRouter>;
    const { rerender } = render(board([]));
    rerender(board(tasks)); // Tasks may arrive after the board mounts.
    const paging = within(screen.getByRole("navigation", { name: "看板列" }));
    expect(paging.getByRole("button", { name: "待你处理 3" })).toHaveAttribute("aria-current", "true");
    expect(screen.getAllByText("待验收", { selector: ".card-gate" })).toHaveLength(2);
    expect(screen.getByText("失败")).toHaveClass("failed");
    fireEvent.click(paging.getByRole("button", { name: "待办 0" }));
    rerender(board([...tasks, { ...task, id: "another" }]));
    expect(paging.getByRole("button", { name: "待办 0" })).toHaveAttribute("aria-current", "true");
  });
});
