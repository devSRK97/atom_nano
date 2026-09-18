/* Settings › Appearance — theme, interface size, and this project's taskbar / Dock tile. */
import { baseName, h, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { TAG_COLORS, TAG_SIZE_STEP, TAG_TEXT_MAX, applyFontSize, applyTheme, applyWindowTitle, projectColor, projectTagRec, renderTagTile, saveProjectColor, saveProjectTag, tagLetters, tagSizePct } from "../core/theme.js";
import { field, segmented } from "./controls.js";

const THEMES = [
  { id: "amber", name: "Amber", bg: "#222020", ac: "#f0a94e" },
  { id: "ember", name: "Ember", bg: "#222020", ac: "#ef7d4c" },
  { id: "gold", name: "Gold", bg: "#222020", ac: "#e8c25a" },
  { id: "rose", name: "Rose", bg: "#222020", ac: "#e88a72" },
  { id: "gunmetal", name: "Gunmetal", bg: "#1b1f24", ac: "#6fb3d6" },
  { id: "gray", name: "Gray", bg: "#1f1f1f", ac: "#9fb4c4" },
  { id: "blue", name: "Blue", bg: "#0f1623", ac: "#5b9bf0" },
  { id: "light", name: "Light", bg: "#faf8f5", ac: "#cf8a2e" },
];

export function appearanceCategory({ s, isMac }) {
  // Theme swatches
  let curTheme = s.theme || s.accent || "amber";
  const themeRow = h("div", { class: "theme-row" });
  function drawThemes() {
    themeRow.innerHTML = "";
    for (const t of THEMES) themeRow.append(h("button", {
      class: "theme-swatch" + (t.id === curTheme ? " sel" : ""), title: t.name,
      onclick: () => { curTheme = t.id; s.theme = t.id; applyTheme(t.id); atom.settings.set({ theme: t.id }); drawThemes(); },
    },
      h("span", { class: "ts-prev", style: `background:${t.bg}` }, h("span", { class: "ts-dot", style: `background:${t.ac}` })),
      h("span", { class: "ts-name", text: t.name })));
  }
  drawThemes();

  // Interface size (coerce any legacy numeric value to a named size)
  const curSize = ["small", "medium", "large"].includes(s.fontSize) ? s.fontSize : "medium";
  const fontSeg = segmented(["small", "medium", "large"], curSize, (v) => { s.fontSize = v; applyFontSize(v); atom.settings.set({ fontSize: v }); }, { small: "Small", medium: "Medium", large: "Large" });

  // Taskbar / Dock tile (saved per project): live preview · custom letters (≤ 4) · text size · colour
  const dockWord = isMac ? "Dock" : "taskbar";
  const projName = () => baseName(state.project) || "AtomNano";
  const tilePreview = h("div", { class: "tile-preview", title: `How this window shows on the ${dockWord}` });
  const tileSizeUp = h("button", { class: "btn btn-ghost btn-sm", text: "+", title: "Larger text", "aria-label": "Larger tile text" });
  const tileSizeNote = h("span", { class: "hint tile-ctl-hint" });
  const drawTile = () => {
    tilePreview.innerHTML = "";
    const rec = projectTagRec();
    const c = renderTagTile({ text: tagLetters(rec.tagText, projName()), color: projectColor(), size: rec.tagSize });
    c.className = "tile-canvas"; tilePreview.append(c);
    const capped = c.dataset.capped === "1";           // the letters already fill the tile: "+" would change nothing
    tileSizeUp.disabled = capped;
    tileSizeNote.textContent = capped ? "Fills the tile — fewer letters can go bigger" : "";
  };
  const applyTile = () => { applyWindowTitle(); drawTile(); };
  const tileText = h("input", { class: "input tile-text", maxlength: String(TAG_TEXT_MAX), placeholder: tagLetters("", projName()), value: projectTagRec().tagText || "", spellcheck: "false", autocomplete: "off", "aria-label": `Taskbar tile text (up to ${TAG_TEXT_MAX} letters)` });
  tileText.oninput = () => { const v = tileText.value.replace(/[^a-z0-9]/gi, "").slice(0, TAG_TEXT_MAX).toUpperCase(); if (v !== tileText.value) tileText.value = v; saveProjectTag({ tagText: v }); applyTile(); };
  const tileSizeVal = h("span", { class: "step-val", text: tagSizePct(projectTagRec().tagSize) + "%" });
  const setTileSize = (n) => { const v = tagSizePct(n); saveProjectTag({ tagSize: v }); tileSizeVal.textContent = v + "%"; applyTile(); };
  tileSizeUp.onclick = () => setTileSize(tagSizePct(projectTagRec().tagSize) + TAG_SIZE_STEP);
  const tileSizeRow = h("div", { class: "stepper" },
    h("button", { class: "btn btn-ghost btn-sm", text: "−", title: "Smaller text", "aria-label": "Smaller tile text", onclick: () => setTileSize(tagSizePct(projectTagRec().tagSize) - TAG_SIZE_STEP) }),
    tileSizeVal,
    tileSizeUp,
    h("button", { class: "btn btn-ghost btn-sm", text: "Reset", onclick: () => setTileSize(100) }));
  const tileBox = h("div", { class: "tile-box" }, tilePreview,
    h("div", { class: "tile-controls" },
      h("div", { class: "tile-ctl" }, h("span", { class: "tile-ctl-label", text: "Text" }), tileText, h("span", { class: "hint tile-ctl-hint", text: `Up to ${TAG_TEXT_MAX} letters · blank = project name` })),
      h("div", { class: "tile-ctl" }, h("span", { class: "tile-ctl-label", text: "Size" }), tileSizeRow, tileSizeNote)));
  drawTile();

  // Tile colour: the curated swatches plus a free colour picker (the last swatch)
  const colorRow = h("div", { class: "theme-row tag-colors" });
  const customPick = h("input", { type: "color", class: "tag-custom-input", "aria-label": "Custom tile colour" });
  function drawColors() {
    colorRow.innerHTML = "";
    const cur = (projectColor() || "").toLowerCase();
    for (const col of TAG_COLORS) {
      colorRow.append(h("button", {
        class: "tag-swatch" + (col.toLowerCase() === cur ? " sel" : ""), title: col, "aria-label": `Tile colour ${col}`, style: `background:${col}`,
        onclick: () => { saveProjectColor(col); applyTile(); drawColors(); toast("Tile color saved for this project"); },
      }));
    }
    const isCustom = /^#[0-9a-f]{6}$/i.test(cur) && !TAG_COLORS.some((c) => c.toLowerCase() === cur);
    customPick.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : "#3a4d5c";
    colorRow.append(h("label", { class: "tag-swatch tag-custom" + (isCustom ? " sel" : ""), title: isCustom ? `Custom colour ${cur} — click to change` : "Pick any colour", style: isCustom ? `background:${cur}` : "" },
      h("span", { class: "tag-custom-ic", text: "+" }), customPick));
  }
  customPick.oninput = () => { saveProjectColor(customPick.value); applyTile(); };   // live while dragging in the picker
  customPick.onchange = () => { drawColors(); toast("Tile color saved for this project"); };
  drawColors();

  return {
    id: "appearance", label: "Appearance", ic: "eye", group: "Workspace",
    blurb: "Theme and text size for the whole window, and how this project shows on the " + dockWord + ".",
    items: () => [
      field("Theme", themeRow, "Applies instantly to every window.", { wide: true, keywords: "colour color dark light accent" }),
      field("Interface size", fontSeg, "Zoom level for the chat and panels.", { keywords: "zoom font scale" }),
      field(isMac ? "Dock tile" : "Taskbar tile", tileBox, `The letters this project's window shows ${isMac ? "in the Dock (while it is focused)" : "on the Windows taskbar"} and their size. Saved for this project.`, { wide: true, keywords: "icon letters badge project" }),
      field(isMac ? "Dock tile color" : "Taskbar tile color", colorRow, "Pick a swatch, or any colour with the last one. Light colours get dark letters automatically.", { wide: true, keywords: "colour swatch project" }),
    ],
  };
}
