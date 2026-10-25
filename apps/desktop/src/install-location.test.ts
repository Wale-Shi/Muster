import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inside, moveWithoutReplacement, needsInstallation, productionId, smokeId } from "./install-location.js";
import { assertReleaseIdle, prepareSmokeBundle, unregisterRelease } from "../scripts/mac-bundle.js";
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "muster-location-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = { platform: "darwin", packaged: true, executable: "/missing/Muster.app/Contents/MacOS/Muster", home: tmpdir(), bundleId: productionId, smoke: false };
it.each(["/Applications/Muster.app", "/Applications/Tools/Muster.app"])("recognizes Applications boundary %s", (path) => { expect(inside("/Applications", path)).toBe(true); });
it.each(["/Applications-old/Muster.app", "/tmp/Muster.app", "/Volumes/Muster/Muster.app"])("rejects outside boundary %s", (path) => { expect(inside("/Applications", path)).toBe(false); });
it("allows user Applications but resolves symlink escapes", () => {
  const home = fixture(); const installed = join(home, "Applications/Muster.app"); mkdirSync(installed, { recursive: true });
  expect(needsInstallation({ ...base, home, executable: join(installed, "Contents/MacOS/Muster") })).toBe(false);
  rmSync(installed, { recursive: true }); const release = join(home, "release/Muster.app"); mkdirSync(release, { recursive: true }); symlinkSync(release, installed);
  expect(needsInstallation({ ...base, home, executable: join(installed, "Contents/MacOS/Muster") })).toBe(true);
});
it.each([{ packaged: false }, { platform: "linux" }, { platform: "win32" }])("leaves development and other platforms alone: %j", (override) => { expect(needsInstallation({ ...base, ...override })).toBe(false); });
it("requires both smoke identity and isolated data to bypass installation", () => {
  const root = fixture(); const bundle = join(root, "Muster.app"); mkdirSync(bundle);
  const options = { ...base, executable: join(bundle, "Contents/MacOS/Muster"), smoke: true, data: root };
  expect(needsInstallation(options)).toBe(true);
  expect(needsInstallation({ ...options, bundleId: smokeId })).toBe(false);
  expect(needsInstallation({ ...options, bundleId: smokeId, data: join(base.home, ".muster") })).toBe(true);
  expect(needsInstallation({ ...options, bundleId: smokeId, smoke: false })).toBe(true);
});
it("moves only absent destinations and rejects conflicts arising during move", () => {
  const target = join(fixture(), "Muster.app"); const move = vi.fn((options) => { expect(options.conflictHandler()).toBe(false); return true; });
  expect(moveWithoutReplacement([target], move)).toBe(true);
  writeFileSync(target, "installed"); move.mockClear();
  expect(moveWithoutReplacement([target], move)).toBe(false); expect(move).not.toHaveBeenCalled();
});
it("preserves cancellation and move errors", () => {
  const target = join(fixture(), "missing");
  expect(moveWithoutReplacement([target], () => false)).toBe(false);
  expect(() => moveWithoutReplacement([target], () => { throw new Error("denied"); })).toThrow("denied");
});
it("blocks a release production process including paths with spaces before subsequent work", async () => {
  const release = join(fixture(), "release folder"); const bundle = join(release, "mac/Muster.app"); mkdirSync(bundle, { recursive: true });
  const command = vi.fn(async (file: string) => file === "/bin/ps" ? `42 ${bundle}/Contents/MacOS/Muster` : productionId);
  const build = vi.fn();
  await expect(assertReleaseIdle(release, command).then(build)).rejects.toThrow("PID 42"); expect(build).not.toHaveBeenCalled();
});
it("ignores installed and smoke identities", async () => {
  const release = fixture(); const bundle = join(release, "Muster.app"); mkdirSync(bundle);
  await expect(assertReleaseIdle(release, async (file) => file === "/bin/ps" ? `42 ${bundle}/Contents/MacOS/Muster\n43 /Applications/Muster.app/Contents/MacOS/Muster` : smokeId)).resolves.toBeUndefined();
});
it("fails closed on process inspection errors", async () => {
  await expect(assertReleaseIdle(fixture(), async () => { throw new Error("ps denied"); })).rejects.toThrow("ps denied");
  await expect(assertReleaseIdle(fixture(), async () => "invalid")).rejects.toThrow("Cannot inspect");
});
it("unregisters only a release bundle", async () => {
  const release = fixture(); const bundle = join(release, "Muster.app"); mkdirSync(bundle); const command = vi.fn(async () => "");
  await unregisterRelease(release, bundle, command); expect(command.mock.calls[0]).toEqual([expect.stringContaining("lsregister"), ["-u", bundle]]);
  await expect(unregisterRelease(release, fixture(), command)).rejects.toThrow("outside release");

});
it("changes and signs only the supplied smoke copy then verifies identity", async () => {
  const bundle = join(fixture(), "Muster.app"); const command = vi.fn(async () => smokeId);
  await prepareSmokeBundle(bundle, command);
  expect(command.mock.calls).toEqual([
    ["/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${smokeId}`, join(bundle, "Contents/Info.plist")]],
    ["/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]],
    ["/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(bundle, "Contents/Info.plist")]],
  ]);
  await expect(prepareSmokeBundle(bundle, async () => productionId)).rejects.toThrow("identity mismatch");
});

it.each(["stdout", "stderr"])("treats an unregistered bundle reported on %s as success", async (stream) => {
  const release = fixture(); const bundle = join(release, "Muster.app"); mkdirSync(bundle);
  const warn = vi.fn();
  await expect(unregisterRelease(release, bundle, async () => {
    throw Object.assign(new Error("Command failed"), { code: 1, [stream]: `failed to scan ${bundle}: -10814\n from spotlight` });
  }, warn)).resolves.toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
});
it.each(["permission denied", "failed to scan app: -108140", "failed to scan app: -10814\nfailed to scan app: -50"])("warns without failing packaging for other unregister errors: %s", async (stderr) => {
  const release = fixture(); const bundle = join(release, "Muster.app"); mkdirSync(bundle);
  const warn = vi.fn();
  await expect(unregisterRelease(release, bundle, async () => { throw Object.assign(new Error("lsregister failed"), { stderr }); }, warn)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(stderr));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(bundle));
});
it("warns when lsregister cannot be executed", async () => {
  const release = fixture(); const bundle = join(release, "Muster.app"); mkdirSync(bundle); const warn = vi.fn();
  await expect(unregisterRelease(release, bundle, async () => { throw new Error("spawn ENOENT"); }, warn)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("spawn ENOENT"));
});
