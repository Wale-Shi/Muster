import { describe, expect, it } from "vitest";
import { BOARD_COLUMN_BY_PHASE, canTransition, completedPhaseForTurn } from "./phases.js";

describe("phase helpers", () => {
  it("maps phases to board columns", () => {
    expect(BOARD_COLUMN_BY_PHASE.todo).toBe("backlog");
    expect(BOARD_COLUMN_BY_PHASE.building).toBe("in_progress");
    expect(BOARD_COLUMN_BY_PHASE.failed).toBe("needs_you");
    expect(BOARD_COLUMN_BY_PHASE.closed).toBeNull();
  });

  it("enforces transitions and turn results", () => {
    expect(canTransition("todo", "queued")).toBe(true);
    expect(canTransition("todo", "done")).toBe(false);
    expect(completedPhaseForTurn("build")).toBe("review");
    expect(completedPhaseForTurn("revise")).toBe("review");
    expect(completedPhaseForTurn("merge")).toBe("done");
  });
});
