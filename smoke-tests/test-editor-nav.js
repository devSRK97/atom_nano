/* Navigation: document symbols → go-to-symbol picker + breadcrumbs (TS service). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-nav");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["."] }, null, 2));
  fs.writeFileSync(path.join(DIR, "svc.ts"),
    "export class Service {\n" +
    "  count = 0;\n" +
    "  start() {\n" +
    "    return this.count;\n" +
    "  }\n" +
    "  stop() { this.count = 0; }\n" +
    "}\n" +
    "export function helper() { return 1; }\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__symbols === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  await win.evaluate((p) => window.__openInEditor(p), P("svc.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(800);

  /* ---------- 1) document symbols ---------- */
  let syms = [];
  for (let i = 0; i < 40 && syms.length === 0; i++) { await win.waitForTimeout(250); syms = await win.evaluate(() => window.__symbols()); }
  const names = syms.map((s) => s.name);
  ok(syms.length >= 4, `symbols returned (${syms.length}: ${JSON.stringify(names.slice(0, 8))})`);
  ok(names.includes("Service") && names.includes("start") && names.includes("helper"), "outline includes class, method and function");
  ok(syms.some((s) => s.depth >= 1), "nested members carry depth > 0");

  /* ---------- 2) breadcrumbs reflect the cursor's enclosing symbols ---------- */
  // put the caret inside Service.start()'s body
  await win.evaluate(() => { const cm = window.__cm(); const i = cm.slice(0, 99999).indexOf("return this.count") + 5; cm.selectRange(i, i); });
  await win.waitForTimeout(500);
  const crumbs = await win.evaluate(() => window.__breadcrumbs());
  ok(crumbs.includes("Service") && crumbs.includes("start"), `breadcrumbs show the enclosing chain (${JSON.stringify(crumbs)})`);

  /* ---------- 3) go-to-symbol picker filters + jumps ---------- */
  await win.evaluate(() => window.__openSymbolPicker());
  await win.waitForSelector(".search-modal .sym-row", { timeout: 6000 });
  await win.waitForTimeout(200);
  await win.fill(".search-modal input", "helper");
  await win.waitForTimeout(250);
  const rows = await win.evaluate(() => [...document.querySelectorAll(".search-modal .sym-row .srn-name")].map((e) => e.textContent));
  ok(rows.length >= 1 && rows.every((r) => /helper/i.test(r)), `picker filtered to "helper" (${JSON.stringify(rows)})`);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(300);
  const line = await win.evaluate(() => { const cm = window.__cm(); const p = cm.cursor(); return cm.lineOf(p); });
  ok(line >= 8, `selecting "helper" jumped to its line (line ${line})`);

  ok(errors.length === 0, "no page errors during the navigation flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME NAV TESTS FAILED" : "\nALL NAV TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
