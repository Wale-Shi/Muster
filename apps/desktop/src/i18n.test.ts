import { describe, expect, it } from "vitest";
import { isLocale as sharedIsLocale, resolveLocale as sharedResolveLocale } from "@muster/shared";
import { desktopError, desktopText, isLocale, notificationTitle, resolveLocale } from "./i18n.js";

describe("desktop locale", () => {
  it.each([
    [["zh-Hans"], "zh-CN"], [["zh-CN"], "zh-CN"], [["zh-SG"], "zh-CN"],
    [["zh-Hant"], "zh-CN"], [["zh-HK"], "zh-CN"], [["ZH"], "zh-CN"],
    [["fr-FR", "zh"], "zh-CN"], [["en-US", "zh-CN"], "en"], [["en-GB"], "en"], [["fr"], "en"], [[], "en"],
  ])("maps system preferences %j to %s", (languages, expected) => {
    expect(resolveLocale(languages)).toBe(expected);
    expect(sharedResolveLocale(languages)).toBe(expected);
  });
  it("accepts only supported renderer locales", () => {
    for (const check of [isLocale, sharedIsLocale]) {
      for (const locale of ["en", "zh-CN"]) expect(check(locale)).toBe(true);
      for (const locale of [null, {}, "zh-Hans", "fr", "__proto__"]) expect(check(locale)).toBe(false);
    }
  });
  it("uses human notification titles and translated tray status", () => {
    expect(notificationTitle("en", "confirm")).toBe("Needs confirmation · Muster");
    expect(notificationTitle("zh-CN", "confirm")).toBe("需要确认 · Muster");
    expect(notificationTitle("zh-CN", "review")).toBe("需要评审 · Muster");
    expect(desktopText("zh-CN", "running", { count: 2 })).toBe("2 轮运行中");
  });
});

it("localizes known startup failures and keeps unknown diagnostics", () => {
  expect(desktopError("zh-CN", new Error("No free local port for Muster"))).toBe("没有可供 Muster 使用的本地端口");
  expect(desktopError("zh-CN", new Error("Server exited (1); see server.log"))).toBe("服务器已退出（1），请查看 server.log");
  expect(desktopError("zh-CN", new Error("OS diagnostic"))).toBe("OS diagnostic");
});
