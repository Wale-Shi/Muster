import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, connectionStatus } from "./Sidebar";

describe("sidebar connection status", () => {
  it("requires both a connected server and an online machine", () => {
    expect(connectionStatus(true, 2)).toBe("online");
    expect(connectionStatus(true, 0)).toBe("offline");
    expect(connectionStatus(false, 2)).toBe("connecting");
    expect(connectionStatus(false, 0)).toBe("connecting");
  });
  it("does not claim machines are online before their status is known", () => {
    expect(connectionStatus(true, undefined)).toBe("unknown");
    expect(connectionStatus(false, undefined)).toBe("connecting");
  });
});

vi.mock("../api/queries", () => ({
  useProjects: () => ({ data: [{ id: "project", name: "Example project" }] }),
  useTopics: () => ({ data: [{ id: "topic", title: "Example topic", createdAt: "2026-10-25" }] }),
  useTodos: () => ({ data: [] }),
  useMachines: () => ({ data: [] }),
}));
vi.mock("../api/realtime", () => ({
  useRealtime: () => ({ connected: true, activity: {} }),
}));
vi.mock("../pages/Settings", () => ({
  useWorkspaceSettings: () => ({ data: { workspaceName: "Muster" } }),
}));

function sidebar(collapsed = false) {
  return <MemoryRouter><Sidebar collapsed={collapsed} mobileOpen={false}
    onToggle={vi.fn()} onCloseMobile={vi.fn()} onSearch={vi.fn()} onNewTask={vi.fn()} /></MemoryRouter>;
}

const groups = [
  { name: "Projects", key: "projects", content: ["Example project", "New project"] },
  { name: /topics/i, key: "topics", content: ["Example topic", "New topic"] },
] as const;

function expectGroup(button: HTMLElement, open: boolean, content: readonly string[]) {
  expect(button).toHaveAttribute("aria-expanded", String(open));
  const arrow = button.querySelector("svg");
  expect(arrow).toHaveClass("lucide-chevron-right", "sidebar-chevron");
  if (open) expect(arrow).toHaveClass("expanded");
  else expect(arrow).not.toHaveClass("expanded");
  for (const title of content) {
    if (open) expect(screen.getByTitle(title)).toBeVisible();
    else expect(screen.queryByTitle(title)).not.toBeInTheDocument();
  }
}

describe("sidebar groups", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it.each(groups)("toggles $key content and the same animated arrow", async ({ name, content }) => {
    const user = userEvent.setup();
    render(sidebar());
    const button = screen.getByRole("button", { name });
    const arrow = button.querySelector("svg");
    expectGroup(button, true, content);
    await user.click(button);
    expectGroup(button, false, content);
    expect(button.querySelector("svg")).toBe(arrow);
    await user.click(button);
    expectGroup(button, true, content);
    expect(button.querySelector("svg")).toBe(arrow);
  });

  it.each(groups)("supports Tab, Enter and Space for $key", async ({ name, content }) => {
    const user = userEvent.setup();
    render(sidebar());
    const button = screen.getByRole("button", { name });
    for (let i = 0; i < 40 && document.activeElement !== button; i++) await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expectGroup(button, false, content);
    expect(button).toHaveFocus();
    await user.keyboard(" ");
    expectGroup(button, true, content);
    expect(button).toHaveFocus();
  });

  it("keeps group state independent and restores saved preferences", async () => {
    const user = userEvent.setup();
    const view = render(sidebar());
    await user.click(screen.getByRole("button", { name: "Projects" }));
    expectGroup(screen.getByRole("button", { name: /topics/i }), true, groups[1].content);
    expect(localStorage.getItem("muster.projects-expanded")).toBe("false");
    view.unmount();
    render(sidebar());
    expectGroup(screen.getByRole("button", { name: "Projects" }), false, groups[0].content);
    expectGroup(screen.getByRole("button", { name: /topics/i }), true, groups[1].content);
  });

  it("keeps navigation available in the icon rail and restores closed groups", async () => {
    const user = userEvent.setup();
    const view = render(sidebar());
    for (const { name } of groups) await user.click(screen.getByRole("button", { name }));
    view.rerender(sidebar(true));
    expect(view.container.querySelector("aside")).toHaveClass("collapsed");
    for (const [title, href] of [
      ["Example project", "/projects/project"], ["Example topic", "/topics/topic"],
      ["Agents", "/agents"], ["Skills", "/skills"], ["Connections", "/connections"], ["Schedules", "/schedules"],
    ] as const) expect(screen.getByTitle(title)).toHaveAttribute("href", href);
    expect(screen.queryByRole("button", { name: "Resources" })).not.toBeInTheDocument();
    expect(screen.getByText("No machines online").closest("a")).toHaveAttribute("href", "/settings?tab=machines");
    expect(screen.getByTitle("New project")).toBeInTheDocument();
    expect(screen.getByTitle("New topic")).toBeInTheDocument();
    view.rerender(sidebar());
    expect(view.container.querySelector("aside")).not.toHaveClass("collapsed");
    for (const { name, content } of groups) expectGroup(screen.getByRole("button", { name }), false, content);
  });
});
