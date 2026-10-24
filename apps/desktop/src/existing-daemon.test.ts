import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { existingDaemon } from "./existing-daemon.js";
it("reuses an existing matching CLI daemon without taking ownership of it", () => {
  const home = mkdtempSync(join(tmpdir(), "muster-daemon-lock-"));
  try {
    expect(existingDaemon(home, "http://127.0.0.1:7420")).toBe(false);
    mkdirSync(join(home, "daemon.lock"));
    writeFileSync(join(home, "daemon.lock/pid"), String(process.pid));
    writeFileSync(join(home, "machine.json"), JSON.stringify({ server: "http://127.0.0.1:7420" }));
    expect(existingDaemon(home, "http://127.0.0.1:7420")).toBe(true);
    expect(() => existingDaemon(home, "http://127.0.0.1:7421")).toThrow("already connected");
  } finally { rmSync(home, { force: true, recursive: true }); }
});
