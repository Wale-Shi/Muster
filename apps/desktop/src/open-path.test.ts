import { describe, expect, it } from "vitest";
import { revealOnly } from "./open-path.js";

const file = (mode = 0o644) => ({ mode, isDirectory: () => false, isFile: () => true });
const directory = () => ({ mode: 0o755, isDirectory: () => true, isFile: () => false });

describe("desktop open-path", () => {
  it("opens ordinary files", () => {
    expect(revealOnly("/Users/me/repo/README.md", file())).toBe(false);
    expect(revealOnly("/Users/me/repo/src/main.ts", file(0o600))).toBe(false);
  });
  it("reveals directories instead of opening them", () => {
    expect(revealOnly("/Users/me/repo", directory())).toBe(true);
    expect(revealOnly("/Applications/Muster.app", directory())).toBe(true);
  });
  it("reveals scripts and installers whatever their permission bits", () => {
    for (const path of ["/tmp/run.SH", "/tmp/install.pkg", "/tmp/task.command", "/tmp/a.sh", "/tmp/a.exe", "/tmp/a.ps1", "/tmp/a.jar", "/tmp/a.terminal", "/tmp/a.scpt", "/tmp/a.workflow"]) {
      expect(revealOnly(path, file())).toBe(true);
    }
  });
  it("reveals any regular file with an execute bit", () => {
    expect(revealOnly("/Users/me/repo/tool", file(0o755))).toBe(true);
    expect(revealOnly("/Users/me/repo/tool", file(0o744))).toBe(true);
    expect(revealOnly("/Users/me/repo/tool", file(0o644))).toBe(false);
  });
});
