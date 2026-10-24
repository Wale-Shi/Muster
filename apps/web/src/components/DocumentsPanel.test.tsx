import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type TodoDetail } from "../api/client";
import { DiffView, DocumentsPanel } from "./DocumentsPanel";

afterEach(() => vi.restoreAllMocks());

describe("diff viewer", () => {
  it("renders per-file changes and filters without losing the overall counts", async () => {
    const user = userEvent.setup();
    render(
      <DiffView
        content={
          "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+second"
        }
      />,
    );
    expect(screen.getByText("2 files changed")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Diff for a.ts" }),
    ).toHaveTextContent("-old");
    await user.type(
      screen.getByRole("textbox", { name: "Filter changed files" }),
      "b.ts",
    );
    expect(
      screen.queryByRole("region", { name: "Diff for a.ts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Diff for b.ts" }),
    ).toHaveTextContent("+second");
    expect(screen.getByText("2 files changed")).toBeInTheDocument();
  });
});

it("selects arriving Changes when there is no plan, while preserving an explicit tab choice", async () => {
  const changes = { id: "diff", buildId: "build", kind: "changes" as const, version: 1, content: "diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new", createdAt: "2026-10-24T00:00:00Z" };
  vi.spyOn(api, "documents").mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const todo = { id: "todo", builds: [{ id: "build", documents: [] }] } as unknown as TodoDetail;
  render(<QueryClientProvider client={client}><DocumentsPanel todo={todo} /></QueryClientProvider>);
  await screen.findByText("A plan starts here");
  client.setQueryData(["documents", "todo"], [changes]);
  await screen.findByRole("region", { name: "Diff for a.ts" });
  expect(screen.getByRole("button", { name: "Changes" })).toHaveClass("active");
  await userEvent.setup().click(screen.getByRole("button", { name: "Plan" }));
  client.setQueryData(["documents", "todo"], [changes, { ...changes, id: "diff2", version: 2 }]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("active"));
  expect(screen.getByText("A plan starts here")).toBeInTheDocument();
});
