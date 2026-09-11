/* Verify: no "Latest *" aliases in the dropdown; a newly discovered model id
 * (e.g. claude-opus-4-9) is shown at the TOP with a friendly name. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  // stub active discovery so startup doesn't spawn real CLI probes
  await app.evaluate(() => { if (global.__claude) global.__claude.discoverModels = async () => (global.__stubDiscover || []); });
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });
  await win.evaluate(() => window.atomnano.settings.set({ discoveredModels: [] }));

  const closeMenu = () => win.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  const openDropdownNames = async () => {
    // The menu always has the built-in models; an empty read is a render-timing
    // artifact on the first open, so retry rather than report a false negative.
    for (let attempt = 0; attempt < 3; attempt++) {
      await closeMenu(); await win.waitForTimeout(60);
      await win.evaluate(() => { const t = document.querySelector(".composer-toolbar .dd .dd-trigger"); if (t) t.click(); });
      await win.waitForTimeout(300);
      const names = await win.evaluate(() => [...document.querySelectorAll(".dd-menu .di-title")].map((e) => e.textContent.trim()));
      await closeMenu(); await win.waitForTimeout(80);
      if (names.length) return names;
    }
    return [];
  };

  // baseline: no alias entries
  let names = await openDropdownNames();
  console.log("BASELINE:", JSON.stringify(names));
  ok(!names.some((n) => /^Latest /i.test(n)), "no 'Latest *' alias entries in the dropdown");
  ok(names[0] === "Fable 5", "pinned models present (Fable 5 first when nothing new)");
  ok(names.includes("Opus 4.8"), "Opus 4.8 still pinned below Fable 5");

  // a new model appears (CLI update / first use) → registered
  await app.evaluate(() => global.__claude.registerModel("claude-opus-4-9"));
  await win.waitForTimeout(400);
  names = await openDropdownNames();
  console.log("AFTER NEW:", JSON.stringify(names));
  ok(names[0] === "Opus 4.9", `new model added at the TOP ("${names[0]}")`);
  ok(names.includes("Opus 4.8"), "existing pinned models still present");
  // registering a known builtin id should NOT duplicate it
  await app.evaluate(() => global.__claude.registerModel("claude-opus-4-8"));
  await win.waitForTimeout(300);
  names = await openDropdownNames();
  ok(names.filter((n) => n === "Opus 4.8").length === 1, "known builtin id is not duplicated");

  // a new model line (fable) renders with a friendly name, not the raw id …
  await app.evaluate(() => global.__claude.registerModel("claude-fable-6"));
  await win.waitForTimeout(300);
  names = await openDropdownNames();
  console.log("AFTER FABLE:", JSON.stringify(names));
  ok(names.includes("Fable 6"), "new family (fable) gets a friendly name, not the raw id");
  ok(!names.some((n) => /claude-fable/.test(n)), "no raw 'claude-fable-*' id leaks into the dropdown");
  // … and a dated snapshot must NOT turn its YYYYMMDD suffix into a minor version
  await app.evaluate(() => global.__claude.registerModel("claude-fable-5-20260601"));
  await win.waitForTimeout(300);
  names = await openDropdownNames();
  ok(!names.some((n) => /Fable 5\.\d{4}/.test(n)), "dated snapshot renders as 'Fable 5', not 'Fable 5.20260601'");

  await app.close();
  console.log(process.exitCode ? "\nSOME MODEL-DISCOVER TESTS FAILED" : "\nALL MODEL-DISCOVER TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
