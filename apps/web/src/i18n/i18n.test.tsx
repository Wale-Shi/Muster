import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "@muster/shared";
import { createI18n, I18nProvider } from ".";
import { messages } from "./zh-CN";
import { systemMessage } from "./system";
import { displayError } from "./errors";

function leaves(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === "string" ? [[`${prefix}${key}`, item]] : Object.entries(leaves(item as object, `${prefix}${key}.`))));
}

describe("dictionary", () => {
  it("has no empty copy", () => {
    for (const [key, value] of Object.entries(leaves(messages))) expect(value.trim(), key).not.toBe("");
  });
  it("uses plurals, interpolation and Chinese formatters", () => {
    const { t, formatNumber, formatRelative, formatDuration, formatDate } = createI18n();
    expect(t("count.active", { count: 2 })).toBe("2 个活跃任务");
    expect(t("text.editMessage", { content: "Atlas {test}" })).toBe("编辑：Atlas {test}");
    expect(t("ws.masterOf", { name: "Shop" })).toBe("Shop 的 master agent");
    expect(formatNumber(12345)).toBe(new Intl.NumberFormat("zh-CN").format(12345));
    expect(formatRelative(0, 120000)).toBe(new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto", style: "short" }).format(-2, "minute"));
    expect(formatDuration(120000)).toBe(new Intl.NumberFormat("zh-CN", { style: "unit", unit: "minute", unitDisplay: "narrow" }).format(2));
    expect(formatDate(0, { timeZone: "UTC", dateStyle: "medium" })).toBe(new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", dateStyle: "medium" }).format(0));
  });
  it("formats compact card ages", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(createI18n().formatAge(now - 57 * 60_000, now)).toBe("57分钟");
  });
});

it("sets the document language and title", () => {
  render(<I18nProvider><span /></I18nProvider>);
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(document.title).toBe("Muster");
});

it("translates structured notices and known errors while preserving stored content", () => {
  const { t, label } = createI18n();
  const message: Message = { id: "m", conversationId: "c", turnId: null, role: "system", content: "Task #1 Keep Title (taskId t) entered review.", createdAt: "2026-01-01", meta: { todoId: "t", phase: "review" } };
  expect(systemMessage(message, t, label)).toBe("任务 #1 Keep Title 已完成，等待验收。");
  // Older notices kept the "Todo" wording and had no structured task fields.
  expect(systemMessage({ ...message, content: "Todo #1 Keep Title entered done.", meta: { todoId: "t", phase: "done" } }, t, label)).toBe("任务 #1 Keep Title 已完成。");
  expect(systemMessage({ ...message, meta: { todoId: "t", phase: "building" } }, t, label)).toBe("任务 #1 Keep Title 已进入执行中阶段。");
  expect(systemMessage({ ...message, meta: { todoNumber: 2, todoTitle: "Other", todoId: "t", phase: "failed" } }, t, label)).toBe("任务 #2 Other 执行失败。");
  expect(systemMessage({ ...message, meta: {} }, t, label)).toBe(message.content);
  expect(systemMessage({ ...message, meta: { code: "no_file_changes" } }, t, label)).toBe("本次构建没有文件变更");
  expect(displayError(new Error("Invalid request"), t, label)).toContain("请求无效");
  expect(displayError(new Error("Workspace still has tasks"), t, label)).toBe("工作空间里还有任务，无法删除");
  expect(displayError(new Error("Cannot start todo from review"), t, label)).toContain("待验收");
  expect(displayError(new Error("Messages can only steer a running turn or revise at review (current: done)"), t, label)).toContain("已完成");
  expect(displayError(new Error("external error text"), t, label)).toBe("external error text");
  expect(label("runtime", "claude")).toBe("Claude Code");
});
