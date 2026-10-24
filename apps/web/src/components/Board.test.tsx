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
  planAgentId: null,
  mode: "run",
  tags: [],
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
            projects={[
              {
                id: "project",
                name: "Muster",
                repoUrl: "/repo",
                baseBranch: "main",
                createdAt: task.createdAt,
              },
            ]}
            onNew={() => {}}
          />
        </DndContext>
      </MemoryRouter>,
    );
    const column = screen
      .getByRole("heading", { name: "Needs you" })
      .closest("section");
    expect(column).not.toBeNull();
    expect(
      within(column!).getByRole("link", { name: task.title }),
    ).toHaveAttribute("href", "/todos/one");
    expect(within(column!).getByText("#7")).toBeInTheDocument();
    expect(within(column!).getByText("Review")).toHaveClass("card-gate", "review");
    expect(within(column!).getByTitle("Atlas")).toBeInTheDocument();
    expect(screen.getByText("Nothing waiting to start")).toBeInTheDocument();
    expect(screen.getByText("Nothing in progress")).toBeInTheDocument();
    expect(screen.getByText("Nothing finished yet")).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing waiting on you"),
    ).not.toBeInTheDocument();
  });

  it("labels all decision gates and opens mobile paging on Needs you without moving the user's chosen page on refresh", () => {
    const tasks = [task, { ...task, id: "confirm", phase: "confirm" as const }, { ...task, id: "failed", phase: "failed" as const }];
    const board = (todos: Todo[]) => <MemoryRouter><DndContext><Board todos={todos} projects={[]} agents={[]} onNew={() => {}} /></DndContext></MemoryRouter>;
    const { rerender } = render(board([]));
    rerender(board(tasks)); // Tasks may arrive after the board mounts.
    const paging = within(screen.getByRole("navigation", { name: "Board columns" }));
    expect(paging.getByRole("button", { name: "Needs you 3" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Confirm")).toHaveClass("confirm");
    expect(screen.getByText("Failed")).toHaveClass("failed");
    fireEvent.click(paging.getByRole("button", { name: "Backlog 0" }));
    rerender(board([...tasks, { ...task, id: "another" }]));
    expect(paging.getByRole("button", { name: "Backlog 0" })).toHaveAttribute("aria-current", "true");
  });
});
