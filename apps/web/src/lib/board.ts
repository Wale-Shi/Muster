import type { Todo, TodoPhase } from "@muster/shared";

export type ColumnId = "backlog" | "in_progress" | "needs_you" | "done";
const columns: Record<TodoPhase, ColumnId | null> = {
  todo: "backlog",
  queued: "in_progress",
  planning: "in_progress",
  building: "in_progress",
  confirm: "needs_you",
  review: "needs_you",
  failed: "needs_you",
  done: "done",
  closed: null,
};
export function columnForPhase(phase: TodoPhase) {
  return columns[phase];
}
export function boardTodos(todos: Todo[], column: ColumnId, now = Date.now()) {
  return todos.filter(
    (todo) =>
      columnForPhase(todo.phase) === column &&
      (column !== "done" ||
        (todo.doneAt !== null &&
          Date.parse(todo.doneAt) >= now - 7 * 86_400_000)),
  );
}
export const isRunning = (phase: TodoPhase) =>
  ["queued", "planning", "building"].includes(phase);
