/* Pure parsing of a file with Git conflict markers into segments, and
 * re-assembly from per-conflict choices. No DOM — easy to test.
 *
 * Markers are `<<<<<<<`, `|||||||` (diff3 base), `=======`, `>>>>>>>` of ONE
 * consistent width per file. Git's default is 7, but `conflict-marker-size` in
 * .gitattributes (or a file whose own content contains 7-char markers) changes
 * it, so the width is detected from the first start marker and every later
 * marker must match it exactly. Anything that only LOOKS like a marker is
 * content and is preserved byte-for-byte. */

const startRe = (n) => new RegExp(`^<{${n}}(?: (.*))?$`);
const baseRe = (n) => new RegExp(`^\\|{${n}}(?: (.*))?$`);
const midRe = (n) => new RegExp(`^={${n}}$`);
const endRe = (n) => new RegExp(`^>{${n}}(?: (.*))?$`);

// Which marker width does this file use? The first line made only of 7+ `<`
// (optionally followed by a label) decides; `markerSize` overrides.
export function detectMarkerSize(text, markerSize) {
  if (markerSize && markerSize >= 3) return markerSize;
  for (const line of (text || "").split("\n")) { const m = /^(<{7,})(?: |$)/.exec(line); if (m) return m[1].length; }
  return 7;
}

// Parse into an ordered list of segments:
//   { type: "text", lines: [...] }
//   { type: "conflict", id, ours: [...], base: [...]|null, theirs: [...], oursLabel, theirsLabel }
// `count` is the number of conflict segments; `malformed` lists unterminated
// conflicts (kept VERBATIM as text so nothing is ever lost); `markerSize` is the
// width that was used.
export function parseConflicts(text, { markerSize } = {}) {
  const n = detectMarkerSize(text, markerSize);
  const RE_START = startRe(n), RE_BASE = baseRe(n), RE_MID = midRe(n), RE_END = endRe(n);
  const segments = [];
  const malformed = [];
  let count = 0;
  let mode = "text";                 // text | ours | base | theirs
  let text_ = [];
  let cur = null, raw = null;        // raw = the exact lines of the conflict being parsed (for lossless fallback)
  const flushText = () => { if (text_.length) { segments.push({ type: "text", lines: text_ }); text_ = []; } };
  const abandon = () => { // unterminated: return every raw line to the text stream, exactly as read
    if (!cur) return;
    malformed.push({ id: cur.id, startLine: cur.startLine });
    count--;
    text_.push(...raw);
    cur = null; raw = null; mode = "text";
  };
  const lines = (text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mode === "text") {
      const m = RE_START.exec(line);
      if (m) { flushText(); cur = { type: "conflict", id: count++, ours: [], base: null, theirs: [], oursLabel: m[1] || "current", theirsLabel: "incoming", startLine: i }; raw = [line]; mode = "ours"; continue; }
      text_.push(line); continue;
    }
    raw.push(line);
    if (mode === "ours") {
      if (RE_START.test(line)) { raw.pop(); abandon(); i--; continue; }          // a new conflict started before this one ended
      if (RE_BASE.test(line)) { cur.base = []; mode = "base"; continue; }
      if (RE_MID.test(line)) { mode = "theirs"; continue; }
      cur.ours.push(line); continue;
    }
    if (mode === "base") {
      if (RE_START.test(line)) { raw.pop(); abandon(); i--; continue; }
      if (RE_MID.test(line)) { mode = "theirs"; continue; }
      cur.base.push(line); continue;
    }
    if (mode === "theirs") {
      const m = RE_END.exec(line);
      if (m) { cur.theirsLabel = m[1] || "incoming"; delete cur.startLine; segments.push(cur); cur = null; raw = null; mode = "text"; continue; }
      if (RE_START.test(line)) { raw.pop(); abandon(); i--; continue; }
      cur.theirs.push(line); continue;
    }
  }
  if (cur) abandon();
  flushText();
  return { segments, count, malformed, markerSize: n };
}

// Rebuild the file text from segments + a choice per conflict id.
//   choices[id] = "ours" | "theirs" | "both" | "both-rev" | "custom"
//   custom[id]  = string (used when choice === "custom"); unresolved ids keep markers
export function assembleResolved(parsed, choices = {}, custom = {}) {
  const n = (parsed && parsed.markerSize) || 7;
  const out = [];
  for (const seg of parsed.segments) {
    if (seg.type === "text") { out.push(...seg.lines); continue; }
    const c = choices[seg.id];
    if (c === "ours") out.push(...seg.ours);
    else if (c === "theirs") out.push(...seg.theirs);
    else if (c === "both") out.push(...seg.ours, ...seg.theirs);
    else if (c === "both-rev") out.push(...seg.theirs, ...seg.ours);
    else if (c === "custom") out.push(...String(custom[seg.id] != null ? custom[seg.id] : "").split("\n"));
    else { // still unresolved → keep the markers (at the file's width) so nothing is silently dropped
      out.push("<".repeat(n) + " " + seg.oursLabel, ...seg.ours);
      if (seg.base != null) out.push("|".repeat(n) + " base", ...seg.base);
      out.push("=".repeat(n), ...seg.theirs, ">".repeat(n) + " " + seg.theirsLabel);
    }
  }
  return out.join("\n");
}

// Every conflict has a choice (a file with zero conflicts counts as resolved only
// when it also has no malformed blocks — those need the user's eyes).
export function isFullyResolved(parsed, choices = {}) {
  if (!parsed) return false;
  if (parsed.malformed && parsed.malformed.length) return false;
  return parsed.segments.every((s) => s.type !== "conflict" || choices[s.id]);
}

// The default text shown when a conflict is opened for manual editing.
export function previewFor(seg, choice) {
  if (choice === "ours") return seg.ours.join("\n");
  if (choice === "theirs") return seg.theirs.join("\n");
  if (choice === "both") return [...seg.ours, ...seg.theirs].join("\n");
  if (choice === "both-rev") return [...seg.theirs, ...seg.ours].join("\n");
  return [...seg.ours, ...seg.theirs].join("\n");
}

/* ---- line-ending / BOM preservation for the resolver -------------------------
 * The resolver works on LF text; the file is written back with exactly the
 * newline style, BOM and final-newline state it had. */
export function detectEol(text) {
  const s = String(text || "");
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/(^|[^\r])\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}
export function normalizeForEdit(text) {
  const s = String(text || "");
  const bom = s.charCodeAt(0) === 0xfeff;
  const body = bom ? s.slice(1) : s;
  const eol = detectEol(body);
  const lf = body.replace(/\r\n/g, "\n");
  const finalNewline = lf.endsWith("\n");
  return { text: finalNewline ? lf.slice(0, -1) : lf, eol, bom, finalNewline };
}
export function restoreFormat(text, { eol = "\n", bom = false, finalNewline = false } = {}) {
  let s = String(text || "");
  if (finalNewline && !s.endsWith("\n")) s += "\n";
  if (eol !== "\n") s = s.replace(/\n/g, eol);
  return (bom ? "﻿" : "") + s;
}
