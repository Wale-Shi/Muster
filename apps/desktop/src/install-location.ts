import { realpathSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const productionId = "dev.muster.desktop";
export const smokeId = `${productionId}.smoke`;
export function inside(root: string, path: string) {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export function needsInstallation(options: { platform: string; packaged: boolean; executable: string; home: string; bundleId: string; smoke: boolean; data?: string | undefined }) {
  if (options.platform !== "darwin" || !options.packaged) return false;
  if (options.bundleId === smokeId && options.smoke && options.data && isAbsolute(options.data) && resolve(options.data) !== join(options.home, ".muster")) return false;
  const bundle = realpathSync(resolve(options.executable, "../../.."));
  return !["/Applications", join(realpathSync(options.home), "Applications")].some((root) => inside(root, bundle));
}
export function moveWithoutReplacement(targets: string[], move: (options: { conflictHandler: () => boolean }) => boolean) {
  for (const target of targets) {
    try { lstatSync(target); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return move({ conflictHandler: () => false });
}
