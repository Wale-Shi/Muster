import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StateError } from "../orchestrator/state.js";

export const imageLimit = 10 * 1024 * 1024;
export interface ImageMapping {
  machineId: string;
  sourceDataDir: string;
  dataDir: string;
  sourceWorkspacesDir: string;
  workspacesDir: string;
}
export const inside = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const denied = () => new StateError("Image path is not allowed", 403);

export function imagePath(url: string): string {
  let path = url;
  try {
    if (path.startsWith("muster-local:")) path = decodeURIComponent(path.slice(13));
    if (path.startsWith("file:")) {
      const parsed = new URL(path);
      if (parsed.hostname && parsed.hostname !== "localhost" || parsed.search || parsed.hash) throw denied();
      path = parsed.pathname.replace(/^\/([A-Za-z]:\/)/, "$1");
    }
    path = decodeURIComponent(path);
  } catch { throw denied(); }
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path) || path.split(/[\\/]/).includes("..") || /%[0-9a-f]{2}/i.test(path)) throw denied();
  return resolve(path);
}

export function mapImagePath(path: string, buildId: string, mapping: ImageMapping): { root: string; path: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(buildId)) throw denied();
  const data = resolve(mapping.sourceDataDir), workspaces = resolve(mapping.sourceWorkspacesDir);
  // Check the broad trees first; dataDir must never authorize another build.
  const protectedRoots = [join(data, "artifacts"), join(data, "workspaces"), workspaces];
  for (const root of protectedRoots) {
    if (path === root || inside(root, path)) {
      const buildRoot = join(root, buildId);
      if (!inside(buildRoot, path)) throw denied();
      const target = root === join(data, "artifacts") ? join(mapping.dataDir, "artifacts", buildId) : join(mapping.workspacesDir, buildId);
      return { root: inside(resolve(mapping.dataDir), resolve(target)) ? mapping.dataDir : mapping.workspacesDir, path: join(target, relative(buildRoot, path)) };
    }
  }
  if (!inside(data, path)) throw denied();
  return { root: mapping.dataDir, path: join(mapping.dataDir, relative(data, path)) };
}

// Validate the entire root-relative chain both before and after opening. Never read from
// a path after validation: all bytes come from the same checked, no-follow file handle.
export async function safeRead(root: string, path: string, limit: number): Promise<Buffer> {
  const canonicalRoot = await realpath(root);
  const absoluteRoot = resolve(root);
  if (!inside(absoluteRoot, path)) throw denied();
  const parts = relative(absoluteRoot, path).split(sep);
  let cursor = canonicalRoot;
  const chain: Array<{ path: string; dev: number; ino: number }> = [];
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw denied();
    chain.push({ path: cursor, dev: stat.dev, ino: stat.ino });
  }
  const handle = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const last = chain.at(-1)!;
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== last.dev || stat.ino !== last.ino) throw denied();
    if (stat.size > limit) throw new StateError("Image exceeds 10 MiB", 413);
    const verify = async () => {
      if (await realpath(root) !== canonicalRoot) throw denied();
      for (const entry of chain) {
        const current = await lstat(entry.path);
        if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino) throw denied();
      }
      if (await realpath(cursor) !== cursor) throw denied();
      // Linux exposes the actual open file, including renamed/replaced parents.
      if (process.platform === "linux" && await realpath(`/proc/self/fd/${handle.fd}`) !== cursor) throw denied();
    };
    await verify();
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new StateError("Image exceeds 10 MiB", 413);
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || length !== stat.size) throw denied();
    await verify();
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function readImage(root: string, path: string): Promise<{ bytes: Buffer; mime: string }> {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  const mime = types[extension];
  if (!mime) throw new StateError("Unsupported image type", 415);
  const bytes = await safeRead(root, path, imageLimit);
  const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : mime === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mime === "image/gif" ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
    : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new StateError("Unsupported image content", 415);
  return { bytes, mime };
}
