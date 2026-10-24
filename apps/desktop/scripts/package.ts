import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectron } from "./electron.js";
import { build, Platform } from "electron-builder";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(desktop, "../..");
await ensureElectron(root);
const stage = join(desktop, ".stage");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const workspaces = ["packages/shared", "apps/server", "apps/daemon"];
for (const workspace of workspaces) {
  const dest = join(stage, workspace);
  await mkdir(dest, { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, workspace, "package.json"), "utf8")) as Record<string, unknown>;
  delete pkg.scripts; delete pkg.devDependencies;
  await writeFile(join(dest, "package.json"), JSON.stringify(pkg));
  await cp(join(root, workspace, "dist"), join(dest, "dist"), { recursive: true });
}
await cp(join(root, "apps/web/dist"), join(stage, "apps/web/dist"), { recursive: true });
await writeFile(join(stage, "package.json"), JSON.stringify({ name: "muster-runtime", version: "0.1.0", private: true, workspaces }));
// Reuse resolved dependency versions from the repository lockfile.
await cp(join(root, "package-lock.json"), join(stage, "package-lock.json"));
await new Promise<void>((done, reject) => {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
  child.once("error", reject); child.once("exit", (code) => code === 0 ? done() : reject(new Error(`Runtime dependency install failed: ${code}`)));
});
// Replace npm workspace links with real directories; packaged apps must not depend on the checkout.
for (const name of ["shared", "server", "daemon"]) {
  const path = join(stage, "node_modules/@muster", name);
  await rm(path, { force: true, recursive: true });
  await cp(join(stage, name === "shared" ? "packages/shared" : `apps/${name}`), path, { recursive: true });
}
try {
await build({
  targets: process.platform === "darwin" ? Platform.MAC.createTarget(["dir", "dmg"]) : process.platform === "win32" ? Platform.WINDOWS.createTarget(["nsis"]) : Platform.LINUX.createTarget(["AppImage"]),
  projectDir: desktop,
  config: {
    appId: "dev.muster.desktop", productName: "Muster", electronVersion: JSON.parse(await readFile(join(root, "node_modules/electron/package.json"), "utf8")).version as string,
    directories: { output: "release", buildResources: "assets" },
    files: ["dist/src/**/*", "package.json"],
    extraResources: [{ from: stage, to: "runtime", filter: ["**/*", "!package-lock.json"] }, { from: "assets", to: "assets", filter: ["*.png"] }],
    asar: true, npmRebuild: false, electronDist: join(root, "node_modules/electron/dist"),
    mac: { target: ["dir", "dmg"], icon: "assets/icon.icns", category: "public.app-category.developer-tools", identity: "-", hardenedRuntime: false },
    win: { icon: "assets/icon.ico" }, linux: { icon: "assets/icon.png", category: "Development" },
    dmg: { sign: false },
  },
});

} catch (error) {
  // A raw HFS disk image can be authored entirely in userspace. This also works
  // on macOS hosts where DiskImages cannot allocate a virtual device for UDZO.
  if (process.platform !== "darwin" || !/device not configured|设备未配置|DiskManagement/i.test(String(error))) throw error;
  console.warn("DiskImages devices unavailable; creating an uncompressed HFS distribution DMG without mounting.");
  const folder = join(stage, "dmg-content");
  await mkdir(folder);
  const appFolder = join(desktop, "release", process.arch === "arm64" ? "mac-arm64" : "mac", "Muster.app");
  await cp(appFolder, join(folder, "Muster.app"), { recursive: true, verbatimSymlinks: true });
  await symlink("/Applications", join(folder, "Applications"));
  const image = join(desktop, "release", `Muster-0.1.0-${process.arch}.dmg`);
  await rm(image, { force: true });
  await new Promise<void>((done, reject) => {
    const child = spawn("hdiutil", ["makehybrid", "-hfs", "-hfs-volume-name", "Muster", "-o", image, folder], { stdio: "inherit" });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? done() : reject(new Error(`HFS DMG creation failed: ${code}`)));
  });
  await rm(folder, { recursive: true, force: true });
  console.log(`Built HFS DMG: ${image}`);
}
