import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Projects } from "./Projects";
vi.mock("../api/queries", () => ({ useProjects: () => ({ data: [], isPending: false }), useTodos: () => ({ data: [] }) }));
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { delete window.muster; });
function page() { return render(<QueryClientProvider client={new QueryClient()}><Projects /></QueryClientProvider>); }
it("fills the repository field from the native folder picker", async () => {
  const chooseFolder = vi.fn().mockResolvedValue("/Users/me/My Project");
  window.muster = { desktop: true, platform: "darwin", chooseFolder, openPath: vi.fn(), onCommand: vi.fn() };
  page();
  act(() => screen.getByRole("button", { name: "New project" }).click());
  act(() => screen.getByRole("button", { name: "Choose folder…" }).click());
  await waitFor(() => expect(screen.getByLabelText("Repository path or URL")).toHaveValue("/Users/me/My Project"));
  expect(chooseFolder).toHaveBeenCalledOnce();
});
it("keeps native folder controls hidden in the browser", () => {
  page(); act(() => screen.getByRole("button", { name: "New project" }).click());
  expect(screen.queryByRole("button", { name: "Choose folder…" })).not.toBeInTheDocument();
});
