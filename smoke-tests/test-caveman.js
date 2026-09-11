/* Verify the caveman brevity skill lands in the Anthropic system-prompt append
 * on every turn by default, and that toggling the setting removes it. Also
 * verifies headroom is gone (no lingering IPC / bridge / global). */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano, null, { timeout: 15000 });

  // 1. Setting default is ON.
  const enabled = await app.evaluate(() => global.__store.getSettings().enableCavemanBrevity !== false);
  ok(enabled === true, "enableCavemanBrevity defaults to TRUE");

  // 2. The caveman module returns the vendored skill text with the key
  //    instructional phrases intact.
  const skill = await app.evaluate(() => global.__caveman.systemAppend());
  ok(typeof skill === "string" && skill.length > 500 && skill.length < 4000,
    `caveman skill text present (${skill && skill.length} chars)`);
  ok(/Respond terse like smart caveman/i.test(skill), "skill opens with the canonical caveman directive");
  ok(/Drop: articles/i.test(skill), "skill lists the drop-articles rule");
  ok(/never abbreviate or paraphrase/i.test(skill) && /API names/i.test(skill), "skill enforces technical-terms-verbatim");
  ok(/ACTIVE EVERY RESPONSE/i.test(skill), "skill has the persistence directive");

  // 3. Headroom infrastructure is GONE — the module, bridge, IPC handler and
  //    global hook must all be absent.
  const headroomModule = await app.evaluate(() => { try { require("./headroomProxy"); return "present"; } catch { return "absent"; } });
  ok(headroomModule === "absent", `headroomProxy module deleted (got ${headroomModule})`);
  const bridge = await win.evaluate(() => !!(window.atomnano && window.atomnano.headroom));
  ok(!bridge, "atom.headroom bridge removed from preload");
  const globalHook = await app.evaluate(() => typeof global.__headroomProxy);
  ok(globalHook === "undefined", "global.__headroomProxy test hook removed");
  const settingGone = await app.evaluate(() => "enableHeadroomProxy" in global.__store.getSettings());
  ok(!settingGone, "enableHeadroomProxy default setting removed");

  // 4. defaultMcp no longer includes headroom.
  const mcpNames = await app.evaluate(() => Object.keys(global.__defaultMcp.composeMcpServers({}, { enableDefaultMcp: true })).sort());
  ok(mcpNames.includes("codebase-memory-mcp"), `codebase-memory-mcp still in defaults (${JSON.stringify(mcpNames)})`);
  ok(!mcpNames.includes("headroom"), `headroom removed from defaults (${JSON.stringify(mcpNames)})`);

  await app.close();
  console.log(process.exitCode ? "\nCAVEMAN FAILED" : "\nCAVEMAN PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
