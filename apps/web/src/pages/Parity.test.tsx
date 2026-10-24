import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ScheduleDialog, SchedulesPage } from "./Schedules";
import { ConnectionsPage } from "./Connections";
import { AgentPage } from "./Agent";
const ids = { task: "00000000-0000-4000-8000-000000000001", project: "00000000-0000-4000-8000-000000000002", agent: "00000000-0000-4000-8000-000000000003" };
const connection = { id: "connection", identifier: "linear", name: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", catalogId: "linear", secretKeys: ["Authorization"], args: [] };
beforeEach(() => { Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(element: React.ReactNode, data: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => Response.json({ data: init?.method && init.method !== "GET" ? url.endsWith("/test") ? { ok: true, toolCount: 1, tools: ["find_issue"] } : {} : data[url] ?? ({ "/api/todos": [{ id: ids.task, number: 1, title: "Repeat me", projectId: ids.project }], "/api/projects": [{ id: ids.project, name: "Project" }], "/api/agents": [], "/api/machines": [{ id: ids.agent, name: "Online machine", online: true }], "/api/connections": [], "/api/schedules": [] } as Record<string, unknown>)[url] ?? [] }));
  vi.stubGlobal("fetch", fetcher); render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>); return { user: userEvent.setup(), fetcher };
}
it("shows schedule empty state and Chief guidance", async () => { setup(<SchedulesPage />); expect(await screen.findByText("No schedules yet")).toBeInTheDocument(); expect(screen.getByText(/ask Chief/)).toBeInTheDocument(); });
it("adapts schedule cadence inputs and sends task, mode and browser timezone", async () => {
  const { user, fetcher } = setup(<ScheduleDialog todoId={ids.task} onClose={() => {}} />);
  expect(await screen.findByRole("option", { name: "#1 Repeat me" })).toBeInTheDocument(); expect(screen.getByLabelText("Time")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Hourly" })); expect(screen.getByLabelText("Minute")).toBeInTheDocument(); expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Weekly" })); expect(screen.getByLabelText("Weekday")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Once" })); expect(screen.getByLabelText("Date")).toHaveAttribute("type", "datetime-local");
  await user.click(screen.getByRole("tab", { name: "Daily" })); await user.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/schedules", expect.objectContaining({ method: "POST", body: expect.stringContaining(`"todoId":"${ids.task}"`) })));
});
it("filters catalog and explains OAuth without a connect action", async () => {
  const { user } = setup(<ConnectionsPage />); await screen.findByRole("button", { name: /Linear/ }); await user.click(screen.getByRole("tab", { name: "Documents" })); expect(screen.queryByRole("button", { name: /Linear/ })).not.toBeInTheDocument(); await user.click(screen.getByRole("button", { name: /Notion/ })); const dialog = screen.getByRole("dialog"); expect(within(dialog).getByText(/OAuth sign-in isn't supported yet/)).toBeInTheDocument(); expect(within(dialog).queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
});
it("shows connected details and inline test results without returning saved values", async () => {
  const { user, fetcher } = setup(<ConnectionsPage />, { "/api/connections": [connection] }); await user.click(await screen.findByRole("button", { name: /Linear/ })); await user.click(screen.getByRole("button", { name: "Test connection" })); expect(await screen.findByRole("status")).toHaveTextContent("Connected · 1 tools"); expect(fetcher).toHaveBeenCalledWith("/api/connections/connection/test", expect.objectContaining({ method: "POST" })); await user.click(screen.getByRole("button", { name: "Edit" })); expect(screen.getByLabelText(/API token/)).toHaveValue("");
});
it("validates custom identifiers, supports secret rows and stdio machine selection", async () => {
  const { user } = setup(<ConnectionsPage />); await user.click(screen.getByRole("button", { name: "Custom connection" })); await user.type(screen.getByLabelText("Name"), "Example"); expect(screen.getByLabelText(/Identifier/)).toHaveValue("example"); await user.clear(screen.getByLabelText(/Identifier/)); await user.type(screen.getByLabelText(/Identifier/), "muster"); await user.type(screen.getByLabelText("Server URL"), "https://example.test/mcp"); expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled(); await user.clear(screen.getByLabelText(/Identifier/)); await user.type(screen.getByLabelText(/Identifier/), "example"); expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled(); await user.click(screen.getByRole("button", { name: "Add value" })); expect(screen.getByLabelText("Value 1")).toHaveAttribute("type", "password"); await user.click(screen.getByRole("tab", { name: "Local command" })); expect(screen.getByLabelText("Command")).toBeInTheDocument(); expect(screen.getByLabelText("Machine")).toBeInTheDocument();
});
it("grants an existing connection on the agent page", async () => {
  const { user, fetcher } = setup(<Routes><Route path="*" element={<AgentPage />} /></Routes>, { "/api/connections": [connection], "/api/agents/": { id: ids.agent, name: "Atlas", role: "Builder", runtime: "mock", model: "mock", inProgress: [], connectionIds: [], createdAt: "2026-01-01T00:00:00Z", memoryCount: 0, skillCount: 0 } });
  await user.selectOptions(await screen.findByLabelText("Add connection"), "connection"); await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/agents/", expect.objectContaining({ method: "PATCH", body: '{"connectionIds":["connection"]}' })));
});
