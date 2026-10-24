import type { TodoPhase, TurnKind } from "./types.js";

export type BoardColumn = "backlog" | "in_progress" | "needs_you" | "done" | null;

export const BOARD_COLUMN_BY_PHASE: Record<TodoPhase, BoardColumn> = {
  todo: "backlog",
  queued: "in_progress",
  planning: "in_progress",
  confirm: "needs_you",
  building: "in_progress",
  review: "needs_you",
  failed: "needs_you",
  done: "done",
  closed: null,
};

export const ALLOWED_PHASE_TRANSITIONS: Readonly<Record<TodoPhase, readonly TodoPhase[]>> = {
  todo: ["queued", "closed"],
  queued: ["planning", "building", "failed", "closed"],
  planning: ["confirm", "failed", "closed"],
  confirm: ["queued", "closed"],
  building: ["review", "done", "failed", "closed"],
  review: ["queued", "done", "closed"],
  failed: ["queued", "closed"],
  done: ["review", "closed"],
  closed: ["todo", "confirm", "review", "closed"],
};

export function canTransition(from: TodoPhase, to: TodoPhase): boolean {
  return ALLOWED_PHASE_TRANSITIONS[from].includes(to);
}

export function activePhaseForTurn(kind: TurnKind, priorGate: "confirm" | "review" | null): TodoPhase | null {
  if (kind === "plan") return "planning";
  if (kind === "build" || kind === "merge") return "building";
  if (kind === "revise") return priorGate === "confirm" ? "planning" : "building";
  return null;
}

export function completedPhaseForTurn(kind: TurnKind, priorGate: "confirm" | "review" | null): TodoPhase | null {
  if (kind === "plan") return "confirm";
  if (kind === "build") return "review";
  if (kind === "revise") return priorGate ?? "review";
  if (kind === "merge") return "done";
  return null;
}
