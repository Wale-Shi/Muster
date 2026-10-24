import { SettingsPage } from "../pages/Settings";
import { workspaceSettingsSchema } from "@muster/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@muster/shared";
import { createI18n, dictionaries, I18nProvider } from ".";
import { systemMessage } from "./system";
import { displayError } from "./errors";
import { Board } from "../components/Board";
import { Sidebar } from "../components/Sidebar";
import { api } from "../api/client";

function leaves(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === "string" ? [[`${prefix}${key}`, item]] : Object.entries(leaves(item as object, `${prefix}${key}.`))));
}
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete window.muster; });

describe("dictionaries", () => {
  for (const [locale, messages] of Object.entries(dictionaries)) {
    it(`${locale} has complete copy and matching interpolation placeholders`, () => {
      const source = leaves(dictionaries.en), translated = leaves(messages);
      expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort());
      for (const [key, value] of Object.entries(translated)) {
        expect(value.trim(), key).not.toBe("");
        expect(placeholders(value), key).toEqual(placeholders(source[key]!));
      }
    });
  }
  it("uses plurals, interpolation and active-locale formatters", () => {
    const en = createI18n("en"), zh = createI18n("zh-CN");
    expect(en.t("count.active", { count: 1 })).toBe("1 active task");
    expect(en.t("count.active", { count: 2 })).toBe("2 active tasks");
    expect(zh.t("count.active", { count: 2 })).toBe("2 个活跃任务");
    expect(zh.t("text.edit", { name: "Atlas {test}" })).toBe("编辑 Atlas {test}");
    expect(zh.formatNumber(12345)).toBe(new Intl.NumberFormat("zh-CN").format(12345));
    expect(zh.formatRelative(0, 120000)).toBe(new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto", style: "short" }).format(-2, "minute"));
    expect(zh.formatDuration(120000)).toBe(new Intl.NumberFormat("zh-CN", { style: "unit", unit: "minute", unitDisplay: "narrow" }).format(2));
    expect(zh.formatDate(0, { timeZone: "UTC", dateStyle: "medium" })).toBe(new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", dateStyle: "medium" }).format(0));
  });
});

it("switches sidebar and board instantly, persists language and informs desktop", async () => {
  vi.spyOn(api, "topics").mockResolvedValue([]);
  vi.spyOn(api, "machines").mockResolvedValue([]);
  vi.spyOn(api, "todos").mockResolvedValue([]);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  let settingsData = workspaceSettingsSchema.parse({});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings" && init?.method === "PATCH") settingsData = { ...settingsData, ...JSON.parse(String(init.body)) };
    return Response.json({ data: url === "/api/settings" ? settingsData : [] });
  }));
  const setLocale = vi.fn().mockResolvedValue(undefined);
  window.muster = { desktop: true, platform: "darwin", setLocale, chooseFolder: vi.fn(), openPath: vi.fn(), onCommand: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<I18nProvider initial="en"><QueryClientProvider client={client}><MemoryRouter>
    <Sidebar collapsed={false} mobileOpen={false} onToggle={() => {}} onCloseMobile={() => {}} onSearch={() => {}} onNewTask={() => {}} />
    <Board todos={[]} agents={[]} projects={[]} onNew={() => {}} /><SettingsPage />
  </MemoryRouter></QueryClientProvider></I18nProvider>);
  expect(screen.getByRole("heading", { name: "Backlog" })).toBeVisible();
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/settings");
  fireEvent.click(await screen.findByRole("tab", { name: "Light" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  await waitFor(() => expect(localStorage.getItem("muster.theme")).toBe("light"));
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh-CN" } });
  expect(await screen.findByRole("heading", { name: "待办" })).toBeVisible();
  expect(screen.getByRole("link", { name: "工作区" })).toBeVisible();
  expect(screen.getByText("暂无待办任务")).toBeVisible();
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(document.title).toBe("Muster");
  expect(localStorage.getItem("muster.locale")).toBe("zh-CN");
  expect(setLocale).toHaveBeenLastCalledWith("zh-CN");
});

it("uses saved preference, ignores invalid storage and tolerates unavailable storage", () => {
  localStorage.setItem("muster.locale", "zh-CN");
  const first = render(<I18nProvider><span /></I18nProvider>);
  expect(document.documentElement.lang).toBe("zh-CN");
  first.unmount();
  localStorage.setItem("muster.locale", "retired-locale");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-Hant"] );
  const second = render(<I18nProvider><span /></I18nProvider>);
  expect(document.documentElement.lang).toBe("zh-CN");
  second.unmount();
  vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<I18nProvider><span /></I18nProvider>);
  expect(document.documentElement.lang).toBe("zh-CN");
});

it("translates structured notices and known errors while preserving stored content", () => {
  const { t, label } = createI18n("zh-CN");
  const message: Message = { id: "m", conversationId: "c", turnId: null, role: "system", content: "Todo #1 Keep Title entered confirm.", createdAt: "2026-01-01", meta: { todoId: "t", phase: "confirm" } };
  expect(systemMessage(message, t, label)).toBe("任务 #1 Keep Title 的计划已就绪，等待你确认。");
  expect(systemMessage({ ...message, meta: { todoId: "t", phase: "building" } }, t, label)).toBe("任务 #1 Keep Title 已进入构建中阶段。");
  expect(systemMessage({ ...message, meta: {} }, t, label)).toBe(message.content);
  expect(systemMessage({ ...message, meta: { code: "no_file_changes" } }, t, label)).toBe("本次构建没有文件变更");
  expect(message.content).toBe("Todo #1 Keep Title entered confirm.");
  expect(displayError(new Error("Invalid request"), t, label)).toContain("请求无效");
  expect(displayError(new Error("Cannot start todo from review"), t, label)).toContain("评审");
  expect(displayError(new Error("external error text"), t, label)).toBe("external error text");
  expect(label("runtime", "claude")).toBe("Claude Code");
  const english = createI18n("en");
  expect(systemMessage(message, english.t, english.label)).toBe("Task #1 Keep Title has a plan ready for your confirmation.");
  expect(systemMessage({ ...message, meta: { todoId: "t", phase: "review" } }, english.t, english.label)).toBe("Task #1 Keep Title is ready for your review.");
});
it("formats compact card ages in both languages", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  expect(createI18n("en").formatAge(now - 57 * 60_000, now)).toBe("57m");
  expect(createI18n("en").formatAge(now - 3 * 3_600_000, now)).toBe("3h");
  expect(createI18n("zh-CN").formatAge(now - 57 * 60_000, now)).toBe("57分钟");
});
