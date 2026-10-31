import { expect, it } from "vitest";
import { desktopError, desktopText, notificationTitle } from "./i18n.js";

it("uses human notification titles and Chinese tray status", () => {
  expect(notificationTitle("review")).toBe("待验收 · Muster");
  expect(notificationTitle("failed")).toBe("任务失败 · Muster");
  expect(notificationTitle("done")).toBe("任务完成 · Muster");
  expect(desktopText("running", { count: 2 })).toBe("2 轮运行中");
});

it("translates known startup failures and keeps unknown diagnostics", () => {
  expect(desktopError(new Error("No free local port for Muster"))).toBe("没有可供 Muster 使用的本地端口");
  expect(desktopError(new Error("Server exited (1); see server.log"))).toBe("服务器已退出（1），请查看 server.log");
  expect(desktopError(new Error("OS diagnostic"))).toBe("OS diagnostic");
});
