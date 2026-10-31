import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine, Runtime, ServerEvent } from "@muster/shared";
import { api } from "../api/client";
import { RealtimeProvider } from "../api/realtime";
import { Conversation } from "./Conversation";

afterEach(() => vi.unstubAllGlobals());

async function setup({ machines = [], status, runtime }: { machines?: Machine[]; status?: "queued" | "running" | "idle"; runtime?: Runtime } = {}) {
  let receive: ((event: { data: string }) => void) | undefined;
  vi.stubGlobal("EventSource", class {
    set onmessage(handler: (event: { data: string }) => void) { receive = handler; }
    close() {}
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(api, "messages").mockResolvedValue([]);
  vi.spyOn(api, "queuedMessages").mockResolvedValue([]);
  vi.spyOn(api, "machines").mockResolvedValue(machines);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><RealtimeProvider><Conversation conversationId="topic" agentName="Atlas" {...(status ? { status } : {})} {...(runtime ? { runtime } : {})} /></RealtimeProvider></MemoryRouter></QueryClientProvider>);
  await screen.findByText("我是 Atlas，这个工作空间的 master agent");
  const emit = (type: string, payload: unknown, extra: Partial<ServerEvent> = {}) => {
    act(() => receive?.({ data: JSON.stringify({ type, conversationId: "topic", turnId: "turn", payload, ...extra }) }));
  };
  emit("turn.started", { turnId: "turn" });
  const warn = () => emit("warning", { type: "warning", detail: "Selected model is at capacity." });
  return { emit, warn, user: userEvent.setup() };
}

const machine = (runtimes: Runtime[]): Machine => ({ id: "machine", name: "Test machine", concurrency: 1, runtimes, lastSeenAt: null, createdAt: "2026-01-01T00:00:00Z", online: true });

it("tells the user when the local executor is not running for a queued turn", async () => {
  await setup({ status: "queued", runtime: "devin" });
  expect(await screen.findByText(/本地执行器没有运行。/)).toBeInTheDocument();
});

it("names a runtime whose CLI is not installed", async () => {
  await setup({ status: "queued", runtime: "devin", machines: [machine(["mock"])] });
  expect(await screen.findByText(/本机没有找到 devin 的 CLI。/)).toBeInTheDocument();
});

it("keeps the ordinary waiting copy when the executor can run the turn", async () => {
  await setup({ status: "queued", runtime: "mock", machines: [machine(["mock"])] });
  expect(await screen.findByText(/等待开始执行/)).toBeInTheDocument();
});

it("shows a dismissible amber warning in the composer separately from Working status", async () => {
  const { emit, warn, user } = await setup();
  emit("status", { status: "working", detail: "Inspecting files" });
  warn();
  const warning = screen.getByRole("alert");
  expect(warning).toHaveClass("runtime-warning");
  expect(warning.closest(".composer-wrap")).not.toBeNull();
  expect(warning).toHaveTextContent("Selected model is at capacity.");
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("正在处理…");
  expect(status).toHaveTextContent("Inspecting files");
  expect(status).not.toHaveTextContent("capacity");
  await user.click(within(warning).getByRole("button", { name: "忽略运行警告" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(status).toHaveTextContent("正在处理…");
  warn();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  emit("usage", { tokensIn: 1, tokensOut: 0 });
  emit("message.delta", { content: "" });
  emit("message.delta", { content: "Unrelated" }, { conversationId: "other-topic", turnId: "other-turn" });
  emit("message.delta", { content: "Earlier turn output" }, { turnId: "earlier-turn" });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  emit("message.delta", { content: "Resumed" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(status).toHaveTextContent("正在处理…");
  expect(status).not.toHaveTextContent("Inspecting files");
});

it.each(["message.completed", "reasoning.delta", "tool.started", "tool.completed", "plan.updated"])("clears the warning when the turn produces %s output", async (type) => {
  const { emit, warn } = await setup();
  warn();
  emit(type, { content: "输出", tool: "read" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("正在处理…");
});

it.each(["done", "failed", "stopped"])("clears the warning when the turn ends %s", async (status) => {
  const { emit, warn } = await setup();
  warn();
  emit("turn.completed", { turnId: "unrelated", status });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  emit("turn.completed", { turnId: "turn", status });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("正在处理…")).not.toBeInTheDocument();
});

it("offers master-agent starter tiles and fills the composer", async () => {
  const { user } = await setup();
  expect(screen.getByRole("button", { name: "导入技能" })).toBeInTheDocument();
  expect(screen.getByLabelText("消息")).toHaveAttribute("placeholder", "给 Atlas 发消息，或把任务拖到这里引用");
  await user.click(screen.getByRole("button", { name: "汇报一下各任务的进展和卡点" }));
  expect(screen.getByLabelText("消息")).toHaveValue("汇报一下各任务的进展和卡点");
  await user.click(screen.getByRole("button", { name: "验收所有待验收的任务，没问题就合并" }));
  expect(screen.getByLabelText("消息")).toHaveValue("验收所有待验收的任务，没问题就合并");
});
