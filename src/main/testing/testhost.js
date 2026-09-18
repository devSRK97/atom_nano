"use strict";
/* Embedded-Chromium TEST EXECUTOR — the test-only browser.
 *
 * AtomNano IS Chromium (Electron), so frontend tests don't need an external
 * browser: we drive a hidden BrowserWindow in-process. A "browser test" is a
 * declarative step list (click / fill / expect…) authored by the agent from a
 * goal or a recorded interaction; we load the target (a dev-server URL or an
 * inline HTML fixture) and run the steps, returning per-step pass/fail.
 *
 * Why a step list rather than a raw Playwright file: it's inspectable, storable
 * in the catalog, diffable by the integrity guard (assertion count can't silently
 * drop), and runs natively here with zero external runtime.
 *
 * Hermetic intent: each run does a fresh loadURL (fresh JS context). Deterministic
 * clock / network-stub / seeded-RNG hardening is the next layer (both consults
 * flagged e2e flakiness as the top risk); for synchronous DOM fixtures this is
 * already deterministic.
 */
const { BrowserWindow } = require("electron");
const path = require("path");

let win = null;
let hermeticNet = true;   // block external network for the current run (set per runSteps)
function ensureWin() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false, width: 1024, height: 768,
    webPreferences: {
      // contextIsolation:false so the determinism preload can patch page globals
      // (Date/Math.random) in the main world. This is a TEST-ONLY surface in its
      // own in-memory partition, loading the user's own app — acceptable trade-off.
      preload: path.join(__dirname, "testhost-preload.js"),
      contextIsolation: false, sandbox: false, nodeIntegration: false,
      backgroundThrottling: false, partition: "atomnano-testhost",
    },
  });
  // Hermetic network: block external http(s); allow data/file/blob + localhost dev servers.
  try {
    win.webContents.session.webRequest.onBeforeRequest((details, cb) => {
      if (!hermeticNet) return cb({});
      const u = details.url || "";
      if (/^(data:|file:|about:|blob:|devtools:|chrome:|chrome-extension:|ws:)/i.test(u)) return cb({});
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(u)) return cb({});
      return cb({ cancel: true });
    });
  } catch { /* webRequest unavailable */ }
  return win;
}
function dispose() { try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ } win = null; }

async function loadTarget(w, target) {
  if (target && target.html != null) await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(target.html));
  else if (target && target.url) await w.loadURL(target.url);
  else throw new Error("test target needs {url} or {html}");
}

// Compile one step into a self-contained expression evaluated IN the page,
// returning { ok, detail }. Params are JSON-injected so selectors/values can't
// break out of the expression.
function stepScript(step) {
  const S = JSON.stringify(step.selector || "");
  switch (step.type) {
    case "click":
      return `(()=>{const el=document.querySelector(${S}); if(!el)return{ok:false,detail:'no match'}; el.click(); return {ok:true,detail:'clicked'};})()`;
    case "fill":
      return `(()=>{const el=document.querySelector(${S}); if(!el)return{ok:false,detail:'no match'}; el.value=${JSON.stringify(step.value || "")}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true,detail:'filled'};})()`;
    case "expectText":
      return `(()=>{const el=document.querySelector(${S}); if(!el)return{ok:false,detail:'no match'}; const t=(el.textContent||''); return {ok:t.includes(${JSON.stringify(step.contains || "")}), detail:JSON.stringify(t.trim().slice(0,120))};})()`;
    case "expectValue":
      return `(()=>{const el=document.querySelector(${S}); if(!el)return{ok:false,detail:'no match'}; return {ok:String(el.value)===${JSON.stringify(String(step.value == null ? "" : step.value))}, detail:JSON.stringify(String(el.value).slice(0,80))};})()`;
    case "expectVisible":
      return `(()=>{const el=document.querySelector(${S}); if(!el)return{ok:false,detail:'no match'}; const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return {ok:(r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'&&cs.opacity!=='0'), detail:Math.round(r.width)+'x'+Math.round(r.height)};})()`;
    case "expectHidden":
      return `(()=>{const el=document.querySelector(${S}); if(!el)return{ok:true,detail:'absent'}; const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return {ok:!(r.width>0&&r.height>0)||cs.visibility==='hidden'||cs.display==='none', detail:'present'};})()`;
    case "expectCount":
      return `(()=>{const n=document.querySelectorAll(${S}).length; return {ok:n===${Number(step.count) || 0}, detail:'count='+n};})()`;
    case "expectAttr":
      return `(()=>{const el=document.querySelector(${S}); if(!el)return{ok:false,detail:'no match'}; const v=el.getAttribute(${JSON.stringify(step.attr || "")}); return {ok:String(v)===${JSON.stringify(String(step.value == null ? "" : step.value))}, detail:JSON.stringify(String(v).slice(0,80))};})()`;
    case "eval":
      // Advanced: an arbitrary boolean expression. Wrapped so a throw → ok:false.
      return `(()=>{try{return {ok:!!(${String(step.expr || "false")}), detail:'eval'};}catch(e){return {ok:false,detail:String(e&&e.message||e)};}})()`;
    default:
      return `({ok:false, detail:'unknown step: ${String(step.type).replace(/[^a-z0-9_-]/gi, "")}'})`;
  }
}

async function runStep(w, step) {
  if (step.type === "wait") { await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(0, step.ms || 0)))); return { ok: true, detail: "waited" }; }
  if (step.type === "goto") { try { await loadTarget(w, { url: step.url, html: step.html }); return { ok: true, detail: "navigated" }; } catch (e) { return { ok: false, detail: String((e && e.message) || e) }; } }
  try {
    const res = await w.webContents.executeJavaScript(stepScript(step), true /* userGesture → allows .click() */);
    return res && typeof res === "object" ? res : { ok: false, detail: "no result" };
  } catch (e) { return { ok: false, detail: String((e && e.message) || e) }; }
}

// Run a whole step list against a target. Stops at the first failure unless
// continueOnFail. Returns { ok, steps:[{type,selector,ok,detail}], durationMs, error? }.
async function runSteps(target, steps, opts = {}) {
  const startedAt = (opts.now || (() => 0))();   // caller stamps time (Date.now is unavailable in some sandboxes/tests)
  hermeticNet = opts.hermetic !== false;          // default: block external network
  const w = ensureWin();
  try { await w.webContents.session.clearStorageData(); } catch { /* fresh cookies/cache/storage per run */ }
  try { await loadTarget(w, target); }
  catch (e) { return { ok: false, error: "load failed: " + String((e && e.message) || e), steps: [] }; }
  const results = [];
  let ok = true;
  for (const s of (steps || [])) {
    const r = await runStep(w, s);
    results.push({ type: s.type, selector: s.selector || null, ok: !!r.ok, detail: r.detail || "" });
    if (!r.ok) { ok = false; if (!opts.continueOnFail) break; }
    if (s.type === "click" || s.type === "fill") await new Promise((res) => setTimeout(res, 12)); // let sync/microtask DOM updates settle
  }
  return { ok, steps: results, startedAt };
}

module.exports = { runSteps, dispose };
