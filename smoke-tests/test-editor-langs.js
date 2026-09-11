/* Editor capabilities: lazy-loaded language grammars (code-split chunks under
 * file://), syntax-error linting, code folding, sticky scroll (settings-gated),
 * and find & replace. Drives the real CM6 editor via the app's test hooks. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-langs");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const files = {
    "main.go": "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}\n",
    "lib.rs": "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn main() {\n    println!(\"{}\", add(1, 2));\n}\n",
    "conf.yaml": "name: test\nitems:\n  - one\n  - two\nnested:\n  key: value\n",
    "styles.scss": "$c: #fff;\n.box {\n  color: $c;\n  &:hover { color: red; }\n}\n",
    "run.sh": "#!/bin/bash\nfor f in *.txt; do\n  echo \"$f\"\ndone\n",
    "Main.java": "public class Main {\n  public static void main(String[] args) {\n    System.out.println(\"hi\");\n  }\n}\n",
    "bad.json": "{\n  \"a\": 1,\n  \"b\":\n}\n",
    "repl.js": "const foo = 1;\nconst x = foo + foo;\nlog(foo);\n",
  };
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(DIR, n), c);
  // a tall JS file (one long function) for folding + sticky scroll
  let big = "function outer(config) {\n";
  for (let i = 0; i < 160; i++) big += `  const v${i} = ${i} + config.base;\n`;
  big += "  return v0;\n}\n";
  fs.writeFileSync(path.join(DIR, "big.js"), big);
  // a large INVALID file (~3MB, over the old 2MB cap) → off-thread lint on a big file
  let bigLint = "function broken( {\n";   // syntax error on line 1
  for (let i = 0; i < 220000; i++) bigLint += `const a${i} = ${i};\n`;
  fs.writeFileSync(path.join(DIR, "big-lint.js"), bigLint);
  // a large file (~320KB) with many matches → off-thread find counting
  let bigFind = "";
  for (let i = 0; i < 12000; i++) bigFind += `line ${i} has needle here\n`;
  fs.writeFileSync(path.join(DIR, "big-find.js"), bigFind);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });

  const open = async (name) => {
    await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, name));
    await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
    await win.waitForTimeout(550);   // let the lazy grammar chunk load + parse
  };
  const hasLang = () => win.evaluate(() => window.__cm().hasLanguage());

  /* ---------- 1) lazy-loaded grammars (proves code-split import() under file://) ---------- */
  for (const [name, label] of [["main.go", "Go"], ["lib.rs", "Rust"], ["conf.yaml", "YAML"], ["styles.scss", "SCSS"], ["run.sh", "Shell (legacy mode)"], ["Main.java", "Java"]]) {
    await open(name);
    ok(await hasLang(), `${label} grammar lazy-loaded and active (${name})`);
  }

  /* ---------- 2) syntax-error linting ---------- */
  await open("bad.json");
  await win.waitForTimeout(900);   // linter delay (500ms) + parse
  const diags = await win.evaluate(() => window.__cm().diagnosticCount());
  ok(diags > 0, `lint flags invalid JSON (${diags} diagnostic${diags === 1 ? "" : "s"})`);
  await open("repl.js");
  await win.waitForTimeout(900);
  ok((await win.evaluate(() => window.__cm().diagnosticCount())) === 0, "no false syntax errors on valid JS");

  /* ---------- 2b) lint + find-count actually run on worker cores ---------- */
  const ws1 = await win.evaluate(() => window.__cm().workerStats());
  ok(ws1.lint > 0, `syntax-error lint ran on a worker core (lint=${ws1.lint}, workers=${ws1.workers}/${ws1.poolSize})`);
  // off-thread lint on a ~3MB invalid file (exercises the raised >2MB cap via the real editor path)
  await open("big-lint.js");
  await win.waitForTimeout(3000);
  ok((await win.evaluate(() => window.__cm().diagnosticCount())) > 0, "a ~3MB invalid file is linted (raised cap, off the UI thread)");

  // off-thread find counting on a large file (>200KB → worker path)
  await open("big-find.js");
  await win.evaluate(() => window.__cm().openSearch());
  await win.waitForTimeout(150);
  await win.evaluate(() => { const f = document.querySelector(".cmfind .cmfind-input"); f.value = "needle"; f.dispatchEvent(new Event("input", { bubbles: true })); });
  let cnt = "";
  for (let i = 0; i < 30 && !/of\s+\d/.test(cnt); i++) { await win.waitForTimeout(120); cnt = await win.evaluate(() => (document.querySelector(".cmfind .cmfind-count") || {}).textContent || ""); }
  ok(/of\s+12000/.test(cnt), `find count computed on a worker for a large file ("${cnt}")`);
  ok((await win.evaluate(() => window.__cm().workerStats().count)) > 0, "find-counting ran on a worker core");
  await win.evaluate(() => { const btns = [...document.querySelectorAll(".cmfind .cmfind-btn")]; if (btns.length) btns[btns.length - 1].click(); });   // close find

  /* ---------- 2d) SEMANTIC (TypeScript) diagnostics on a worker core ---------- */
  fs.writeFileSync(path.join(DIR, "types.ts"), 'const n: number = "hello";\nfunction f(a: number) { return a + 1; }\nf("x");\nexport {};\n');
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "types.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  // the TS worker is ~7MB + loads lib.d.ts on first use → poll generously
  let semDiags = 0;
  for (let i = 0; i < 60 && semDiags === 0; i++) { await win.waitForTimeout(250); semDiags = await win.evaluate(() => window.__cm().diagnosticCount()); }
  const semMsgs = await win.evaluate(() => window.__cm().diagnostics().map((d) => d.message));
  ok(semDiags > 0, `semantic diagnostics produced for a .ts type error (${semDiags})`);
  ok(semMsgs.some((m) => /not assignable/i.test(m)), `real type error detected ("${(semMsgs.find((m) => /not assignable/i.test(m)) || "").slice(0, 70)}")`);
  ok((await win.evaluate(() => window.__cm().workerStats().semantic)) > 0, "TypeScript analysis ran via the project-wide service (main process)");

  // cross-file: import a type + function from a sibling file and misuse them →
  // only a PROJECT-WIDE checker (that resolves ./lib) can catch these.
  fs.writeFileSync(path.join(DIR, "lib.ts"), "export interface Point { x: number; y: number; }\nexport function add(a: number, b: number): number { return a + b; }\n");
  fs.writeFileSync(path.join(DIR, "useslib.ts"), 'import { add, Point } from "./lib";\nconst p: Point = { x: 1 };\nconst s: number = add("a", 2);\nexport { p, s };\n');
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "useslib.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  let xMsgs = [];
  for (let i = 0; i < 60 && xMsgs.length === 0; i++) { await win.waitForTimeout(250); xMsgs = await win.evaluate(() => window.__cm().diagnostics().map((d) => d.message)); }
  ok(xMsgs.length > 0, `cross-file project diagnostics produced (${xMsgs.length})`);
  ok(xMsgs.some((m) => /missing|Point|'y'/i.test(m)), `type imported from ./lib is enforced across files ("${(xMsgs.find((m) => /missing|Point|'y'/i.test(m)) || "").slice(0, 80)}")`);
  // toggling Semantic OFF clears the type diagnostics (valid syntax → grammar lint = 0)
  await win.evaluate(() => window.__cm().setSemantic(false));
  await win.waitForTimeout(800);
  ok((await win.evaluate(() => window.__cm().diagnosticCount())) === 0, "turning Semantic analysis off clears type diagnostics");
  await win.evaluate(() => window.__cm().setSemantic(true));
  // highlight layer toggle works without error
  await win.evaluate(() => { window.__cm().setHighlight(false); window.__cm().setHighlight(true); });

  /* ---------- 3) code folding ---------- */
  await open("big.js");
  ok(await win.evaluate(() => !!document.querySelector(".cm-foldGutter")), "fold gutter is present");
  let folded = 0;
  for (let i = 0; i < 16 && folded === 0; i++) {
    await win.evaluate(() => window.__cm().foldAll());
    await win.waitForTimeout(200);
    folded = await win.evaluate(() => window.__cm().foldedCount());
  }
  ok(folded > 0, `Fold All collapses blocks (${folded} folded range${folded === 1 ? "" : "s"})`);
  ok(await win.evaluate(() => !!document.querySelector(".cm-foldPlaceholder")), "folded region renders a placeholder in the viewport");
  await win.evaluate(() => window.__cm().unfoldAll());

  /* ---------- 4) sticky scroll (settings-gated) ---------- */
  await open("big.js");
  await win.evaluate(() => window.__cm().setSticky(true));
  await win.evaluate(() => window.__cm().setScrollTop(900));
  await win.waitForTimeout(300);
  ok(await win.evaluate(() => window.__cm().stickyActive()), "sticky scroll pins the enclosing function header when scrolled");
  await win.evaluate(() => window.__cm().setSticky(false));
  await win.waitForTimeout(200);
  ok(!(await win.evaluate(() => window.__cm().stickyActive())), "sticky scroll turns off when disabled in settings");

  /* ---------- 5) find & replace ---------- */
  await open("repl.js");
  await win.evaluate(() => window.__cm().openSearch());
  await win.waitForTimeout(200);
  const panelOk = await win.evaluate(() => !!document.querySelector(".cmfind .cmfind-replace-input"));
  ok(panelOk, "find panel has a replace input");
  await win.evaluate(() => {
    const find = document.querySelector(".cmfind .cmfind-input");
    const repl = document.querySelector(".cmfind .cmfind-replace-input");
    find.value = "foo"; find.dispatchEvent(new Event("input", { bubbles: true }));
    repl.value = "bar"; repl.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(200);
  await win.evaluate(() => { const all = [...document.querySelectorAll(".cmfind .cmfind-text-btn")].find((b) => /All/.test(b.textContent)); if (all) all.click(); });
  await win.waitForTimeout(250);
  const replaced = await win.evaluate(() => window.__cm().getValue());
  ok(!/foo/.test(replaced) && /bar/.test(replaced), `Replace All swapped every match (${JSON.stringify(replaced)})`);

  ok(errors.length === 0, "no page errors during editor capability flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME EDITOR-LANG TESTS FAILED" : "\nALL EDITOR-LANG TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
