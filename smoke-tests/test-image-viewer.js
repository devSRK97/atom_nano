/* Reviewer card collapsed-by-default + image viewer (zoom / rotate / reset /
 * download / pan / close).
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-imgview");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-imgview-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__injectReviewer === "function" && typeof window.__openImageViewer === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  /* ---------- reviewer card collapsed by default ---------- */
  await win.evaluate(() => window.__injectReviewer("Keep the structure but add observability detail; target ~150 words."));
  const rv = await win.evaluate(() => window.__reviewerState());
  ok(rv && rv.collapsedByDefault === true, "reviewer advice is collapsed by default");
  ok(rv && /observability/.test(rv.preview), `a one-line preview is shown (${rv && rv.preview ? rv.preview.slice(0, 40) : ""}…)`);
  ok(rv && rv.hasAsked === true, "the 'Question sent' detail is present (also collapsed)");

  /* ---------- inline attachment uses the FULL image, not the blurry thumb ---------- */
  const FULL = "R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  const inlineSrc = await win.evaluate((d) => window.__injectImageMsg(d, "image/gif"), FULL);
  ok(inlineSrc && inlineSrc.includes(FULL) && !/THUMBONLY/.test(inlineSrc), "inline image preview uses the full image data (not the downscaled thumb)");

  /* ---------- image viewer opens with controls ---------- */
  let v = await win.evaluate(() => window.__openImageViewer());
  ok(v && v.present, "image viewer opens");
  ok(v.controls.some((t) => /Zoom in/.test(t)) && v.controls.some((t) => /Zoom out/.test(t)) && v.controls.some((t) => /Rotate/.test(t)) && v.controls.some((t) => /Reset/.test(t)) && v.controls.some((t) => /Close/.test(t)), `controls present: ${v.controls.join(", ")}`);
  ok(v.download === true, "a Download control is present");
  ok(v.zoom === "100%", `zoom starts at 100% (${v.zoom})`);

  /* ---------- zoom + rotate change the transform ---------- */
  v = await win.evaluate(() => window.__ivBtn("Zoom in"));
  ok(/scale\(1\.2/.test(v.transform) && v.zoom === "120%", `zoom in scales up (${v.zoom})`);
  v = await win.evaluate(() => window.__ivBtn("Rotate"));
  ok(/rotate\(90deg\)/.test(v.transform), "rotate turns the image 90°");
  v = await win.evaluate(() => window.__ivBtn("Reset"));
  ok(/scale\(1\)/.test(v.transform) && /rotate\(0deg\)/.test(v.transform) && v.zoom === "100%", "reset returns to 100% / 0°");

  /* ---------- close ---------- */
  const stillOpen = await win.evaluate(() => window.__ivClose());
  ok(stillOpen === false, "close removes the viewer");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME IMAGE-VIEWER TESTS FAILED" : "\nALL IMAGE-VIEWER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
