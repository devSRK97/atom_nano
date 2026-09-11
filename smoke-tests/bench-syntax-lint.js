/* Benchmark: off-thread syntax-error linting (Lezer parse + error scan) at scale,
 * up to a 1,000,000-line file. Reports the machine (CPU / cores / cache / RAM),
 * cold (full) parse vs incremental re-parse (after a 1-char edit), and renderer
 * RAM during the largest parse. Run: node smoke-tests/bench-syntax-lint.js */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");
const ROOT = path.join(__dirname, "..");

function hwInfo() {
  const cpus = os.cpus();
  const info = {
    model: (cpus[0] && cpus[0].model || "?").trim(),
    logicalCores: cpus.length,
    speedMHz: cpus[0] && cpus[0].speed,
    totalGB: (os.totalmem() / 1073741824).toFixed(1),
    freeGB: (os.freemem() / 1073741824).toFixed(1),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
  };
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,L2CacheSize,L3CacheSize,MaxClockSpeed | ConvertTo-Json -Compress"', { timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const p = (() => { const j = JSON.parse(out); return Array.isArray(j) ? j[0] : j; })();
    if (p.Name) info.model = String(p.Name).trim();
    if (p.NumberOfCores) info.physicalCores = p.NumberOfCores;
    if (p.NumberOfLogicalProcessors) info.logicalCores = p.NumberOfLogicalProcessors;
    if (p.L2CacheSize) info.l2KB = p.L2CacheSize;
    if (p.L3CacheSize) info.l3KB = p.L3CacheSize;
    if (p.MaxClockSpeed) info.maxClockMHz = p.MaxClockSpeed;
  } catch (e) { info.cacheNote = "Win32_Processor query unavailable (" + String(e.message || e).split("\n")[0] + ")"; }
  return info;
}

const fmt = (n) => n.toLocaleString("en-US");
const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const hw = hwInfo();
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  // need a live editor instance for the benchLint hook
  const seed = path.join(os.tmpdir(), "atomnano-bench-seed.js");
  fs.writeFileSync(seed, "const x = 1;\n");
  await win.evaluate((p) => window.__openInEditor(p), seed);
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(400);

  const rendererRamKB = async () => {
    try {
      const m = await app.evaluate(({ app }) => app.getAppMetrics());
      let ws = 0; for (const p of m) if (/render|tab/i.test(p.type)) ws += (p.memory && p.memory.workingSetSize) || 0;
      return ws;
    } catch { return 0; }
  };

  const sizes = [10000, 100000, 500000, 1000000];
  const rows = [];
  const memBase = await rendererRamKB();
  let memPeak = memBase;

  for (const lines of sizes) {
    const docId = "bench:" + lines;
    let res;
    try {
      res = await win.evaluate(async ({ lines, docId }) => {
        const parts = new Array(lines);
        parts[0] = "function broken( {";                       // syntax error near the top
        for (let i = 1; i < lines; i++) parts[i] = `const v${i} = ${i} + base;`;
        if (lines > 20) parts[(lines / 2) | 0] = "if (x { call(); }";   // a second error mid-file
        const text = parts.join("\n") + "\n";
        const cold = await window.__cm().benchLint("js", text, docId);   // full parse
        const text2 = text + "// edit\n";                                // tiny edit → incremental
        const incr = await window.__cm().benchLint("js", text2, docId);
        return { bytes: text.length, cold, incr };
      }, { lines, docId });
    } catch (e) { res = { bytes: 0, error: String(e.message || e) }; }
    const now = await rendererRamKB(); if (now > memPeak) memPeak = now;
    rows.push({ lines, ...res });
  }
  await app.close();

  console.log("\n=== AtomNano — off-thread syntax-error lint benchmark ===\n");
  console.log("Machine");
  console.log(`  CPU         ${hw.model}`);
  console.log(`  Cores       ${hw.physicalCores || "?"} physical / ${hw.logicalCores} logical${hw.maxClockMHz ? "  @ " + (hw.maxClockMHz / 1000).toFixed(2) + " GHz" : (hw.speedMHz ? "  @ " + (hw.speedMHz / 1000).toFixed(2) + " GHz" : "")}`);
  console.log(`  Cache       L2 ${hw.l2KB ? (hw.l2KB / 1024).toFixed(1) + " MB" : "?"} · L3 ${hw.l3KB ? (hw.l3KB / 1024).toFixed(1) + " MB" : "?"}${hw.cacheNote ? "   (" + hw.cacheNote + ")" : ""}  (L1 not exposed by the OS API)`);
  console.log(`  RAM         ${hw.totalGB} GB total · ${hw.freeGB} GB free`);
  console.log(`  OS / arch   ${hw.platform} / ${hw.arch}`);
  console.log(`  Workers     up to ${Math.max(1, Math.min((hw.logicalCores || 4) - 2, 3))} cores (cores−2, capped at 3)`);
  console.log("");
  console.log("Lint = Lezer parse (on a worker core) + error-node scan, JavaScript grammar.");
  console.log("Cold = full parse · Incremental = re-parse after a 1-char edit (reuses the prior tree).");
  console.log("‘parse’ = compute in the worker · ‘+RTT’ = incl. postMessage transfer of the whole doc.\n");
  console.log(pad("lines", 11) + pad("size", 9) + pad("cold parse", 13) + pad("cold +RTT", 13) + pad("incr parse", 13) + pad("incr +RTT", 13) + pad("errors", 8) + "incr?");
  console.log("-".repeat(91));
  for (const r of rows) {
    if (r.error) { console.log(pad(fmt(r.lines), 11) + "ERROR: " + r.error); continue; }
    console.log(
      pad(fmt(r.lines), 11) +
      pad((r.bytes / 1048576).toFixed(1) + " MB", 9) +
      pad(r.cold.workerMs.toFixed(1) + " ms", 13) +
      pad(r.cold.rttMs.toFixed(1) + " ms", 13) +
      pad(r.incr.workerMs.toFixed(1) + " ms", 13) +
      pad(r.incr.rttMs.toFixed(1) + " ms", 13) +
      pad(String(r.cold.count), 8) +
      String(r.incr.incremental)
    );
  }
  console.log("");
  console.log(`Renderer RAM: ${(memBase / 1024).toFixed(0)} MB baseline → ${(memPeak / 1024).toFixed(0)} MB peak during the largest parse (Δ ${((memPeak - memBase) / 1024).toFixed(0)} MB — the doc copy in the worker + its parse tree).`);
  console.log("");
})().catch((e) => { console.error(e); process.exit(1); });
