/* Verify JS and TSX files capture both grammar (syntax) and semantic (type) errors. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-jstsx");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, checkJs: true, allowJs: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true, jsx: "react-jsx" },
    include: ["."],
  }, null, 2));
  // JS file with a type error (should trigger semantic diagnostic)
  fs.writeFileSync(path.join(DIR, "bad.js"), "const x = 1;\nx.toUpperCase();\n");
  // TSX file with a type error in JSX
  fs.writeFileSync(path.join(DIR, "comp.tsx"), "export function C() {\n  const n: number = \"oops\";\n  return <div>{n}</div>;\n}\n");
  // Pure syntax error in a JS file (missing closing bracket)
  fs.writeFileSync(path.join(DIR, "syntax.js"), "function f() {\n  const x = [1, 2\n}\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* 1) JS semantic error: toUpperCase on a number */
  await win.evaluate((p) => window.__openInEditor(p), P("bad.js"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  let diags = [];
  for (let i = 0; i < 60 && diags.length === 0; i++) { await win.waitForTimeout(250); diags = await win.evaluate(() => window.__cm().diagnosticsDetailed()); }
  console.log("JS diags:", JSON.stringify(diags.map((d) => d.message).slice(0, 5)));
  ok(diags.length >= 1, `JS file captures semantic errors (${diags.length})`);
  ok(diags.some((d) => /toUpperCase|not.*exist/i.test(d.message)), "JS error mentions toUpperCase");

  /* 2) TSX semantic error: string assigned to number */
  await win.evaluate((p) => window.__openInEditor(p), P("comp.tsx"));
  await win.waitForTimeout(400);
  diags = [];
  for (let i = 0; i < 60 && diags.length === 0; i++) { await win.waitForTimeout(250); diags = await win.evaluate(() => window.__cm().diagnosticsDetailed()); }
  console.log("TSX diags:", JSON.stringify(diags.map((d) => d.message).slice(0, 5)));
  ok(diags.length >= 1, `TSX file captures semantic errors (${diags.length})`);
  ok(diags.some((d) => /not assignable|Type.*string.*number/i.test(d.message)), "TSX error mentions type mismatch");

  /* 3) JS syntax error: unclosed bracket */
  await win.evaluate((p) => window.__openInEditor(p), P("syntax.js"));
  await win.waitForTimeout(400);
  diags = [];
  for (let i = 0; i < 60 && diags.length === 0; i++) { await win.waitForTimeout(250); diags = await win.evaluate(() => window.__cm().diagnosticsDetailed()); }
  console.log("Syntax diags:", JSON.stringify(diags.map((d) => d.message).slice(0, 5)));
  ok(diags.length >= 1, `JS syntax errors captured (${diags.length})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME JS/TSX ERROR TESTS FAILED" : "\nALL JS/TSX ERROR TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
