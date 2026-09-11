/* Copying a styled agent reply (markdown table / code) must paste correctly into:
 *   - a text editor / .md file  → the PLAIN-TEXT flavor stays the raw markdown
 *   - Word / Google Docs / email → an HTML flavor renders a real styled table
 * We write BOTH clipboard flavors; this verifies each carries the right content. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const udir = path.join(os.tmpdir(), "atomnano-copyrich-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__copyText === "function", null, { timeout: 15000 });

  const MD = "Here is the data:\n\n| Name | Role |\n|------|------|\n| Ada | Eng |\n| Lin | PM |\n\nDone.";

  // Drive the real copy path (copyText with the rendered rich HTML), exactly as
  // the message copy button / "Copy message" menu item do.
  await win.evaluate((md) => window.__copyText(md, "test", window.__mdToRichHtml(md)), MD);
  await win.waitForTimeout(150);

  const textFlavor = await app.evaluate(({ clipboard }) => clipboard.readText());
  const htmlFlavor = await app.evaluate(({ clipboard }) => clipboard.readHTML());

  // 1. Plain-text flavor = the raw markdown (clean paste into editor / .md file).
  ok(textFlavor.includes("| Name | Role |") && textFlavor.includes("| Ada | Eng |"),
    "text flavor keeps the raw markdown table (pastes clean into editor / .md)");

  // 2. HTML flavor = a real table with the same data (styled paste into Word etc.).
  ok(/<table/i.test(htmlFlavor), "HTML flavor contains a real <table> element");
  ok(/<th[^>]*>\s*Name\s*<\/th>/i.test(htmlFlavor), "HTML table has the header cells");
  ok(/<td[^>]*>\s*Ada\s*<\/td>/i.test(htmlFlavor) && /<td[^>]*>\s*PM\s*<\/td>/i.test(htmlFlavor),
    "HTML table has the body cells (Ada / PM)");
  ok(/border:1px solid/i.test(htmlFlavor), "HTML cells carry inline borders so Word renders gridlines");

  // 3. A plain string copy (no HTML arg) must NOT leave a stale table on the HTML flavor.
  await win.evaluate(() => window.__copyText("just plain words", "test"));
  await win.waitForTimeout(120);
  const htmlAfterPlain = await app.evaluate(({ clipboard }) => clipboard.readHTML());
  ok(!/Ada|<table/i.test(htmlAfterPlain), "a plain copy clears the previous rich HTML (no stale table)");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME COPY-RICH TESTS FAILED" : "\nALL COPY-RICH TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
