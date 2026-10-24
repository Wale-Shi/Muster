import { describe, expect, it } from "vitest";
import type { Todo, TodoPhase } from "@muster/shared";
import { boardTodos, columnForPhase } from "./board";

export const todoFixture: Todo = {
  id: "task-1",
  number: 42,
  title: "Ship the workspace",
  spec: "",
  projectId: "project-1",
  phase: "todo",
  agentId: null,
  planAgentId: null,
  mode: "plan",
  tags: [],
  createdBy: "user",
  topicId: null,
  previousGate: null,
  createdAt: "2026-10-24T00:00:00Z",
  updatedAt: "2026-10-24T00:00:00Z",
  doneAt: null,
};
describe("board phase mapping", () => {
  it.each<[TodoPhase, string | null]>([
    ["todo", "backlog"],
    ["queued", "in_progress"],
    ["planning", "in_progress"],
    ["building", "in_progress"],
    ["confirm", "needs_you"],
    ["review", "needs_you"],
    ["failed", "needs_you"],
    ["done", "done"],
    ["closed", null],
  ])("maps %s to %s", (phase, column) =>
    expect(columnForPhase(phase)).toBe(column),
  );
  it("includes only Done tasks from the last seven days", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    const recent = {
      ...todoFixture,
      id: "recent",
      phase: "done" as const,
      doneAt: "2026-10-18T12:00:00Z",
    };
    const boundary = {
      ...recent,
      id: "boundary",
      doneAt: "2026-10-17T12:00:00Z",
    };
    const old = { ...recent, id: "old", doneAt: "2026-10-17T11:59:59Z" };
    const undated = { ...recent, id: "undated", doneAt: null };
    expect(
      boardTodos(
        [recent, boundary, old, undated, todoFixture],
        "done",
        now,
      ).map((todo) => todo.id),
    ).toEqual(["recent", "boundary"]);
  });
});
