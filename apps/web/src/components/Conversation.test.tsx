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
  render(<QueryClientProvider client={client}><MemoryRouter><RealtimeProvider><Conversation conversationId="topic" {...(status ? { status } : {})} {...(runtime ? { runtime } : {})} /></RealtimeProvider></MemoryRouter></QueryClientProvider>);
  await screen.findByText("How can I help?");
  const emit = (type: string, payload: unknown, extra: Partial<ServerEvent> = {}) => {
    act(() => receive?.({ data: JSON.stringify({ type, conversationId: "topic", turnId: "turn", payload, ...extra }) }));
  };
  emit("turn.started", { turnId: "turn" });
  const warn = () => emit("warning", { type: "warning", detail: "Selected model is at capacity." });
  return { emit, warn, user: userEvent.setup() };
}

const machine = (runtimes: Runtime[]): Machine => ({ id: "machine", name: "Test machine", concurrency: 1, runtimes, lastSeenAt: null, createdAt: "2026-01-01T00:00:00Z", online: true });

it("tells the user when no machine is online for a queued turn", async () => {
  await setup({ status: "queued", runtime: "devin" });
  expect(await screen.findByText(/No machine is online\. Start one with/)).toBeInTheDocument();
});

it("names the runtime that no online machine supports", async () => {
  await setup({ status: "queued", runtime: "devin", machines: [machine(["mock"])] });
  expect(await screen.findByText(/No online machine supports the devin runtime\./)).toBeInTheDocument();
});

it("keeps the ordinary waiting copy when an online machine can run the turn", async () => {
  await setup({ status: "queued", runtime: "mock", machines: [machine(["mock"])] });
  expect(await screen.findByText(/Waiting for a machine/)).toBeInTheDocument();
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
  expect(status).toHaveTextContent("Working…");
  expect(status).toHaveTextContent("Inspecting files");
  expect(status).not.toHaveTextContent("capacity");
  await user.click(within(warning).getByRole("button", { name: "Dismiss runtime warning" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(status).toHaveTextContent("Working…");
  warn();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  emit("usage", { tokensIn: 1, tokensOut: 0 });
  emit("message.delta", { content: "" });
  emit("message.delta", { content: "Unrelated" }, { conversationId: "other-topic", turnId: "other-turn" });
  emit("message.delta", { content: "Earlier turn output" }, { turnId: "earlier-turn" });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  emit("message.delta", { content: "Resumed" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(status).toHaveTextContent("Working…");
  expect(status).not.toHaveTextContent("Inspecting files");
});

it.each(["message.completed", "reasoning.delta", "tool.started", "tool.completed", "plan.updated"])("clears the warning when the turn produces %s output", async (type) => {
  const { emit, warn } = await setup();
  warn();
  emit(type, { content: "Output", tool: "read" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Working…");
});

it.each(["done", "failed", "stopped"])("clears the warning when the turn ends %s", async (status) => {
  const { emit, warn } = await setup();
  warn();
  emit("turn.completed", { turnId: "unrelated", status });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  emit("turn.completed", { turnId: "turn", status });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("Working…")).not.toBeInTheDocument();
});

it("offers four Chief starter tiles and fills the composer", async () => {
  const { user } = await setup();
  expect(screen.getByRole("button", { name: "Import an existing project" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Import a skill" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Build a small browser game" }));
  expect(screen.getByLabelText("Message")).toHaveValue("Build a small browser game");
  await user.click(screen.getByRole("button", { name: "Make a daily news digest page" }));
  expect(screen.getByLabelText("Message")).toHaveValue("Make a daily news digest page");
});
