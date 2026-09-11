"use strict";
/*
 * AtomNano icon generator — zero native dependencies.
 *
 * Draws the warm "atom" mark (glowing amber nucleus, two electron orbits on a warm-dark rounded
 * tile) at any size and writes every icon the packagers need:
 *   build/icon.png       256×256  (Linux window icon, electron-builder fallback)
 *   build/icon-1024.png  1024×1024
 *   build/icon.ico       PNG-embedded ICO (Windows)
 *   build/icon.icns      PNG-embedded ICNS with 128/256/512/1024 (macOS — no iconutil needed)
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

/* Render the mark at SIZE px. Every geometric constant is defined on the 256-px reference
 * design and scaled by k, so all sizes are the same picture. Returns RGBA bytes. */
function render(SIZE) {
  const k = SIZE / 256;
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const cx = (SIZE - 1) / 2, cy = (SIZE - 1) / 2;
  function setPx(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    const sa = a / 255, da = px[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; return; }
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / outA);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / outA);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / outA);
    px[i + 3] = Math.round(outA * 255);
  }
  // Rounded-rect mask → coverage 0..1
  const tileR = 52 * k, minX = 8 * k, minY = 8 * k, maxX = SIZE - 1 - 8 * k, maxY = SIZE - 1 - 8 * k;
  function tileCoverage(x, y) {
    let dx = 0, dy = 0;
    if (x < minX + tileR) dx = (minX + tileR) - x; else if (x > maxX - tileR) dx = x - (maxX - tileR);
    if (y < minY + tileR) dy = (minY + tileR) - y; else if (y > maxY - tileR) dy = y - (maxY - tileR);
    if (dx === 0 && dy === 0) return (x < minX || x > maxX || y < minY || y > maxY) ? 0 : 1;
    return clamp(tileR - Math.sqrt(dx * dx + dy * dy) + 0.5, 0, 1);
  }
  // 1) warm-dark background with a vertical gradient + soft glow toward the upper centre
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const cov = tileCoverage(x, y); if (cov <= 0) continue;
    const t = y / SIZE;
    let r = lerp(0x2c, 0x16, t), g = lerp(0x20, 0x10, t), b = lerp(0x17, 0x0d, t);
    const glow = clamp(1 - Math.hypot(x - cx, y - (cy - 30 * k)) / (150 * k), 0, 1) * 0.18;
    r += glow * 0x60; g += glow * 0x38; b += glow * 0x14;
    setPx(x, y, clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255), Math.round(255 * cov));
  }
  // 2) electron orbits (two rotated ellipses)
  function drawOrbit(angleDeg, a, b, thickness, cr, cg, cb) {
    const th = (angleDeg * Math.PI) / 180, ca = Math.cos(-th), sa = Math.sin(-th);
    const kk = thickness / (2 * ((a + b) / 2));
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      if (tileCoverage(x, y) <= 0) continue;
      const dx = x - cx, dy = y - cy;
      const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
      const edge = Math.abs(Math.sqrt((rx * rx) / (a * a) + (ry * ry) / (b * b)) - 1);
      if (edge < kk) setPx(x, y, cr, cg, cb, Math.round(220 * clamp(1 - edge / kk, 0, 1)));
    }
  }
  drawOrbit(34, 96 * k, 34 * k, 9 * k, 0xe6, 0xa3, 0x52);
  drawOrbit(-34, 96 * k, 34 * k, 9 * k, 0xd6, 0x8c, 0x42);
  // 3) electron dot on the first orbit
  { const th = (34 * Math.PI) / 180, ex = cx + 96 * k * Math.cos(th), ey = cy + 96 * k * Math.sin(th), rad = 11 * k;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { const d = Math.hypot(x - ex, y - ey); if (d < rad) setPx(x, y, 0xff, 0xd9, 0x8a, Math.round(255 * clamp(rad - d, 0, 1))); } }
  // 4) glowing nucleus
  { const R = 44 * k, core = 32 * k, halo = 12 * k;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - cx, y - cy); if (d >= R) continue;
      const t = clamp(d / core, 0, 1);
      const r = lerp(0xff, 0xd2, t), g = lerp(0xc8, 0x7a, t), b = lerp(0x78, 0x2c, t);
      const a = d < core ? 255 : Math.round(255 * clamp((R - d) / halo, 0, 1) * 0.55);
      setPx(x, y, r, g, b, a);
    } }
  return px;
}

/* ---- encoders ---- */
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(px, SIZE) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) { raw[y * (SIZE * 4 + 1)] = 0; px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function encodeICO(pngBuf) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16); entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(pngBuf.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}
// ICNS: "icns" + total length, then one element per size — PNG payloads are valid for these types.
const ICNS_TYPES = { 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" };
function encodeICNS(pngs) {
  const elems = Object.entries(pngs).map(([size, png]) => { const h = Buffer.alloc(8); h.write(ICNS_TYPES[size], 0, "ascii"); h.writeUInt32BE(png.length + 8, 4); return Buffer.concat([h, png]); });
  const total = 8 + elems.reduce((n, e) => n + e.length, 0);
  const head = Buffer.alloc(8); head.write("icns", 0, "ascii"); head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...elems]);
}

const buildDir = path.join(__dirname, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });
const pngs = {};
for (const size of [128, 256, 512, 1024]) pngs[size] = encodePNG(render(size), size);
fs.writeFileSync(path.join(buildDir, "icon.png"), pngs[256]);
fs.writeFileSync(path.join(buildDir, "icon-1024.png"), pngs[1024]);
fs.writeFileSync(path.join(buildDir, "icon.ico"), encodeICO(pngs[256]));
fs.writeFileSync(path.join(buildDir, "icon.icns"), encodeICNS(pngs));
console.log("AtomNano icons written -> build/icon.png, build/icon-1024.png, build/icon.ico, build/icon.icns");
