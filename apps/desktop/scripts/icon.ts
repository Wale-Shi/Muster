// Rasterize the Muster mark — an "M" of four strokes whose five joints are small
// rings, like connected nodes — without an image service or native dependencies.
// Keep the geometry in sync with apps/web/src/components/MusterMark.tsx.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
const assets = fileURLToPath(new URL("../../assets/", import.meta.url));
mkdirSync(assets, { recursive: true });

type Point = readonly [number, number];
// Mark coordinates on a 24-unit grid, matching the web SVG viewBox.
const NODES: readonly Point[] = [[5, 18], [5, 6], [12, 13.5], [19, 6], [19, 18]];
const RING = 1.7;
const STROKE = 1.1;

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const tag = Buffer.from(type); const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); tag.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8); return out;
}
function segment(p: Point, a: Point, b: Point) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// Strokes stop at the ring edge so each joint reads as a node, not a dot on a line.
const SEGMENTS = NODES.slice(1).map((b, i) => {
  const a = NODES[i]!; const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [ux, uy] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  return [[a[0] + ux * RING, a[1] + uy * RING], [b[0] - ux * RING, b[1] - uy * RING]] as const;
});
/** Which part of the mark covers grid point p: "line", "ring" or nothing. */
function mark(p: Point, stroke: number): "line" | "ring" | null {
  if (NODES.some((n) => Math.abs(Math.hypot(p[0] - n[0], p[1] - n[1]) - RING) < stroke / 2)) return "ring";
  if (SEGMENTS.some(([a, b]) => segment(p, a, b) < stroke / 2)) return "line";
  return null;
}

type Rgb = readonly [number, number, number];
const TILE: Rgb = [24, 24, 27];
const LINE: Rgb = [228, 228, 236];
const NODE: Rgb = [139, 140, 248];

function png(size: number, kind: "app" | "tray") {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  const samples = 4;
  // App icons follow the macOS grid: an 824/1024 rounded tile with the mark inset.
  const tile = kind === "app" ? 0.805 : 1;
  const inset = (1 - tile) / 2;
  const scale = kind === "app" ? 0.64 : 1; // mark width relative to the tile
  const stroke = kind === "tray" ? STROKE * 1.6 : STROKE;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = (x + (sx + 0.5) / samples) / size, py = (y + (sy + 0.5) / samples) / size;
      const tx = (px - inset) / tile, ty = (py - inset) / tile;
      const inTile = kind === "app" && Math.hypot(Math.max(0, Math.abs(tx - 0.5) - 0.275), Math.max(0, Math.abs(ty - 0.5) - 0.275)) < 0.225;
      const grid: Point = [12 + ((tx - 0.5) / scale) * 24, 12 + ((ty - 0.5) / scale) * 24];
      const part = kind === "app" && !inTile ? null : mark(grid, stroke);
      const color = kind === "tray" ? [0, 0, 0] as Rgb : part === "ring" ? NODE : part === "line" ? LINE : TILE;
      if (part || inTile) { a += 255; r += color[0]; g += color[1]; b += color[2]; }
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    if (a) { rows[offset] = Math.round(r / (a / 255)); rows[offset + 1] = Math.round(g / (a / 255)); rows[offset + 2] = Math.round(b / (a / 255)); rows[offset + 3] = Math.round(a / (samples * samples)); }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
writeFileSync(new URL("icon.png", `file://${assets}/`), png(1024, "app"));
// Menu bar template image: 18pt with a @2x variant that nativeImage picks up.
writeFileSync(new URL("tray.png", `file://${assets}/`), png(18, "tray"));
writeFileSync(new URL("tray@2x.png", `file://${assets}/`), png(36, "tray"));
const entries = ([["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]] as const).map(([tag, size]) => { const image = png(size, "app"); const head = Buffer.alloc(8); head.write(tag); head.writeUInt32BE(image.length + 8, 4); return Buffer.concat([head, image]); });
const icns = Buffer.alloc(8); icns.write("icns"); icns.writeUInt32BE(8 + entries.reduce((sum, e) => sum + e.length, 0), 4);
writeFileSync(new URL("icon.icns", `file://${assets}/`), Buffer.concat([icns, ...entries]));
const win = png(256, "app"); const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(win.length, 14); ico.writeUInt32LE(22, 18);
writeFileSync(new URL("icon.ico", `file://${assets}/`), Buffer.concat([ico, win]));
