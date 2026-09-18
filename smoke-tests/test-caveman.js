/* The Caveman brevity skill is REMOVED — it was an app-injected instruction, and AtomNano adds
 * nothing to a prompt. Verify nothing of it lingers: no module under src/main, no main-process
 * hook, no source mention outside the store's strip-list, and the setting stripped from settings.
 * Also (unchanged) verifies headroom is gone (no lingering IPC / bridge / global) and that the
 * default MCP set is intact. Runs on an isolated profile. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const udir = path.join(os.tmpdir(), "atomnano-caveman-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano, null, { timeout: 15000 });

  // 1. The setting is gone: not a default, and stripped from a saved settings file
  //    (store.REMOVED_SETTINGS) so a stale `true` can never re-activate anything.
  const settingGone = await app.evaluate(() => "enableCavemanBrevity" in global.__store.getSettings());
  ok(!settingGone, "enableCavemanBrevity is not in settings (no default, stripped on load)");

  // 2. No main-process hook and no module: nothing under src/main is named after it, and the only
  //    source mention left is the store's strip-list of removed settings keys.
  const hook = await app.evaluate(() => typeof global.__caveman);
  ok(hook === "undefined", "global.__caveman test hook removed");
  // The source scan runs in this test process (app.evaluate has no `require`): every .js under src/main.
  const scan = (() => {
    const root = path.join(ROOT, "src", "main");
    const files = [], named = [], mentions = [], headroom = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.js$/.test(e.name)) files.push(f); } };
    walk(root);
    for (const f of files) {
      const rel = path.relative(root, f).replace(/\\/g, "/");
      if (/caveman/i.test(path.basename(f))) named.push(rel);
      if (/headroom/i.test(path.basename(f))) headroom.push(rel);
      if (/caveman/i.test(fs.readFileSync(f, "utf8"))) mentions.push(rel);
    }
    return { count: files.length, named, mentions, headroom };
  })();
  ok(scan.count > 20 && scan.named.length === 0, `no caveman module under src/main (${scan.count} files scanned)`);
  ok(scan.mentions.length >= 1 && scan.mentions.every((f) => f === "storage/store.js"), `the only source mention is the store's removed-settings strip-list (${JSON.stringify(scan.mentions)})`);
  const composerHook = await win.evaluate(() => !!(window.atomnano && window.atomnano.caveman));
  ok(!composerHook, "no atom.caveman bridge in preload");

  // 3. Headroom infrastructure is GONE — the module, bridge, IPC handler and
  //    global hook must all be absent.
  ok(scan.headroom.length === 0, `headroomProxy module deleted (${JSON.stringify(scan.headroom)})`);
  const bridge = await win.evaluate(() => !!(window.atomnano && window.atomnano.headroom));
  ok(!bridge, "atom.headroom bridge removed from preload");
  const globalHook = await app.evaluate(() => typeof global.__headroomProxy);
  ok(globalHook === "undefined", "global.__headroomProxy test hook removed");
  const headroomSetting = await app.evaluate(() => "enableHeadroomProxy" in global.__store.getSettings());
  ok(!headroomSetting, "enableHeadroomProxy default setting removed");

  // 4. defaultMcp: no headroom — and no other default either (MCP is strictly opt-in since
  //    codebase-memory-mcp left in 2026-07; providers/default-mcp.js). User entries still compose.
  const mcp = await app.evaluate(() => {
    const dm = global.__defaultMcp;
    const defaults = Object.keys(dm.composeMcpServers({}, { enableDefaultMcp: true })).sort();
    const user = dm.composeMcpServers({ mine: { command: "npx", args: ["-y", "some-mcp"] } }, { enableDefaultMcp: true });
    return { defaults, defaultsConst: Object.keys(dm.DEFAULTS), user };
  });
  ok(!mcp.defaults.includes("headroom") && !mcp.defaultsConst.includes("headroom"), `headroom removed from defaults (${JSON.stringify(mcp.defaults)})`);
  ok(mcp.defaults.length === 0 && mcp.defaultsConst.length === 0, `no default MCP server is mounted — MCP is opt-in (${JSON.stringify(mcp.defaults)})`);
  ok(mcp.user.mine && mcp.user.mine.type === "stdio" && mcp.user.mine.command === "npx", "a user-configured MCP entry still composes into the SDK shape");

  await app.close();
  console.log(process.exitCode ? "\nCAVEMAN FAILED" : "\nCAVEMAN PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
