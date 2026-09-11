"use strict";
/*
 * Minimal, dependency-free ZIP reader/writer (DEFLATE via Node's zlib).
 * Good enough for bundling small JSON files for backup/restore.
 */
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ZIP has no 64-bit support here: refuse (loudly) rather than write a corrupt archive.
const ZIP32_MAX = 0xffffffff;
const MAX_ENTRIES = 0xffff;
// Names are UTF-8 and flagged as such (general-purpose bit 11), so non-ASCII paths
// (é, 日本語, emoji) extract with their real names in Explorer/Finder/7-Zip.
const UTF8_FLAG = 0x0800;

// entries: [{ name, data: Buffer|string }] -> Buffer (a valid .zip)
function zip(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error(`zip: too many entries (${entries.length} > ${MAX_ENTRIES})`);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name).replace(/\\/g, "/"), "utf8");
    if (nameBuf.length > 0xffff) throw new Error(`zip: name too long: ${e.name.slice(0, 80)}…`);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    if (data.length > ZIP32_MAX) throw new Error(`zip: ${e.name} is larger than 4 GiB`);
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data);
    const store = comp.length >= data.length;       // never inflate tiny files
    const method = store ? 0 : 8;
    const body = store ? data : comp;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(UTF8_FLAG, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);                     // 1980-01-01
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(UTF8_FLAG, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));

    offset += lfh.length + nameBuf.length + body.length;
    if (offset > ZIP32_MAX) throw new Error("zip: archive would exceed 4 GiB (ZIP64 is not supported)");
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, eocd]);
}

// Buffer -> [{ name, data: Buffer }]
function unzip(buf) {
  let p = buf.length - 22;
  while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) p--;
  if (p < 0) throw new Error("Not a valid zip file");
  const count = buf.readUInt16LE(p + 10);
  let cd = buf.readUInt32LE(p + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.toString("utf8", cd + 46, cd + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + compSize);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    out.push({ name, data });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { zip, unzip, crc32 };
