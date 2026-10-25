import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inside, productionId, smokeId } from "../src/install-location.js";
const exec = promisify(execFile);
export type Run = (file: string, args: string[]) => Promise<string>;
export const run: Run = async (file, args) => (await exec(file, args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
export const bundleId = (bundle: string, command = run) => command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(bundle, "Contents/Info.plist")]);
export async function assertReleaseIdle(release: string, command = run) {
  // comm is the executable path, without argv; paths containing spaces remain intact.
  const processes = await command("/bin/ps", ["-axo", "pid=,comm="]);
  let root: string;
  try { root = await realpath(release); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const line of processes.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) { if (line.trim()) throw new Error(`Cannot inspect process: ${line}`); continue; }
    const [, pid, executable] = match;
    if (!executable?.includes(".app/Contents/MacOS/")) continue;
    const bundle = resolve(executable, "../../..");
    let actual: string;
    try { actual = await realpath(bundle); }
    catch (error) { if (inside(root, bundle)) throw error; continue; }
    if (inside(root, actual) && await bundleId(actual, command) === productionId) {
      throw new Error(`Muster PID ${pid} is running from ${executable}. Quit that release instance before packaging; no process was stopped.`);
    }
  }
}
export async function unregisterRelease(release: string, bundle: string, command = run, warn: (message: string) => void = console.warn) {
  if (!inside(await realpath(release), await realpath(bundle))) throw new Error("Refusing to unregister an app outside release");
  try {
    await command("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", bundle]);
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string } | null;
    const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
    // Fresh, never-registered bundles return kLSApplicationNotFoundErr.
    // Inspect command output, not the exception message (which includes argv).
    const scanErrors = [...output.matchAll(/failed to scan [^\r\n]*: (-?\d+)\b/g)].map((match) => match[1]);
    if (scanErrors.length > 0 && scanErrors.every((code) => code === "-10814")) return;
    warn(`Could not unregister release app ${bundle}: ${String(error)}${output.trim() ? `\n${output.trim()}` : ""}. Packaging succeeded; installation-path validation remains active.`);
  }
}
export async function prepareSmokeBundle(bundle: string, command = run) {
  await command("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${smokeId}`, join(bundle, "Contents/Info.plist")]);
  await command("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
  if (await bundleId(bundle, command) !== smokeId) throw new Error("Smoke bundle identity mismatch");
}
