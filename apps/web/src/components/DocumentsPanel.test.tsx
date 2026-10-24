import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView } from "./DocumentsPanel";

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
