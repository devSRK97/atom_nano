/* Typing-latency benchmark on the real 790KB TSX file (copied to temp).
 * Measures: (a) main-thread cost of 40 sequential single-char dispatches at a
 * realistic position, (b) worst single dispatch, (c) error-message quality for
 * the user's exact broken snippet (missing `=` before useMemo). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const SRC = "C:\\Users\\harsha\\Documents\\TestcaseManagement.tsx";
const DIR = path.join(os.tmpdir(), "atomnano-bigtsx");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(SRC)) { console.log("source file missing — abort"); process.exit(1); }
  fs.copyFileSync(SRC, path.join(DIR, "TestcaseManagement.tsx"));
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true, jsx: "react-jsx", allowJs: true }, include: ["."] }, null, 2));
  // small file with the user's exact error: missing `=` before useMemo
  fs.writeFileSync(path.join(DIR, "err.tsx"),
    "import { useMemo } from \"react\";\n" +
    "export function usePlanned(stepVariationSelections: Record<string, unknown[]>) {\n" +
    "  const plannedIterationCount useMemo(() => {\n" +
    "    let max = 1;\n" +
    "    for (const arr of Object.values(stepVariationSelections)) {\n" +
    "      if (Array.isArray(arr) && arr.length > max) max = arr.length;\n" +
    "    }\n" +
    "    return max;\n" +
    "  }, [stepVariationSelections]);\n" +
    "  return plannedIterationCount;\n" +
    "}\n");

  const udir = path.join(os.tmpdir(), "atomnano-bigtsx-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---- 1) typing latency on the big file ---- */
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "TestcaseManagement.tsx").replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 20000 });
  await win.waitForTimeout(2500);   // let initial parse/lint settle

  const res = await win.evaluate(async () => {
    const cm = window.__cm();
    const view = cm.view;
    // caret in the middle of the file (a realistic edit position)
    const mid = Math.floor(view.state.doc.length / 2);
    const line = view.state.doc.lineAt(mid);
    view.dispatch({ selection: { anchor: line.to } });
    const times = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: "x" }, selection: { anchor: view.state.selection.main.head + 1 }, userEvent: "input.type" });
      times.push(performance.now() - t0);
      // yield so debounced work can schedule (but not fully run) like real typing
      await new Promise((r) => setTimeout(r, 16));
    }
    times.sort((a, b) => a - b);
    const sum = times.reduce((s, t) => s + t, 0);
    return { mean: +(sum / times.length).toFixed(2), p50: +times[20].toFixed(2), p95: +times[38].toFixed(2), max: +times[39].toFixed(2) };
  });
  console.log(`TYPING (790KB tsx, 40 keys): mean ${res.mean}ms · p50 ${res.p50}ms · p95 ${res.p95}ms · max ${res.max}ms`);

  /* ---- 2) error-message quality on the user's snippet ---- */
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "err.tsx").replace(/\\/g, "/"));
  await win.waitForTimeout(500);
  let diags = [];
  for (let i = 0; i < 60 && diags.length === 0; i++) { await win.waitForTimeout(250); diags = await win.evaluate(() => window.__cm().diagnosticsDetailed()); }
  console.log("ERROR MESSAGES on the missing-`=` snippet:");
  for (const d of diags.slice(0, 6)) console.log(`   Ln ${d.line}:${d.col}  [${d.severity}]  ${d.message.replace(/\n/g, " ").slice(0, 90)}`);
  const generic = diags.filter((d) => d.message === "Syntax error").length;
  const precise = diags.filter((d) => /expected|missing|Cannot find|implicitly/i.test(d.message)).length;
  console.log(`   → ${precise} precise · ${generic} generic ("Syntax error")`);

  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
