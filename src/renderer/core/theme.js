/* AtomNano renderer — Theme / accent / font size and the per-project taskbar tile.
 * One of the ES modules the former single app.js was split into (see ARCHITECTURE.md §5). */
import { cm, stateActiveFile } from "../editor/editor-pane.js";
import { updateEditorStatus } from "../editor/symbols.js";
import { FONT_SIZES } from "./catalog.js";
import { $, baseName } from "./dom.js";
import { atom, state } from "./state.js";

/* ----------------------------- accent / font ----------------------------- */
export function applyTheme(t) { document.documentElement.setAttribute("data-theme", t || "amber"); }
// Window title bar + OS title (taskbar hover / Alt-Tab) show the project folder.
export function applyWindowTitle() {
  const name = baseName(state.project) || "AtomNano";
  document.title = name;          // taskbar / Alt-Tab show the project name only
  const el = $("brandProject");
  if (el) { el.textContent = state.project ? `${name}  (${state.project})` : name; el.title = state.project; }
  applyTaskbarTag(name);
}
// Curated DARK colors (white text always reads well).
export const TAG_COLORS = ["#8c2f2f", "#2f5f8c", "#2f7a55", "#5d2f8c", "#8c6a2f", "#2f3a8c", "#8c2f63", "#3a4d5c", "#4d3a2f", "#2f6e6e", "#6e2f2f", "#2f5c3a"];
export function tagColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[h];
}
export function projectKeyOf(p) { return (p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase(); }
// Per-project taskbar tile record: { tagColor, tagText (≤ 4 letters, "" = project name), tagSize (%) }.
export const TAG_TEXT_MAX = 4, TAG_SIZE_MIN = 50, TAG_SIZE_MAX = 150, TAG_SIZE_STEP = 10;
export function projectTagRec() { return (state.settings.projects && state.settings.projects[projectKeyOf(state.project)]) || {}; }
// The fixed tile color for this window's project: use the saved one, or assign
// (hash) once and persist it so it never changes again.
export function projectColor() {
  const rec = projectTagRec();
  if (rec.tagColor) return rec.tagColor;
  const col = tagColor(baseName(state.project) || "AtomNano");
  saveProjectTag({ tagColor: col });
  return col;
}
export function saveProjectColor(col) { saveProjectTag({ tagColor: col }); }
export function saveProjectTag(patch) {
  if (!state.project) return;
  const k = projectKeyOf(state.project);
  state.settings.projects = state.settings.projects || {};
  state.settings.projects[k] = { ...(state.settings.projects[k] || {}), path: state.project, ...patch };
  atom.project.saveTabs(state.project, patch).catch(() => {});
}
// Letters on the tile: the custom text (letters/digits only, at most 4) or the project name's.
export function tagLetters(custom, name) {
  const clean = (s) => String(s || "").replace(/[^a-z0-9]/gi, "").slice(0, TAG_TEXT_MAX).toUpperCase();
  return clean(custom) || clean(name) || "AQ";
}
export function tagSizePct(v) { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== "" && v != null ? Math.max(TAG_SIZE_MIN, Math.min(TAG_SIZE_MAX, n)) : 100; }
// White letters on dark tiles, near-black on light custom colours.
export function tagTextColor(bg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg || "").trim()); if (!m) return "#ffffff";
  const v = parseInt(m[1], 16), r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62 ? "#1c1410" : "#ffffff";
}
export function drawAtomBadge(ctx, cx, cy, r) {
  ctx.save();
  // dark disc so the amber atom reads on any tile color
  ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.fillStyle = "rgba(18,13,10,0.6)"; ctx.fill();
  ctx.strokeStyle = "#f0a94e"; ctx.lineWidth = 2.2;
  for (const ang of [Math.PI / 4, -Math.PI / 4]) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.46, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, Math.PI * 2); ctx.fillStyle = "#f0a94e"; ctx.fill();
  ctx.restore();
}
// The tile itself (S×S): rounded colour tile, semibold letters, atom badge top-left.
// 100 % = the largest size that fills the tile width (≤ 80px on a 128 tile); `size`
// scales that, but letters never overflow the tile — `dataset.capped` says when a
// larger request could not be honoured. Used for the taskbar icon and the Settings
// preview. Returns the canvas.
export function renderTagTile({ text, color, size = 100, S = 128, badge = true } = {}) {
  const c = document.createElement("canvas"); c.width = S; c.height = S;
  const ctx = c.getContext("2d");
  const r = Math.round(S * 0.17);
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.arcTo(S, 0, S, S, r); ctx.arcTo(S, S, 0, S, r); ctx.arcTo(0, S, 0, 0, r); ctx.arcTo(0, 0, S, 0, r); ctx.closePath();
  ctx.fillStyle = color || "#3a4d5c"; ctx.fill();
  ctx.fillStyle = tagTextColor(color);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const font = (px) => `600 ${px}px "Segoe UI", system-ui, sans-serif`;
  const maxW = S - Math.round(S * 0.094), maxFs = Math.round(S * 0.82);
  const fits = (px) => { ctx.font = font(px); return ctx.measureText(text).width <= maxW; };
  let fit = Math.round(S * 0.625);                                  // 100 %: fill the width (80px on a 128 tile)
  while (!fits(fit) && fit > 10) fit -= 2;
  const requested = Math.round(fit * (tagSizePct(size) / 100));
  let fs = Math.min(requested, maxFs);
  while (!fits(fs) && fs > 10) fs -= 2;
  ctx.font = font(fs);
  ctx.fillText(text, S / 2, S * 0.6);
  if (badge) drawAtomBadge(ctx, Math.round(S * 0.195), Math.round(S * 0.195), S * 0.1);   // AtomNano mark, top-left
  c.dataset.fontPx = String(fs);
  c.dataset.capped = fs < requested ? "1" : "";
  return c;
}
// Window/taskbar icon for this window's project: its colour, its letters (custom
// text or the project name) and its text size, all saved per project.
export function applyTaskbarTag(name) {
  try {
    const rec = projectTagRec();
    const c = renderTagTile({ text: tagLetters(rec.tagText, name), color: projectColor(), size: rec.tagSize });
    atom.win.setTagIcon(c.toDataURL("image/png")).catch(() => {});
  } catch { /* ignore */ }
}
export function applyFontSize(f) { document.body.style.fontSize = (FONT_SIZES[f] || 14) + "px"; }
export function applyEditorZoom() { document.documentElement.style.setProperty("--ed-font", (state.editor.fontSize || 13) + "px"); if (cm) cm.remeasure(); }
// Editor font family — a named choice or "default" (falls back to --font-mono).
export const EDITOR_FONTS = [
  { id: "default", name: "Default", stack: "" },
  { id: "cascadia", name: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", monospace' },
  { id: "jetbrains", name: "JetBrains Mono", stack: '"JetBrains Mono", monospace' },
  { id: "fira", name: "Fira Code", stack: '"Fira Code", monospace' },
  { id: "consolas", name: "Consolas", stack: 'Consolas, "Courier New", monospace' },
  { id: "system", name: "System mono", stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
];
export function applyEditorFontFamily(fam) {
  const f = EDITOR_FONTS.find((x) => x.id === fam);
  const stack = f ? f.stack : "";
  if (stack) document.documentElement.style.setProperty("--ed-font-family", stack);
  else document.documentElement.style.removeProperty("--ed-font-family");
  if (cm) cm.remeasure();
}
export function changeEditorZoom(dir) {
  let fs = state.editor.fontSize || 13;
  fs = dir === 0 ? 13 : Math.max(9, Math.min(28, fs + dir));
  state.editor.fontSize = fs;
  applyEditorZoom();
  atom.settings.set({ editorFontSize: fs }).catch(() => {});
  const f = stateActiveFile(); if (f) updateEditorStatus(f);
}
