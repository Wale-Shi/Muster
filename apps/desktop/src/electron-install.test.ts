import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureElectron } from "../scripts/electron.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "muster-electron-")); roots.push(root);
  const directory = join(root, "node_modules/electron");
  await mkdir(directory, { recursive: true });
  const install = vi.fn(async () => {
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "path.txt"), "electron");
    await writeFile(join(directory, "dist/electron"), "binary");
  });
  return { root, directory, install };
}
it("installs a missing binary and reuses an existing binary", async () => {
  const f = await fixture();
  expect(await ensureElectron(f.root, f.install)).toBe(join(f.directory, "dist/electron"));
  await ensureElectron(f.root, f.install);
  expect(f.install).toHaveBeenCalledTimes(1);
  await rm(join(f.directory, "dist"), { recursive: true });
  await ensureElectron(f.root, f.install);
  expect(f.install).toHaveBeenCalledTimes(2);
});
it("reports download failure or an installer that leaves no binary", async () => {
  const f = await fixture();
  await expect(ensureElectron(f.root, async () => { throw new Error("offline"); })).rejects.toThrow("Electron binary download failed");
  await expect(ensureElectron(f.root, async () => {})).rejects.toThrow("Electron binary download failed");
});
