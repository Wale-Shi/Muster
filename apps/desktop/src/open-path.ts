import { extname } from "node:path";

// Agent output is untrusted: opening a script, installer or executable would run it.
const EXECUTABLE = new Set([
  ".app", ".applescript", ".bat", ".cmd", ".command", ".com", ".csh", ".exe", ".fish", ".jar",
  ".ksh", ".msi", ".pkg", ".ps1", ".run", ".scpt", ".sh", ".terminal", ".vbs", ".workflow", ".zsh",
]);

export interface PathInfo {
  mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Directories, executables and scripts are revealed in the file manager instead of opened. */
export function revealOnly(path: string, info: PathInfo): boolean {
  if (info.isDirectory()) return true;
  if (EXECUTABLE.has(extname(path).toLowerCase())) return true;
  return info.isFile() && (info.mode & 0o111) !== 0;
}
