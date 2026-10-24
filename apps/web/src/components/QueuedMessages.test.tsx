import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedMessage } from "@muster/shared";
import { api } from "../api/client";
import { QueuedMessages } from "./QueuedMessages";

afterEach(() => vi.restoreAllMocks());
const pending: QueuedMessage = { id: "queued", conversationId: "build", content: "Original feedback", createdAt: "2026-10-24T00:00:00Z", deliveredAt: null, delivering: false };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><QueuedMessages conversationId="build" /></QueryClientProvider>);
  return client;
}
it("restores the pending tray from REST and supports editing and retracting feedback", async () => {
  let rows = [pending];
  vi.spyOn(api, "queuedMessages").mockImplementation(async () => rows);
  const edit = vi.spyOn(api, "editQueued").mockImplementation(async (_id, _messageId, content) => { rows = [{ ...pending, content }]; });
  const retract = vi.spyOn(api, "retractQueued").mockImplementation(async () => { rows = []; });
  setup(); const user = userEvent.setup();
  await screen.findByText("Original feedback");
  await user.click(screen.getByRole("button", { name: "Edit: Original feedback" }));
  const input = screen.getByRole("textbox", { name: "Edit queued message" });
  await user.clear(input); await user.type(input, "Updated feedback");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(edit).toHaveBeenCalledWith("build", "queued", "Updated feedback");
  await screen.findByText("Updated feedback");
  await user.click(screen.getByRole("button", { name: "Retract: Updated feedback" }));
  expect(retract).toHaveBeenCalledWith("build", "queued");
  await waitFor(() => expect(screen.queryByText("Queued for this run")).not.toBeInTheDocument());
});
it("shows in-flight delivery and prevents editing a reserved message", async () => {
  vi.spyOn(api, "queuedMessages").mockResolvedValue([{ ...pending, delivering: true }]); setup();
  await screen.findByText("Delivering…");
  expect(screen.queryByRole("button", { name: /Edit:/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Retract:/ })).not.toBeInTheDocument();
});
