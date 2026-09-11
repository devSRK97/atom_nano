/* Boot the PACKAGED build and confirm the new code is live. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const exe = path.join(__dirname, "..", "dist", "win-unpacked", "AtomNano.exe");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const app = await electron.launch({ executablePath: exe, args: [], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 20000 });
  ok(true, "packaged build booted");

  // Settings lives in the top-right titlebar (#tbSettings); the panel uses a category
  // nav (Connection/Appearance/Agent/Editor/Storage) that renders each category's
  // fields lazily, so navigate into a category before checking its controls.
  await win.evaluate(() => { const b = document.querySelector("#tbSettings"); if (b) b.click(); });
  await win.waitForSelector(".st-nav .st-cat", { timeout: 8000 });
  const clickCat = async (label) => { await win.evaluate((l) => { const c = [...document.querySelectorAll(".st-nav .st-cat")].find((x) => x.textContent.trim() === l); if (c) c.click(); }, label); await win.waitForTimeout(150); };
  const fieldLabels = () => win.evaluate(() => [...document.querySelectorAll(".st-content .field label")].map((l) => l.textContent.trim()));

  const cats = await win.evaluate(() => [...document.querySelectorAll(".st-nav .st-cat")].map((c) => c.textContent.trim()));
  await clickCat("Editor");
  const edLabels = await fieldLabels();
  await clickCat("Agent");
  const agLabels = await fieldLabels();
  const api = await win.evaluate(() => ({
    termApi: typeof window.atomnano.files.openTerminal === "function",
    importApi: typeof window.atomnano.sessions.import === "function",
    closeApi: typeof window.atomnano.win.forceClose === "function",
  }));
  ok(cats.length >= 4, `settings categories present (${cats.length}: ${cats.join("/")})`);
  ok(edLabels.includes("Font style") && edLabels.includes("Font size"), "editor font controls present in packaged build");
  ok(agLabels.includes("Resend button"), "resend toggle present in packaged build");
  ok(agLabels.includes("Thinking level") && agLabels.includes("Model (all sessions)"), "Agent category exposes Thinking + Model controls (patched build)");
  ok(api.termApi, "files.openTerminal API exposed");
  ok(api.importApi, "sessions.import API exposed");
  ok(api.closeApi, "win.forceClose API exposed");

  // CodeMirror 6 editor mounts + highlights in the packaged build
  const dir = path.join(os.tmpdir(), "atomnano-pkg-cm");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "boot.js");
  fs.writeFileSync(file, "function greet(name) {\n  return 'hi ' + name;\n}\n");
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 8000 });
  await win.evaluate((p) => window.__openInEditor(p), file);
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(300);
  ok(await win.evaluate(() => !!window.__cm() && window.__cm().docText().includes("function greet")), "CodeMirror 6 editor mounts + loads a file in the packaged build");
  ok(await win.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line span")].some((s) => s.textContent === "function")), "syntax highlighting works in the packaged build");

  await app.close();
  console.log(process.exitCode ? "\nPACKAGED BOOT FAILED" : "\nPACKAGED BOOT OK");
})().catch((e) => { console.error(e); process.exit(1); });
