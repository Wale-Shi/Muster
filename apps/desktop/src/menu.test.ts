import { expect, it } from "vitest";
import { viewMenuRoles } from "./menu.js";

it("always offers exactly one fullscreen item", () => {
  for (const packaged of [true, false]) expect(viewMenuRoles(packaged).filter((role) => role === "togglefullscreen")).toHaveLength(1);
});
it("exposes developer tools only during development", () => {
  expect(viewMenuRoles(false)).toContain("toggleDevTools");
  expect(viewMenuRoles(true)).not.toContain("toggleDevTools");
  expect(viewMenuRoles(true)).toContain("reload");
});
