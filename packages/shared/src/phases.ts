import type { TodoPhase, TurnKind } from "./types.js";

export type BoardColumn = "backlog" | "in_progress" | "needs_you" | "done" | null;

export const BOARD_COLUMN_BY_PHASE: Record<TodoPhase, BoardColumn> = {
  todo: "backlog",
  queued: "in_progress",
  building: "in_progress",
  review: "needs_you",
  failed: "needs_you",
  done: "done",
  closed: null,
};

export const ALLOWED_PHASE_TRANSITIONS: Readonly<Record<TodoPhase, readonly TodoPhase[]>> = {
  todo: ["queued", "closed"],
  queued: ["building", "failed", "closed"],
  building: ["review", "done", "failed", "closed"],
  review: ["queued", "done", "closed"],
  failed: ["queued", "closed"],
  done: ["review", "closed"],
  closed: ["todo", "review", "closed"],
};

export function canTransition(from: TodoPhase, to: TodoPhase): boolean {
  return ALLOWED_PHASE_TRANSITIONS[from].includes(to);
}

export function activePhaseForTurn(kind: TurnKind): TodoPhase | null {
  return kind === "chief" ? null : "building";
}

export function completedPhaseForTurn(kind: TurnKind): TodoPhase | null {
  if (kind === "build" || kind === "revise") return "review";
  if (kind === "merge") return "done";
  return null;
}
