/* Editing assists: snippets (Tab-stops), Emmet abbreviation expansion, and
 * EditorConfig-driven trim-trailing-whitespace + final-newline on save. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-assists");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, ".editorconfig"), "root = true\n\n[*]\nindent_style = space\nindent_size = 4\ntrim_trailing_whitespace = true\ninsert_final_newline = true\n");
  fs.writeFileSync(path.join(DIR, "snip.js"), "// snippets\n\n");
  fs.writeFileSync(path.join(DIR, "page.html"), "<!doctype html>\n<html>\n<body>\n\n</body>\n</html>\n");
  const ECFILE = path.join(DIR, "code.ts");
  fs.writeFileSync(ECFILE, "const x = 1;   \nconst y = 2;");   // trailing spaces line 1, NO final newline

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- 1) snippets ---------- */
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "snip.js").replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(500);
  await win.click(".cm-content");
  await win.keyboard.press("Control+End");
  await win.keyboard.type("clg");
  await win.waitForSelector(".cm-tooltip-autocomplete", { timeout: 6000 }).catch(() => {});
  await win.waitForTimeout(300);
  const hasClg = await win.evaluate(() => [...document.querySelectorAll(".cm-tooltip-autocomplete .cm-completionLabel")].some((e) => e.textContent === "clg"));
  ok(hasClg, "snippet 'clg' appears in the completion popup");
  // accept the clg snippet
  await win.evaluate(() => { const li = [...document.querySelectorAll(".cm-tooltip-autocomplete li")].find((l) => l.querySelector(".cm-completionLabel") && l.querySelector(".cm-completionLabel").textContent === "clg"); if (li) li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await win.waitForTimeout(300);
  ok(/console\.log\(/.test(await win.evaluate(() => window.__cm().getValue())), "accepting the snippet expands to console.log()");

  /* ---------- 2) Emmet ---------- */
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "page.html").replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(400);
  await win.click(".cm-content");
  await win.evaluate(() => window.__cm().gotoLine(4, 1));
  await win.waitForTimeout(120);
  await win.keyboard.type("ul>li*3");
  await win.waitForTimeout(300);
  await win.keyboard.press("Tab");
  await win.waitForTimeout(300);
  const html = await win.evaluate(() => window.__cm().getValue());
  const liCount = (html.match(/<li>/g) || []).length;
  ok(/<ul>/.test(html) && liCount >= 3, `Emmet expanded "ul>li*3" → <ul> with ${liCount} <li> elements`);

  /* ---------- 3) EditorConfig: trim trailing whitespace + final newline on save ---------- */
  await win.evaluate((p) => window.__openInEditor(p), ECFILE.replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(500);   // let .editorconfig resolve
  // make it dirty (type a trailing space), then save
  await win.click(".cm-content");
  await win.keyboard.press("Control+End");
  await win.keyboard.type(" ");
  await win.keyboard.press("Control+s");
  await win.waitForTimeout(500);
  const onDisk = fs.readFileSync(ECFILE, "utf8");
  ok(!/[ \t]+\n/.test(onDisk) && !/[ \t]+$/.test(onDisk.replace(/\n$/, "")), "trailing whitespace trimmed on save (.editorconfig)");
  ok(onDisk.endsWith("\n"), "final newline added on save (.editorconfig)");
  ok(onDisk.replace(/\r\n/g, "\n") === "const x = 1;\nconst y = 2;\n", `saved file is normalised (${JSON.stringify(onDisk.replace(/\r\n/g, "\n"))})`);

  ok(errors.length === 0, "no page errors during the editing-assists flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME EDITING-ASSISTS TESTS FAILED" : "\nALL EDITING-ASSISTS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
