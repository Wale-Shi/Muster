import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const execute = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
it("runs the compiled ESM CLI through a bin symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-bin-"));
  try {
    const bin = join(root, "muster-daemon"); await symlink(entry, bin);
    const { stdout } = await execute(bin, ["--help"]);
    expect(stdout).toContain("muster-daemon start"); expect(stdout).toContain("--workspaces-dir");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects invalid concurrency before enrollment", async () => {
  await expect(execute(process.execPath, [entry, "start", "--concurrency", "0"])).rejects.toMatchObject({ stderr: expect.stringContaining("Concurrency") });
});
