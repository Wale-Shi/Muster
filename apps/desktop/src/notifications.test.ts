import { expect, it } from "vitest";
import { badgeCount, shouldNotify, defaultNotificationPreferences as defaults } from "./notifications.js";
import { commandAccelerators } from "./menu.js";
it("honors individual event preferences and includes Done", () => {
  for (const phase of ["confirm", "review", "failed", "done"] as const) {
    expect(shouldNotify(phase, defaults)).toBe(true);
    expect(shouldNotify(phase, { ...defaults, [phase]: false })).toBe(false);
  }
  expect(shouldNotify("building", defaults)).toBe(false);
});
it("clears disabled Dock badges independently of notification events", () => {
  expect(badgeCount(["confirm", "review", "failed", "done"], defaults)).toBe(3);
  expect(badgeCount(["review"], { ...defaults, review: false })).toBe(1);
  expect(badgeCount(["review"], { ...defaults, dockBadge: false })).toBe(0);
});
it("exposes the Settings and Help bridge accelerators", () => {
  expect(commandAccelerators).toEqual({ settings: "CmdOrCtrl+,", shortcuts: "CmdOrCtrl+/" });
});
