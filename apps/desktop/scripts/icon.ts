// Rasterize the existing sidebar Command mark without an image service or native dependencies.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
const assets = fileURLToPath(new URL("../../assets/", import.meta.url));
mkdirSync(assets, { recursive: true });
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const tag = Buffer.from(type); const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); tag.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8); return out;
}
function png(size: number, tray = false) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const px = (x + (sx + 0.5) / 2) / size, py = (y + (sy + 0.5) / 2) / size;
      const corner = Math.hypot(Math.max(0, Math.abs(px - 0.5) - 0.29), Math.max(0, Math.abs(py - 0.5) - 0.29));
      const background = !tray && corner < 0.18;
      const low = 0.36, high = 0.64, radius = 0.09, stroke = 0.022;
      const line = (((Math.abs(px - low) < stroke || Math.abs(px - high) < stroke) && py >= low - radius && py <= high + radius) || ((Math.abs(py - low) < stroke || Math.abs(py - high) < stroke) && px >= low - radius && px <= high + radius));
      const loop = [low - radius, high + radius].some((cx) => [low - radius, high + radius].some((cy) => Math.abs(Math.hypot(px - cx, py - cy) - radius) < stroke));
      const mark = line || loop;
      if (mark || background) { a += 255; r += mark ? (tray ? 255 : 183) : 24; g += mark ? (tray ? 255 : 190) : 24; b += mark ? 255 : 27; }
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    if (a) { rows[offset] = Math.round(r / (a / 255)); rows[offset + 1] = Math.round(g / (a / 255)); rows[offset + 2] = Math.round(b / (a / 255)); rows[offset + 3] = Math.round(a / 4); }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
writeFileSync(new URL("icon.png", `file://${assets}/`), png(1024));
writeFileSync(new URL("tray.png", `file://${assets}/`), png(32, true));
const entries = ([["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]] as const).map(([tag, size]) => { const image = png(size); const head = Buffer.alloc(8); head.write(tag); head.writeUInt32BE(image.length + 8, 4); return Buffer.concat([head, image]); });
const icns = Buffer.alloc(8); icns.write("icns"); icns.writeUInt32BE(8 + entries.reduce((sum, e) => sum + e.length, 0), 4);
writeFileSync(new URL("icon.icns", `file://${assets}/`), Buffer.concat([icns, ...entries]));
const win = png(256); const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(win.length, 14); ico.writeUInt32LE(22, 18);
writeFileSync(new URL("icon.ico", `file://${assets}/`), Buffer.concat([ico, win]));
