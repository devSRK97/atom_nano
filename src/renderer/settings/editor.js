/* Settings › Editor — font, and the analysis / save layers, each applied live to open editors. */
import { atom, state } from "../core/state.js";
import { EDITOR_FONTS, applyEditorFontFamily, applyEditorZoom } from "../core/theme.js";
import { cm, editors } from "../editor/editor-pane.js";
import { boolSetting, field, inlineSelect, section, stepper } from "./controls.js";

export function editorCategory({ s }) {
  const curEdFont = EDITOR_FONTS.find((f) => f.id === s.editorFontFamily) ? s.editorFontFamily : "default";
  const edFontSel = inlineSelect(EDITOR_FONTS.map((f) => ({ id: f.id, name: f.name })), curEdFont,
    (v) => { s.editorFontFamily = v; applyEditorFontFamily(v); atom.settings.set({ editorFontFamily: v }); });
  const edSize = stepper({
    value: s.editorFontSize || 13, min: 9, max: 28, format: (n) => n + "px", resetTo: 13, labels: { minus: "Smaller", plus: "Larger" },
    onChange: (n) => { state.editor.fontSize = n; s.editorFontSize = n; applyEditorZoom(); atom.settings.set({ editorFontSize: n }); },
  });
  const cmApply = (method) => (v) => { if (cm && typeof cm[method] === "function") cm[method](v); };
  const allApply = (method) => (v) => { for (const e of editors) if (e && typeof e[method] === "function") e[method](v); };

  return {
    id: "editor", label: "Editor", ic: "fileCode", group: "Workspace",
    blurb: "The built-in code editor. Every switch applies to the open files right away.",
    items: () => [
      section("Text", "fileCode"),
      field("Font style", edFontSel, "Font family used by the code editor.", { keywords: "typeface mono" }),
      field("Font size", edSize, "Also adjustable with Ctrl + / Ctrl −.", { keywords: "zoom" }),
      field("Word wrap", boolSetting("editorWordWrap", { apply: cmApply("setWrap"), label: "Word wrap" }), "Wrap long lines (Alt+Z)."),
      field("Render whitespace", boolSetting("editorRenderWhitespace", { apply: cmApply("setWhitespace"), label: "Render whitespace" }), "Show dots for spaces and arrows for tabs."),
      field("Indent guides", boolSetting("editorIndentGuides", { apply: allApply("setIndentGuides"), label: "Indent guides" }), "Very subtle vertical lines at each indent level."),
      field("Bracket pair colours", boolSetting("editorBracketColors", { def: true, apply: cmApply("setBracketColors"), label: "Bracket pair colours" }), "Rainbow brackets by depth."),
      field("Sticky scroll", boolSetting("editorStickyScroll", { apply: cmApply("setSticky"), label: "Sticky scroll" }), "Pin enclosing function/class headers at the top."),
      section("Analysis", "search"),
      field("Syntax highlighting", boolSetting("editorHighlight", { def: true, apply: cmApply("setHighlight"), label: "Syntax highlighting" }), "Grammar-based token colours (~35 languages)."),
      field("Syntax errors", boolSetting("editorLint", { def: true, apply: cmApply("setLint"), label: "Syntax errors" }), "Underline grammar parse errors (off-thread).", { keywords: "lint diagnostics" }),
      field("Semantic analysis (TS)", boolSetting("editorSemantic", { def: true, apply: cmApply("setSemantic"), label: "Semantic analysis" }), "Project-wide diagnostics for JS/TS. Powers completion, hover, quick-fix, rename, format.", { keywords: "typescript intellisense" }),
      field("Inlay hints", boolSetting("editorInlayHints", { apply: allApply("setInlayHints"), label: "Inlay hints" }), "Inline parameter-name and type hints from TS / LSP."),
      section("Saving", "check"),
      field("Auto-save", boolSetting("editorAutoSave", { label: "Auto-save" }), "Save after a short pause in typing."),
      field("Format on save", boolSetting("editorFormatOnSave", { label: "Format on save" }), "Run the formatter when you save.", { keywords: "prettier" }),
      field("Trim whitespace on save", boolSetting("editorTrimWhitespace", { label: "Trim whitespace on save" }), "Remove trailing spaces/tabs when saving."),
      field("Final newline", boolSetting("editorFinalNewline", { label: "Final newline" }), "Ensure the file ends with a newline."),
    ],
  };
}
