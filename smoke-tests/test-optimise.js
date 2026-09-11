/* Local pre-mind in the app: the composer "Optimise" button runs the on-device
 * distiller over the prompt + attached file (real IPC → main reads the file →
 * distill.js), shows the kept/stripped banner, stashes the slice on the tab, and
 * threads it to the run as extraSystem (then clears).
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-optimise");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

const HTML = `<!doctype html><html><head>
<style>
 :root { --brand:#4f46e5; --radius:8px; }
 body { font-family: Inter, sans-serif; }
 .btn { background: var(--brand); border-radius: var(--radius); padding: 10px 18px; }
 .footer-note { color:#888; }
</style>
<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments);}gtag('config','UA-X');</script>
</head><body>
<nav class="navbar">nav ${"x".repeat(2500)}</nav>
<button class="btn" id="cta" onclick="onCta()">Go</button>
<p class="footer-note">${"filler ".repeat(600)}</p>
<script>function onCta(){ const b=document.getElementById('cta'); b.classList.add('loading'); junk(); }
function junk(){ for(let i=0;i<50;i++) console.log(i); }</script>
</body></html>`;

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "page.html"), HTML);
  const udir = path.join(os.tmpdir(), "atomnano-optimise-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__optimise === "function" && window.atomnano.distill, null, { timeout: 15000 });
  const CWD = DIR.replace(/\\/g, "/");
  await win.evaluate((p) => window.__setProject(p), CWD);
  await win.waitForTimeout(300);

  ok(await win.evaluate(() => !!document.getElementById("optimiseBtn")), "the Optimise button is in the composer");

  /* attach the HTML file + a bug-fix prompt, then Optimise */
  await win.evaluate((cwd) => window.__setAttachments([{ kind: "file", name: "page.html", path: cwd + "/page.html" }]), CWD);
  await win.evaluate(() => window.__setPrompt("fix the button glitch"));
  const d = await win.evaluate(() => window.__optimise());
  ok(d && d.intent === "bugfix" && (d.entities || []).includes("button"), `Optimise classified the request (${d && d.intent} · ${d && d.entities})`);
  ok(/<button class="btn"/.test(d.context) && /\.btn\s*\{/.test(d.context) && /function onCta/.test(d.context), "the distilled slice has the button markup + CSS + handler");
  ok(!/dataLayer/.test(d.context) && !/filler filler/.test(d.context), "unrelated analytics + filler were stripped");
  ok(d.stripped > 2000, `stripped the bulk locally (${Math.round(d.stripped / 1024)} KB)`);

  /* banner reflects it */
  const bar = await win.evaluate(() => window.__optimiseBar());
  ok(bar && /bugfix/.test(bar.title) && /stripped/.test(bar.sub), `the Optimise banner shows the summary (${bar && bar.title})`);

  /* sending threads the slice as extraSystem, then clears (payload captured in main) */
  await win.evaluate(() => window.__composerSend("fix the button glitch"));
  await win.waitForTimeout(300);
  const sent = await win.evaluate(() => window.atomnano.test.lastRunPayload());
  ok(sent && /Local pre-analysis/.test(sent.extraSystem || "") && /<button class="btn"/.test(sent.extraSystem || ""), "send() threads the distilled slice to the run as extraSystem");
  ok((await win.evaluate(() => window.__optimiseBar())) === null, "the banner clears after sending");

  /* no-attachment guard */
  await win.evaluate(() => window.__setAttachments([]));
  const none = await win.evaluate(() => window.__optimise());
  ok(none === null, "Optimise with no file attachment is a no-op");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME OPTIMISE TESTS FAILED" : "\nALL OPTIMISE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
