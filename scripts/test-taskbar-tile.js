"use strict";
/* Taskbar tile regression suite (Settings → Appearance → Taskbar tile):
 *   · letters: custom text (≤ 4, letters/digits, upper-cased) or the project name's
 *   · text size: 50–150 % of the default, never wider than the tile
 *   · colour: any hex colour; light tiles get dark letters
 *   · applyTaskbarTag draws exactly the per-project record (text · size · colour)
 * Runs the ORIGINAL renderer functions extracted from app.js in headless Chromium
 * with a stubbed `atom` / `state`. Never launches the app.  Run:  node scripts/test-taskbar-tile.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ts = require("typescript");
const { chromium } = require("playwright");

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 500) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 120000);

const app = fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf8");
const ast = ts.createSourceFile("app.js", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function fn(name) {
  let n = null;
  const visit = (x) => { if (n) return; if (ts.isFunctionDeclaration(x) && x.name && x.name.text === name) { n = x; return; } ts.forEachChild(x, visit); };
  visit(ast);
  if (!n) throw new Error("function not found: " + name);
  return n.getText(ast);
}
const constLine = (name) => { const m = new RegExp(`^const ${name}\\b.*$`, "m").exec(app); if (!m) throw new Error("const not found: " + name); return m[0]; };
const extracted = [constLine("TAG_COLORS"), constLine("TAG_TEXT_MAX"),
  ...["tagColor", "projectKeyOf", "projectTagRec", "projectColor", "saveProjectColor", "saveProjectTag", "tagLetters", "tagSizePct", "tagTextColor", "drawAtomBadge", "renderTagTile", "applyTaskbarTag", "baseName"].map(fn)].join("\n");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent("<!doctype html><html><body></body></html>");
  const errors = []; page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  await page.addScriptTag({ content: `(() => {
    window.calls = [];
    const state = { project: "C:/work/Cognito Project", settings: { projects: {} } };
    const atom = { win: { setTagIcon: async (d) => { calls.push({ op: "setTagIcon", d }); } }, project: { saveTabs: async (p, patch) => { calls.push({ op: "saveTabs", p, patch }); } } };
    ${extracted}
    window.T = { state, tagLetters, tagSizePct, tagTextColor, renderTagTile, applyTaskbarTag, projectColor, saveProjectTag, TAG_COLORS, TAG_TEXT_MAX,
      measure(text, px) { const c = document.createElement("canvas").getContext("2d"); c.font = '600 ' + px + 'px "Segoe UI", system-ui, sans-serif'; return c.measureText(text).width; },
      px(canvas, x, y) { const d = canvas.getContext("2d").getImageData(x, y, 1, 1).data; return "#" + [...d].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join(""); } };
  })();` });

  const r = await page.evaluate(() => {
    const out = {};
    // letters
    out.L = { custom: T.tagLetters("my-proj", "Cognito"), fromName: T.tagLetters("", "Cognito Project"), empty: T.tagLetters("", ""), spaced: T.tagLetters("a b c d e", ""), lower: T.tagLetters("qa", ""), digits: T.tagLetters("v2.1", ""), max: T.TAG_TEXT_MAX };
    // size clamp
    out.S = { def: T.tagSizePct(undefined), empty: T.tagSizePct(""), junk: T.tagSizePct("abc"), low: T.tagSizePct(10), high: T.tagSizePct(900), mid: T.tagSizePct("80"), round: T.tagSizePct(74.6) };
    // text colour by luminance
    out.C = { dark: T.tagTextColor("#2f5f8c"), light: T.tagTextColor("#f5e9c8"), white: T.tagTextColor("#ffffff"), black: T.tagTextColor("#000000"), junk: T.tagTextColor("blue") };
    // tile: text size follows the setting but never overflows the tile
    const S = 128, maxW = S - Math.round(S * 0.094);
    const t100 = T.renderTagTile({ text: "COGN", color: "#2f5f8c", size: 100 }), t60 = T.renderTagTile({ text: "COGN", color: "#2f5f8c", size: 60 }), t150 = T.renderTagTile({ text: "COGN", color: "#2f5f8c", size: 150 });
    const s100 = +t100.dataset.fontPx, s60 = +t60.dataset.fontPx, s150 = +t150.dataset.fontPx;
    const short150 = +T.renderTagTile({ text: "AB", color: "#2f5f8c", size: 150 }).dataset.fontPx, short100 = +T.renderTagTile({ text: "AB", color: "#2f5f8c", size: 100 }).dataset.fontPx;
    out.T = { s100, s60, s150, short100, short150, capped: { t60: t60.dataset.capped, t100: t100.dataset.capped, t150: t150.dataset.capped }, ratio: s60 / s100, fits: [t100, t60, t150].every((c) => T.measure("COGN", +c.dataset.fontPx) <= maxW), wide: T.measure("WWWW", +T.renderTagTile({ text: "WWWW", color: "#2f5f8c", size: 150 }).dataset.fontPx) <= maxW, size: [t100.width, t100.height] };
    // colour lands on the tile (sample the middle of the right edge, away from letters and badge); light tile → dark letters
    const tile = T.renderTagTile({ text: "I", color: "#8c2f2f", size: 100, badge: false });
    const light = T.renderTagTile({ text: "IIII", color: "#f5e9c8", size: 150, badge: false });
    const lightData = light.getContext("2d").getImageData(0, 0, 128, 128).data; let darkPx = 0; for (let i = 0; i < lightData.length; i += 4) if (lightData[i] < 80 && lightData[i + 1] < 80 && lightData[i + 2] < 80) darkPx++;
    out.P = { bg: T.px(tile, 122, 64), corner: T.px(tile, 64, 64) !== "#8c2f2f" || true, darkLetterPixels: darkPx };
    // applyTaskbarTag draws the per-project record (custom text, size, colour) and persists nothing new when everything is set
    T.state.settings.projects["c:/work/cognito project"] = { path: T.state.project, tagColor: "#2f7a55", tagText: "CG", tagSize: 80 };
    calls.length = 0;
    T.applyTaskbarTag("Cognito Project");
    const sent = calls.find((c) => c.op === "setTagIcon");
    const expect = T.renderTagTile({ text: "CG", color: "#2f7a55", size: 80 }).toDataURL("image/png");
    const other = T.renderTagTile({ text: "COGN", color: "#2f7a55", size: 100 }).toDataURL("image/png");
    out.A = { sent: !!sent && /^data:image\/png;base64,/.test(sent.d), matches: !!sent && sent.d === expect, differsFromDefault: !!sent && sent.d !== other, saves: calls.filter((c) => c.op === "saveTabs").length };
    // a project without a saved colour gets one assigned ONCE (hash) and persisted; text/size fall back
    T.state.settings.projects = {}; calls.length = 0;
    T.applyTaskbarTag("Cognito Project");
    const first = T.projectColor(), second = T.projectColor();
    const sent2 = calls.find((c) => c.op === "setTagIcon");
    out.D = { assigned: T.TAG_COLORS.includes(first), stable: first === second, saved: calls.some((c) => c.op === "saveTabs" && c.patch.tagColor === first), savesOnce: calls.filter((c) => c.op === "saveTabs").length === 1, drawn: !!sent2 && sent2.d === T.renderTagTile({ text: "COGN", color: first, size: 100 }).toDataURL("image/png") };
    // saveProjectTag merges keys and keeps the others
    T.saveProjectTag({ tagText: "QA" }); T.saveProjectTag({ tagSize: 120 });
    const rec = T.state.settings.projects["c:/work/cognito project"];
    out.M = { rec, patches: calls.filter((c) => c.op === "saveTabs").map((c) => c.patch) };
    return out;
  });

  check("T01", "custom text is letters/digits only, at most 4, upper-cased", r.L.custom === "MYPR" && r.L.spaced === "ABCD" && r.L.lower === "QA" && r.L.digits === "V21" && r.L.max === 4, r.L);
  check("T02", "blank custom text falls back to the project name, then to AQ", r.L.fromName === "COGN" && r.L.empty === "AQ", r.L);
  check("T03", "text size is clamped to 50–150 % and defaults to 100 %", r.S.def === 100 && r.S.empty === 100 && r.S.junk === 100 && r.S.low === 50 && r.S.high === 150 && r.S.mid === 80 && r.S.round === 75, r.S);
  check("T04", "letters are white on dark tiles and near-black on light ones", r.C.dark === "#ffffff" && r.C.black === "#ffffff" && r.C.light === "#1c1410" && r.C.white === "#1c1410" && r.C.junk === "#ffffff", r.C);
  check("T05", "the size setting scales the width-filling default (60 % ≈ 0.6×, 150 % grows short text) and letters never overflow; an unreachable size is reported as capped", r.T.s60 < r.T.s100 && Math.abs(r.T.ratio - 0.6) < 0.08 && r.T.short150 > r.T.short100 && r.T.s150 >= r.T.s100 && r.T.capped.t60 === "" && r.T.capped.t100 === "" && r.T.capped.t150 === "1" && r.T.fits && r.T.wide && r.T.size[0] === 128 && r.T.size[1] === 128, r.T);
  check("T06", "the chosen colour fills the tile and light tiles are drawn with dark letters", r.P.bg === "#8c2f2f" && r.P.darkLetterPixels > 200, r.P);
  check("T07", "the taskbar icon is drawn from the project's saved text, size and colour", r.A.sent && r.A.matches && r.A.differsFromDefault && r.A.saves === 0, r.A);
  check("T08", "a project without a colour gets one assigned once (persisted) and draws the project-name letters at 100 %", r.D.assigned && r.D.stable && r.D.saved && r.D.savesOnce && r.D.drawn, r.D);
  check("T09", "saving text or size keeps the other tile settings", r.M.rec.tagText === "QA" && r.M.rec.tagSize === 120 && r.M.rec.tagColor && r.M.rec.path === "C:/work/Cognito Project" && r.M.patches.some((p) => p.tagText === "QA") && r.M.patches.some((p) => p.tagSize === 120), r.M);
  check("T10", "no page errors", errors.length === 0, errors);

  await browser.close();
  clearTimeout(watchdog);
  console.log(`Taskbar tile: ${pass} passed, ${failN} failed`);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
