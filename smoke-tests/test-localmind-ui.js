/* Local optimizer — Settings setup modal: on-demand engine install state +
 * dynamic, capability-filtered model catalog + download → enable. Uses injected
 * fakes (no network/model/native engine).
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-lmui");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const openSetup = async (win) => { await win.evaluate(() => { const b = [...document.querySelectorAll(".st-content button")].find((x) => /Set up|Manage/.test(x.textContent)); if (b) b.click(); }); await win.waitForFunction(() => document.querySelector(".lm-setup"), null, { timeout: 8000 }); };
const closeModal = async (win) => { await win.evaluate(() => { const ms = [...document.querySelectorAll(".modal")]; const m = ms.find((x) => x.querySelector(".lm-setup")); if (m) { const d = m.querySelector(".modal-foot .btn"); if (d) d.click(); } }); await win.waitForTimeout(150); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-lmui-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => window.atomnano.localmind && window.atomnano.test.localmindFake && typeof window.__settingsCat === "function", null, { timeout: 15000 });

  /* ---------- engine NOT installed: modal shows Install + dynamic catalog ---------- */
  await win.evaluate(() => window.atomnano.test.localmindFake({ runtime: false }));   // downloader+catalog+installer, no runtime
  await win.evaluate(() => window.__openSettings());
  await win.waitForTimeout(150);
  await win.evaluate(() => window.__settingsCat("Providers"));
  await win.waitForFunction(() => document.querySelector(".lm-model"), null, { timeout: 8000 });
  await openSetup(win);

  const a = await win.evaluate(() => ({
    enginePill: (document.querySelector(".lm-setup .status-pill") || {}).textContent || "",
    installBtn: [...document.querySelectorAll(".lm-setup button")].some((b) => /Install engine/.test(b.textContent)),
    cards: document.querySelectorAll(".lm-setup .lm-card").length,
    recCards: document.querySelectorAll(".lm-setup .lm-card.rec").length,
    badges: [...document.querySelectorAll(".lm-setup .lm-badge")].map((b) => b.textContent),
    capsLine: [...document.querySelectorAll(".lm-setup .hint")].some((h) => /GB RAM/.test(h.textContent)),
  }));
  ok(/Not installed/.test(a.enginePill) && a.installBtn, "engine shows Not installed + an Install engine button (on-demand)");
  ok(a.cards >= 3, `the dynamic catalog lists models (${a.cards})`);
  ok(a.recCards === 1, "exactly one model is marked Recommended for this machine");
  ok(a.badges.some((b) => /Recommended/.test(b)), `models carry capability badges (${a.badges.join(", ")})`);
  ok(a.capsLine, "the modal shows this machine's capabilities");
  /* ---------- engine installed: download recommended → enabled ---------- */
  await win.evaluate(() => [...document.querySelectorAll(".modal .mh-close")].forEach((b) => b.click()));   // close all modals
  await win.waitForTimeout(150);
  await win.evaluate(() => window.atomnano.test.localmindFake());   // inject runtime → engine "installed"
  await win.evaluate(() => window.__openSettings());
  await win.waitForTimeout(150);
  await win.evaluate(() => window.__settingsCat("Providers"));
  await win.waitForFunction(() => document.querySelector(".lm-model"), null, { timeout: 8000 });
  await openSetup(win);
  ok(/Installed/.test(await win.evaluate(() => (document.querySelector(".lm-setup .status-pill") || {}).textContent || "")), "after install, engine shows Installed");
  // click the recommended model's Download
  await win.evaluate(() => { const c = document.querySelector(".lm-setup .lm-card.rec"); const b = c && c.querySelector("button"); if (b) b.click(); });
  await win.waitForFunction(() => document.querySelector(".lm-setup .lm-card.rec.active"), null, { timeout: 8000 });
  const st = await win.evaluate(() => window.atomnano.localmind.status());
  ok(st.downloaded && st.enabled && st.ready, "recommended model downloads, auto-enables, and is ready");
  const card = await win.evaluate(() => { const c = document.querySelector(".lm-setup .lm-card.rec.active"); return { toggleOn: !!c.querySelector(".lm-toggle.on"), enabledBadge: !!c.querySelector(".lm-on-badge"), hasRemove: !!c.querySelector(".lm-iconbtn") }; });
  ok(card.toggleOn && card.enabledBadge && card.hasRemove, "downloaded card shows Enable toggle (on) + Enabled badge + Remove");
  // the card toggle disables it
  await win.evaluate(() => { const t = document.querySelector(".lm-setup .lm-card.rec .lm-toggle"); if (t) t.click(); });
  await win.waitForTimeout(200);
  ok((await win.evaluate(() => window.atomnano.localmind.status())).enabled === false, "the card toggle disables the model");
  // and re-enables
  await win.evaluate(() => { const t = document.querySelector(".lm-setup .lm-card.rec .lm-toggle"); if (t) t.click(); });
  await win.waitForTimeout(200);
  ok((await win.evaluate(() => window.atomnano.localmind.status())).enabled === true, "the card toggle re-enables it");

  /* ---------- it now refines the distiller ---------- */
  fs.writeFileSync(path.join(DIR, "p.html"), `<style>.btn{color:red}</style><button class="btn" onclick="go()">x</button><script>function go(){}</script>`);
  const an = await win.evaluate((cwd) => window.atomnano.distill.analyze("fix the button", [{ kind: "file", name: "p.html", path: cwd + "/p.html" }]), DIR.replace(/\\/g, "/"));
  ok(an && an.model === "neural+heuristic" && /focus note/i.test(an.context), "the distiller folds in the local model's focus note once enabled");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME LOCALMIND-UI TESTS FAILED" : "\nALL LOCALMIND-UI TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
