import { describe, expect, it } from "vitest";
import { mergePath, resolvePath } from "./path.js";
describe("desktop PATH", () => {
  it("prefers login-shell directories, deduplicates and appends CLI locations", () => {
    const path = mergePath("/custom/node/bin:/usr/bin:/custom/node/bin", "/usr/bin:/bin::.", "/Users/test", ":").split(":");
    expect(path[0]).toBe("/custom/node/bin");
    expect(path.filter((p) => p === "/usr/bin")).toHaveLength(1);
    expect(path).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/Users/test/.local/bin", "/Users/test/.npm-global/bin"]));
    expect(path).not.toContain("."); expect(path).not.toContain("");
  });
  it("falls back when the login shell is missing", async () => {
    expect(await resolvePath({ SHELL: "/missing/muster-shell", PATH: "/my/bin" }, "darwin")).toContain("/my/bin");
  });
  it("extracts login-shell PATH despite startup chatter", async () => {
    const path = await resolvePath({ SHELL: "/bin/sh", PATH: "/usr/bin:/bin" }, "linux");
    expect(path.split(":")).toContain("/usr/bin"); expect(path).not.toContain("__MUSTER");
  });
  it("keeps Windows executable paths", () => {
    expect(mergePath("", "C:\\Windows;D:\\tools;C:\\Windows", "", ";")).toBe("C:\\Windows;D:\\tools");
  });
});
