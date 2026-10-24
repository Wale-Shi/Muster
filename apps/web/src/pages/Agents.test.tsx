import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { Agents } from "./Agents";

afterEach(() => vi.restoreAllMocks());

it("explains why Create is disabled when Role is missing, using the schema's required fields", async () => {
  vi.spyOn(api, "agents").mockResolvedValue([]);
  vi.spyOn(api, "todos").mockResolvedValue([]);
  // jsdom does not implement the native dialog lifecycle.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Agents /></MemoryRouter></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.type(screen.getByRole("textbox", { name: "Name (required)" }), "Mocky");
  await user.selectOptions(screen.getByRole("combobox", { name: "Runtime (required)" }), "mock");
  expect(screen.getByRole("textbox", { name: "Model (required)" })).toHaveValue("mock");
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(create).toBeDisabled();
  expect(create).toHaveAccessibleDescription("Enter role to create an agent.");
  const role = screen.getByRole("textbox", { name: "Role (required)" });
  expect(role).toBeRequired();
  await user.type(role, "   ");
  expect(create).toBeDisabled();
  await user.type(role, "Build fixtures");
  expect(create).toBeEnabled();
  expect(screen.queryByText("Enter role to create an agent.")).not.toBeInTheDocument();
});
