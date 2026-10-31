import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { Agents } from "./Agents";

afterEach(() => vi.restoreAllMocks());

it("explains why Create is disabled when Role is missing, using the schema's required fields", async () => {
  vi.spyOn(api, "agents").mockResolvedValue([]);
  vi.spyOn(api, "todos").mockResolvedValue([]);
  vi.spyOn(api, "projects").mockResolvedValue([]);
  vi.spyOn(api, "machines").mockResolvedValue([{ id: "m1", name: "Mac", concurrency: 1, runtimes: ["mock", "codex"], lastSeenAt: null, createdAt: "", online: true,
    models: { codex: { models: [{ id: "gpt-a", name: "GPT A", reasoning: ["low", "high"] }], checkedAt: "" } } }]);
  // jsdom does not implement the native dialog lifecycle.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Agents /></MemoryRouter></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: /Agent/ })[0]!);
  await user.type(screen.getByRole("textbox", { name: "名称（必填）" }), "Mocky");
  // Codex and Claude default to the CLI's own model, not to a reported one.
  await screen.findByRole("option", { name: "Codex" });
  await user.selectOptions(screen.getByRole("combobox", { name: "运行时（必选）" }), "codex");
  expect(screen.getByRole("combobox", { name: "模型（必填）" })).toHaveValue("default");
  expect([...screen.getByRole("combobox", { name: "推理强度" }).querySelectorAll("option")].map((o) => o.textContent)).toEqual(["默认", "low", "high"]);
  await user.selectOptions(screen.getByRole("combobox", { name: "运行时（必选）" }), "mock");
  expect(screen.getByRole("combobox", { name: "模型（必填）" })).toHaveValue("mock");
  const create = within(screen.getByRole("dialog")).getByRole("button", { name: "创建 Agent" });
  expect(create).toBeDisabled();
  expect(create).toHaveAccessibleDescription("请填写职责以创建 Agent。");
  const role = screen.getByRole("textbox", { name: "职责（必填）" });
  expect(role).toBeRequired();
  await user.type(role, "   ");
  expect(create).toBeDisabled();
  await user.type(role, "Build fixtures");
  expect(create).toBeEnabled();
  expect(screen.queryByText("请填写职责以创建 Agent。")).not.toBeInTheDocument();
});
