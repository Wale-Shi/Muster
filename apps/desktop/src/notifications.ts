import type { NotificationPreferences } from "@muster/shared";
export const defaultNotificationPreferences: NotificationPreferences = { confirm: true, review: true, failed: true, done: true, dockBadge: true };
export function shouldNotify(phase: string, preferences: NotificationPreferences): boolean {
  return (phase === "confirm" || phase === "review" || phase === "failed" || phase === "done") && preferences[phase];
}
export function badgeCount(phases: string[], preferences: NotificationPreferences): number {
  return preferences.dockBadge ? phases.filter((p) => ["confirm", "review", "failed"].includes(p)).length : 0;
}
