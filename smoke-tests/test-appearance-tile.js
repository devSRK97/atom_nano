"use strict";
/* Settings → Appearance → Taskbar tile, driven through the REAL app with an isolated
 * profile (smoke-tests/_env.js): live preview, custom letters (≤ 4), text size stepper,
 * colour swatches + free colour picker, everything saved per project.
 * Writes test-results/appearance-tile.png.  Run: node smoke-tests/test-appearance-tile.js */
const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const { tmpRoot, isolatedEnv, cleanup } = require("./_env");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const RUN = tmpRoot("tile");
  const ENV = isolatedEnv(RUN);
  const PROJECT = path.join(RUN, "Cognito Project");
  fs.mkdirSync(PROJECT, { recursive: true }); fs.writeFileSync(path.join(PROJECT, "readme.md"), "# hi\n");

  const app = await electron.launch({ args: [ROOT], env: ENV });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__setProject === "function" && typeof window.__openSettings === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), PROJECT.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate(() => window.__openSettings());
  await win.waitForSelector(".st-cat");
  await win.evaluate(() => [...document.querySelectorAll(".st-cat")].find((b) => /Appearance/.test(b.textContent)).click());
  await win.waitForSelector(".tile-box .tile-canvas");

  /* 1) the controls */
  const shape = await win.evaluate(() => ({
    canvas: !!document.querySelector(".tile-canvas"), maxLen: document.querySelector(".tile-text").maxLength, placeholder: document.querySelector(".tile-text").placeholder,
    size: document.querySelector(".tile-box .step-val").textContent, swatches: document.querySelectorAll(".tag-colors .tag-swatch").length, picker: !!document.querySelector(".tag-custom-input[type=color]"),
    labels: [...document.querySelectorAll(".st-content .field > label")].map((l) => l.textContent),
  }));
  ok(shape.canvas && shape.maxLen === 4 && shape.placeholder === "COGN" && shape.size === "100%" && shape.picker && shape.swatches >= 13, `Appearance shows the tile preview, a 4-letter text box (placeholder ${shape.placeholder}), size ${shape.size}, ${shape.swatches} colour swatches incl. the picker`);
  ok(shape.labels.includes("Taskbar tile") && shape.labels.includes("Taskbar tile color"), `fields: ${shape.labels.join(" · ")}`);

  /* 2) custom letters → cleaned, upper-cased, preview redraws */
  const png0 = await win.evaluate(() => document.querySelector(".tile-canvas").toDataURL());
  await win.fill(".tile-text", "qa!x");
  await win.waitForTimeout(250);
  const t = await win.evaluate(() => ({ value: document.querySelector(".tile-text").value, png: document.querySelector(".tile-canvas").toDataURL() }));
  ok(t.value === "QAX" && t.png !== png0, `custom text is cleaned to letters/digits and upper-cased (${t.value}) and the preview redraws`);

  /* 3) size stepper: − twice → 80 % (smaller letters); + past the fit is refused; Reset → 100 % */
  const minus = () => win.evaluate(() => document.querySelector(".tile-box .stepper button").click());
  // stepper buttons: [−, +, Reset]
  const sizeOf = () => win.evaluate(() => ({ label: document.querySelector(".tile-box .step-val").textContent, px: +document.querySelector(".tile-canvas").dataset.fontPx, plusDisabled: [...document.querySelectorAll(".tile-box .stepper button")][1].disabled, note: [...document.querySelectorAll(".tile-ctl .hint")].map((e) => e.textContent).join(" | ") }));
  const s100 = await sizeOf();
  await minus(); await minus(); await win.waitForTimeout(150);
  const s80 = await sizeOf();
  ok(s80.label === "80%" && s80.px < s100.px && !s80.plusDisabled, `two − steps → ${s80.label}, letters ${s100.px}px → ${s80.px}px, + available`);
  await win.evaluate(() => [...document.querySelectorAll(".tile-box .stepper button")].find((b) => b.textContent === "Reset").click());
  await win.evaluate(() => [...document.querySelectorAll(".tile-box .stepper button")][1].click());   // + → 110 %
  await win.waitForTimeout(150);
  const s110 = await sizeOf();
  ok(s110.label === "110%" && s110.plusDisabled && /Fills the tile/.test(s110.note), `+ past the width fit is reported (${s110.label}, + disabled=${s110.plusDisabled}, note: "${s110.note}")`);
  await win.evaluate(() => [...document.querySelectorAll(".tile-box .stepper button")].find((b) => b.textContent === "Reset").click());
  await win.waitForTimeout(150);
  ok((await sizeOf()).label === "100%", "Reset returns to 100 %");

  /* 4) the colour picker (last swatch) accepts any colour; a light tile gets dark letters */
  await win.evaluate(() => { const i = document.querySelector(".tag-custom-input"); i.value = "#f5e9c8"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); });
  await win.waitForTimeout(250);
  const col = await win.evaluate(() => {
    const c = document.querySelector(".tile-canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80 && d[i + 3] > 200) dark++;
    const sw = document.querySelector(".tag-swatch.tag-custom");
    return { sel: sw.classList.contains("sel"), bg: sw.style.background, dark, curated: document.querySelectorAll(".tag-colors .tag-swatch.sel").length };
  });
  ok(col.sel && /245, 233, 200|#f5e9c8/i.test(col.bg) && col.dark > 100 && col.curated === 1, `custom colour is selected (${col.bg}); the light tile is drawn with dark letters (${col.dark} px)`);

  /* 5) everything is saved for THIS project */
  const saved = await win.evaluate(async () => { const s = await window.atomnano.settings.get(); return Object.values(s.projects || {}).find((r) => /cognito project/i.test(r.path || "")) || null; });
  ok(saved && saved.tagText === "QAX" && saved.tagSize === 100 && saved.tagColor === "#f5e9c8", `tile settings persisted per project (${JSON.stringify(saved)})`);

  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  await win.screenshot({ path: path.join(ROOT, "test-results", "appearance-tile.png") });
  ok(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await app.close();
  cleanup(RUN);
  console.log(process.exitCode ? "\nAPPEARANCE TILE SMOKE: FAILURES" : "\nALL APPEARANCE TILE CHECKS PASSED");
})().catch((e) => { console.error(e); process.exit(2); });
