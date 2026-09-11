/* Find references (TS, cross-file) + back/forward jump history. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-refs");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");
const base = (p) => (p || "").split(/[\\/]/).pop();

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["."] }, null, 2));
  fs.writeFileSync(path.join(DIR, "lib.ts"), "export function tally(n: number) { return n + 1; }\n");
  fs.writeFileSync(path.join(DIR, "use.ts"),
    'import { tally } from "./lib";\n' +
    "const a = tally(1);\n" +
    "const b = tally(2);\n" +
    "console.log(a, b, tally(3));\n" +
    "export {};\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__findReferences === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- 1) find references across files ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("lib.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(800);
  await win.evaluate(() => { const cm = window.__cm(); const i = cm.slice(0, 9999).indexOf("tally") + 2; cm.selectRange(i, i); });
  await win.evaluate(() => window.__findReferences());
  let refs = [];
  for (let i = 0; i < 40 && refs.length === 0; i++) { await win.waitForTimeout(250); refs = await win.evaluate(() => window.__refs()); }
  ok(refs.length >= 4, `references found across files (${refs.length})`);
  ok(refs.some((r) => /use\.ts$/.test(r.file)) && refs.some((r) => /lib\.ts$/.test(r.file)), "references span both lib.ts and use.ts");
  const items = await win.evaluate(() => { const p = document.getElementById("editorRefs"); return p && !p.classList.contains("hidden") ? p.querySelectorAll(".ep-item").length : 0; });
  ok(items >= 4, `references panel lists the hits (${items})`);

  /* ---------- 2) deterministic back/forward via the recorded jump ---------- */
  // we're in lib.ts; jump to a use.ts reference (records source lib.ts + dest use.ts)
  const useRef = refs.find((r) => /use\.ts$/.test(r.file));
  await win.evaluate((r) => window.__jumpTo(r.file, r.line, r.col), useRef);
  await win.waitForTimeout(500);
  ok(/use\.ts$/.test(await win.evaluate(() => window.__editorState().path)), "jumped to the use.ts reference");

  await win.evaluate(() => window.__navBack());
  await win.waitForTimeout(500);
  ok(/lib\.ts$/.test(await win.evaluate(() => window.__editorState().path)), "Alt+Left returned to lib.ts (the jump source)");

  await win.evaluate(() => window.__navForward());
  await win.waitForTimeout(500);
  ok(/use\.ts$/.test(await win.evaluate(() => window.__editorState().path)), "Alt+Right went forward to use.ts");

  ok(errors.length === 0, "no page errors during the references flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME REFS TESTS FAILED" : "\nALL REFS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
