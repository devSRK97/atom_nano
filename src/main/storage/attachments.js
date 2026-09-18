"use strict";
/* Durable attachment store.
 *
 * Pasted / dropped images arrive from the renderer as base64 `data` with no file
 * behind them. Before a prompt is dispatched every such attachment is written
 * once to <userData>/attachments/<sha256>.<ext> and gains a stable `path` (and
 * `sha`). From then on every consumer works from the file:
 *   - Claude gets the bytes read back from disk (base64 image block)
 *   - Codex gets `{ type: "localImage", path }`
 *   - the persisted user message keeps path + thumbnail (never the raw bytes)
 *   - retries, reopen, steering and provider transfers all still find it
 * Content addressing means the same image pasted twice is stored once — that
 * deduplicates FILES, never what the model is sent. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let baseDir = null;
function dir() {
  if (baseDir) return baseDir;
  try { baseDir = path.join(require("electron").app.getPath("userData"), "attachments"); }
  catch { baseDir = path.join(require("os").tmpdir(), "atomnano-attachments"); }
  return baseDir;
}
function setDir(d) { if (d) baseDir = d; }

const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/svg+xml": ".svg" };

/* Persist one attachment if it only lives in memory. Returns a NEW object with
 * `path` (+ `sha`) set; `data` is dropped from the returned record (the file is
 * the source of truth). Throws when the write fails — callers must surface it,
 * never send a prompt that silently lost its image. */
function persist(att) {
  if (!att || typeof att !== "object") return att;
  if (att.path) return att;
  if (!att.data) return att;
  const buf = Buffer.from(String(att.data), "base64");
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const ext = EXT[String(att.mediaType || "").toLowerCase()] || (path.extname(att.name || "") || ".bin");
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, sha + ext);
  if (!fs.existsSync(file)) {
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  const { data, ...rest } = att;
  return { ...rest, path: file, sha, size: buf.length };
}
function persistAll(atts) { return (Array.isArray(atts) ? atts : []).map(persist); }

// Base64 bytes for a stored image (Claude's image block). Empty string if unreadable.
function readBase64(p) { try { return fs.readFileSync(p).toString("base64"); } catch { return ""; } }

// What gets written into the transcript: metadata + thumbnail + durable path.
function light(atts) {
  return (Array.isArray(atts) ? atts : []).map((a) => ({ kind: a.kind, name: a.name, path: a.path, mediaType: a.mediaType, thumb: a.thumb, sha: a.sha, size: a.size }));
}

module.exports = { persist, persistAll, readBase64, light, setDir, dir };
