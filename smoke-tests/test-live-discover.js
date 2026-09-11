"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.models, null, { timeout: 15000 });
  // startup discovery resolves fable/opus/sonnet/haiku in the background — wait for it
  let ids = [];
  for (let i = 0; i < 25; i++) { await win.waitForTimeout(1000); ids = await win.evaluate(() => window.atomnano.settings.get().then(s => s.discoveredModels || [])); if (ids.length) break; }
  console.log("DISCOVERED:", JSON.stringify(ids));
  if (!ids.length) { console.log("SKIP: no resolution (login/network)"); await app.close(); console.log("\nLIVE DISCOVER SKIPPED"); return; }
  ok(ids.some((id) => /^claude-opus/.test(id)), "resolved a concrete opus id from init (no full turn)");
  ok(ids.every((id) => /^claude-/.test(id)), "all resolved ids look like real model ids");
  await app.close();
  console.log(process.exitCode ? "\nLIVE DISCOVER FAILED" : "\nLIVE DISCOVER PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
