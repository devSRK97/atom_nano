/* Inlay hints: TS service provides inferred-type / parameter-name hints, rendered
 * as inline widgets when enabled. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-inlay");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["."] }, null, 2));
  // inferred var type (: number) + a call whose args get parameter-name hints
  fs.writeFileSync(path.join(DIR, "hints.ts"),
    "function add(a: number, b: number) { return a + b; }\n" +
    "const total = 41 + 1;\n" +
    "const r = add(1, 2);\n" +
    "export {};\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  await win.evaluate((p) => window.__openInEditor(p), P("hints.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(800);

  // none by default (setting off)
  let n0 = await win.evaluate(() => document.querySelectorAll(".cm-inlay").length);
  ok(n0 === 0, `no inlay chips when disabled (${n0})`);

  // enable → chips appear (give the TS utility process time to answer)
  await win.evaluate(() => window.__cm().setInlayHints(true));
  let chips = [];
  for (let i = 0; i < 40 && chips.length === 0; i++) { await win.waitForTimeout(250); chips = await win.evaluate(() => [...document.querySelectorAll(".cm-inlay")].map((e) => e.textContent)); }
  ok(chips.length >= 1, `inlay chips rendered when enabled (${chips.length}: ${JSON.stringify(chips.slice(0, 5))})`);
  ok(chips.some((t) => /number/.test(t)) || chips.some((t) => /a:|b:/.test(t)), "a chip shows an inferred type or parameter name");

  // disable → chips clear
  await win.evaluate(() => window.__cm().setInlayHints(false));
  await win.waitForTimeout(400);
  const n1 = await win.evaluate(() => document.querySelectorAll(".cm-inlay").length);
  ok(n1 === 0, "inlay chips removed when disabled");

  ok(errors.length === 0, "no page errors during the inlay flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME INLAY TESTS FAILED" : "\nALL INLAY TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
