import { z } from "zod";

export const scheduleFields = z.object({
  todoId: z.string().uuid(), cadence: z.enum(["hourly", "daily", "weekly", "once"]),
  minute: z.number().int().min(0).max(59), hour: z.number().int().min(0).max(23).nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(), runAt: z.string().datetime().nullable().optional(),
  timezone: z.string().refine((zone) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }, "Invalid timezone"),
  mode: z.enum(["plan", "run"]).default("plan"), agentId: z.string().uuid().nullable().optional(),
  machineId: z.string().uuid().nullable().optional(), enabled: z.boolean().default(true),
});
export const updateScheduleSchema = scheduleFields.partial().extend({ mode: scheduleFields.shape.mode.removeDefault().optional(), enabled: scheduleFields.shape.enabled.removeDefault().optional() });
export const scheduleSchema = scheduleFields.superRefine((s, ctx) => {
  if ((s.cadence === "daily" || s.cadence === "weekly") && s.hour == null) ctx.addIssue({ code: "custom", path: ["hour"], message: "Hour required" });
  if (s.cadence === "weekly" && s.weekday == null) ctx.addIssue({ code: "custom", path: ["weekday"], message: "Weekday required" });
  if (s.cadence === "once" && !s.runAt) ctx.addIssue({ code: "custom", path: ["runAt"], message: "Date required" });
});
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export interface Schedule extends ScheduleInput {
  id: string; nextRunAt: string | null; lastRunAt: string | null;
  lastResult: "started" | "skipped_busy" | "error" | null; lastError: string | null;
  createdAt: string; updatedAt: string;
}

/** Wall-clock occurrences are resolved before comparing with after: a repeated
 * hour never causes a second firing. Gaps advance to the first valid minute. */
export function nextRun(s: ScheduleInput, after: Date): Date | null {
  if (s.cadence === "once") return s.runAt && Date.parse(s.runAt) > +after ? new Date(s.runAt) : null;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const wall = (time: number) => { const p = Object.fromEntries(format.formatToParts(time).map((p) => [p.type, p.value])); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!); };
  const local = wall(+after); const day = Math.floor(local / 86400000) * 86400000;
  // Gather possible offsets around the interval, including either side of DST.
  const offsets = new Set<number>();
  for (let t = day - 2 * 86400000; t <= day + 10 * 86400000; t += 6 * 3600000) offsets.add(wall(t) - t);
  const resolve = (target: number): number => {
    let gap = Infinity; const exact: number[] = [];
    for (const offset of offsets) { const instant = target - offset; const actual = wall(instant); if (actual === target) exact.push(instant); else if (actual > target) gap = Math.min(gap, instant); }
    if (exact.length) return Math.min(...exact);
    // Walk backwards from the post-gap candidate to the transition boundary.
    while (wall(gap - 60000) >= target) gap -= 60000;
    return gap;
  };
  for (let d = 0; d < 9; d++) {
    const date = day + d * 86400000;
    if (s.cadence === "weekly" && new Date(date).getUTCDay() !== s.weekday) continue;
    const hours = s.cadence === "hourly" ? Array.from({ length: 24 }, (_, i) => i) : [s.hour!];
    for (const h of hours) { const instant = resolve(date + h * 3600000 + s.minute * 60000); if (instant > +after) return new Date(instant); }
  }
  throw new Error("Unable to resolve schedule");
}
