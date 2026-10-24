import { expect, it } from "vitest";
import { nextRun, scheduleSchema, type ScheduleInput } from "./schedules.js";
const base: ScheduleInput = { todoId: "00000000-0000-4000-8000-000000000000", cadence: "daily", hour: 9, minute: 0, timezone: "Asia/Shanghai", mode: "plan", enabled: true };
it.each([
  [{}, "2026-01-01T00:00:00Z", "2026-01-01T01:00:00.000Z"],
  [{}, "2026-01-01T01:00:00Z", "2026-01-02T01:00:00.000Z"],
  [{ cadence: "hourly", minute: 15 }, "2026-01-01T00:16:00Z", "2026-01-01T01:15:00.000Z"],
  [{ cadence: "weekly", weekday: 0 }, "2026-01-02T00:00:00Z", "2026-01-04T01:00:00.000Z"],
  [{}, "2026-12-31T02:00:00Z", "2027-01-01T01:00:00.000Z"],
  [{}, "2028-02-28T02:00:00Z", "2028-02-29T01:00:00.000Z"],
  [{}, "2026-02-28T02:00:00Z", "2026-03-01T01:00:00.000Z"],
  [{ timezone: "America/New_York", hour: 2, minute: 30 }, "2026-03-08T00:00:00Z", "2026-03-08T07:00:00.000Z"],
  [{ timezone: "America/New_York", hour: 1, minute: 30 }, "2026-11-01T00:00:00Z", "2026-11-01T05:30:00.000Z"],
  [{ timezone: "America/New_York", hour: 1, minute: 30 }, "2026-11-01T05:30:00Z", "2026-11-02T06:30:00.000Z"],
  [{ timezone: "Europe/Berlin", hour: 2, minute: 30 }, "2026-03-29T00:00:00Z", "2026-03-29T01:00:00.000Z"],
  [{ timezone: "Europe/Berlin", hour: 2, minute: 30 }, "2026-10-24T23:00:00Z", "2026-10-25T00:30:00.000Z"],
  [{ timezone: "Europe/Berlin", hour: 2, minute: 30 }, "2026-10-25T00:30:00Z", "2026-10-26T01:30:00.000Z"],
  [{ timezone: "America/New_York", cadence: "hourly", minute: 30 }, "2026-11-01T05:45:00Z", "2026-11-01T07:30:00.000Z"],
  [{ timezone: "Europe/Berlin", cadence: "hourly", minute: 30 }, "2026-03-29T00:45:00Z", "2026-03-29T01:00:00.000Z"],
  [{ timezone: "Europe/Berlin", cadence: "weekly", weekday: 0, hour: 2, minute: 30 }, "2026-03-28T00:00:00Z", "2026-03-29T01:00:00.000Z"],
  [{ timezone: "America/New_York", cadence: "weekly", weekday: 0, hour: 1, minute: 30 }, "2026-11-01T05:31:00Z", "2026-11-08T06:30:00.000Z"],
  [{ cadence: "once", runAt: "2026-12-01T00:00:00Z" }, "2026-01-01T00:00:00Z", "2026-12-01T00:00:00.000Z"],
  [{ cadence: "once", runAt: "2026-01-01T00:00:00Z" }, "2026-01-01T00:00:00Z", undefined],
] as [Partial<ScheduleInput>, string, string | undefined][])('resolves %j after %s', (patch, after, expected) => { expect(nextRun({ ...base, ...patch }, new Date(after))?.toISOString()).toBe(expected); });
it("validates required cadence fields and IANA zones", () => {
  for (const patch of [{ timezone: "unknown" }, { minute: 60 }, { hour: null }, { cadence: "weekly" }, { cadence: "once" }]) expect(scheduleSchema.safeParse({ ...base, ...patch }).success).toBe(false);
});
