import { describe, expect, it, vi } from "vitest";
import type { UsageRow } from "@muster/shared";
import { dailyUsage, groupUsage } from "./Usage";

const row = (patch: Partial<UsageRow>): UsageRow => ({ day: "2026-11-01", agentId: "a", agentName: "Chief", runtime: "claude", model: "default", projectId: "p", tokensIn: 0, tokensOut: 0, durationMs: 0, turns: 1, ...patch });

describe("usage", () => {
  it("groups rows and orders the largest first", () => {
    const groups = groupUsage([
      row({ model: "opus", tokensIn: 10, tokensOut: 5 }),
      row({ model: "sonnet", tokensIn: 100 }),
      row({ model: "opus", tokensIn: 1, day: "2026-11-02" }),
    ], (item) => item.model, (item) => ({ label: item.model }));
    expect(groups.map(({ key, tokensIn, tokensOut, turns }) => ({ key, tokensIn, tokensOut, turns }))).toEqual([
      { key: "sonnet", tokensIn: 100, tokensOut: 0, turns: 1 },
      { key: "opus", tokensIn: 11, tokensOut: 5, turns: 2 },
    ]);
  });

  it("fills quiet days in the range with zero", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 3, 12) });
    try {
      expect(dailyUsage([row({ day: "2026-11-01", tokensIn: 3 }), row({ day: "2026-11-03", tokensOut: 4 })], 4)).toEqual([
        { day: "2026-10-31", tokensIn: 0, tokensOut: 0 },
        { day: "2026-11-01", tokensIn: 3, tokensOut: 0 },
        { day: "2026-11-02", tokensIn: 0, tokensOut: 0 },
        { day: "2026-11-03", tokensIn: 0, tokensOut: 4 },
      ]);
    } finally { vi.useRealTimers(); }
  });
});
