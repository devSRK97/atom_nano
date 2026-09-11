/* Settings: left-nav + right-content categorized layout. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 15000 });
  await win.waitForTimeout(400);

  // open settings via keyboard
  await win.keyboard.press("Control+,");
  await win.waitForSelector(".st-layout", { timeout: 5000 });
  await win.waitForTimeout(200);

  // left nav exists with 5 categories
  const cats = await win.evaluate(() => [...document.querySelectorAll(".st-nav .st-cat")].map((e) => e.textContent.trim()));
  ok(cats.length === 5, `5 setting categories (${cats.length}: ${JSON.stringify(cats)})`);
  ok(cats.includes("Connection") && cats.includes("Editor") && cats.includes("Storage"), "expected categories present");

  // first category (Connection) is active by default
  const active = await win.evaluate(() => document.querySelector(".st-nav .st-cat.active").textContent.trim());
  ok(active === "Connection", `Connection tab active by default ("${active}")`);

  // right content has fields
  const fields = await win.evaluate(() => document.querySelectorAll(".st-content .field").length);
  ok(fields >= 1, `right panel has fields (${fields})`);

  // click Editor tab → right content changes to editor fields
  await win.evaluate(() => [...document.querySelectorAll(".st-nav .st-cat")].find((e) => e.textContent.trim() === "Editor").click());
  await win.waitForTimeout(150);
  const edFields = await win.evaluate(() => document.querySelectorAll(".st-content .field").length);
  ok(edFields >= 10, `Editor tab shows many fields (${edFields})`);
  const hasFont = await win.evaluate(() => [...document.querySelectorAll(".st-content .field label")].some((l) => /font/i.test(l.textContent)));
  ok(hasFont, "Editor tab includes a font field");

  // click Agent tab
  await win.evaluate(() => [...document.querySelectorAll(".st-nav .st-cat")].find((e) => e.textContent.trim() === "Agent").click());
  await win.waitForTimeout(150);
  const hasModel = await win.evaluate(() => [...document.querySelectorAll(".st-content .field label")].some((l) => /model/i.test(l.textContent)));
  ok(hasModel, "Agent tab includes a model field");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME SETTINGS TESTS FAILED" : "\nALL SETTINGS TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
