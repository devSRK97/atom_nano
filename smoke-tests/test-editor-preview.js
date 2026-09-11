/* Image preview (data URL) + Markdown preview overlay. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-preview");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (n) => path.join(DIR, n).replace(/\\/g, "/");
// a real 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQGZQ4z6AAAAAElFTkSuQmCC", "base64");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "pixel.png"), PNG);
  fs.writeFileSync(path.join(DIR, "doc.md"), "# Title\n\nSome **bold** text and a [link](https://x).\n\n- one\n- two\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__imageShown === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- 1) image preview ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("pixel.png"));
  await win.waitForSelector("#editorBody .img-view", { timeout: 8000 });
  let shown = false;
  for (let i = 0; i < 20 && !shown; i++) { await win.waitForTimeout(150); shown = await win.evaluate(() => window.__imageShown()); }
  ok(shown, "image file renders an <img> with a data URL (not 'binary, opening externally')");

  /* ---------- 2) markdown preview overlay ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("doc.md"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(400);
  await win.evaluate(() => window.__toggleMdPreview());
  await win.waitForSelector("#mdPreview", { timeout: 5000 });
  await win.waitForTimeout(200);
  const html = await win.evaluate(() => window.__mdPreviewHtml());
  ok(/<h1[ >]/i.test(html) && /Title/.test(html), "markdown preview rendered the heading");
  ok(/<strong>bold<\/strong>/i.test(html) || /<b>bold<\/b>/i.test(html), "markdown preview rendered bold text");
  ok(/<li>/i.test(html), "markdown preview rendered the list");

  // toggle off → overlay removed
  await win.evaluate(() => window.__toggleMdPreview());
  await win.waitForTimeout(200);
  const gone = await win.evaluate(() => !document.getElementById("mdPreview"));
  ok(gone, "markdown preview overlay removed when toggled off");

  // switching back to the image (still open) shows the image again
  await win.evaluate((p) => window.__openInEditor(p), P("pixel.png"));
  await win.waitForTimeout(400);
  ok(await win.evaluate(() => window.__imageShown()), "switching back to the image re-renders it");

  ok(errors.length === 0, "no page errors during the preview flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME PREVIEW TESTS FAILED" : "\nALL PREVIEW TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
