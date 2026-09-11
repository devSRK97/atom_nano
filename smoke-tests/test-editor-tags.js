/* Markup editing: auto-close tags (HTML + JSX) and auto-rename tag pairs (HTML). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-tags");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "page.html"), "<body>\n  \n</body>\n");
  fs.writeFileSync(path.join(DIR, "comp.jsx"), "function C() {\n  return ;\n}\n");
  fs.writeFileSync(path.join(DIR, "rename.html"), "<section>hello</section>\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- 1) auto-close: HTML ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("page.html"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(500);
  await win.click(".cm-content");
  await win.evaluate(() => window.__cm().gotoLine(2, 3));   // inside the indented blank line
  await win.waitForTimeout(120);
  await win.keyboard.type("<div>");
  await win.waitForTimeout(250);
  let v = await win.evaluate(() => window.__cm().getValue());
  ok(/<div><\/div>/.test(v), `HTML auto-closed <div> (${JSON.stringify((v.match(/<div>.*/)||[""])[0].slice(0,18))})`);

  /* ---------- 2) auto-close: JSX ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("comp.jsx"));
  await win.waitForTimeout(500);
  await win.click(".cm-content");
  await win.evaluate(() => { const cm = window.__cm(); const i = cm.slice(0, 9999).indexOf("return ") + 7; cm.selectRange(i, i); });
  await win.keyboard.type("<span>");
  await win.waitForTimeout(250);
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/<span><\/span>/.test(v), `JSX auto-closed <span> (${JSON.stringify((v.match(/<span>.*/)||[""])[0].slice(0,20))})`);

  /* ---------- 3) auto-rename tag pair (HTML) ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("rename.html"));
  await win.waitForTimeout(500);
  await win.click(".cm-content");
  // place caret right after "<section" open-tag name and type to extend the name
  await win.evaluate(() => { const cm = window.__cm(); const i = "<section".length; cm.selectRange(i, i); });
  await win.keyboard.type("X");   // open tag becomes <sectionX>
  await win.waitForTimeout(400);  // microtask + mirror dispatch
  v = await win.evaluate(() => window.__cm().getValue());
  ok(/<sectionX>hello<\/sectionX>/.test(v), `editing the open tag renamed the close tag (${JSON.stringify(v.trim())})`);

  ok(errors.length === 0, "no page errors during the markup flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME MARKUP TESTS FAILED" : "\nALL MARKUP TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
