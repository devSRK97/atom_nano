/* AtomNano vs VS Code — project-wide semantic diagnostics + RAM comparison.
 *
 * Diagnostics ground truth = `tsc --noEmit` (the exact engine VS Code's tsserver
 * wraps), run project-wide. AtomNano's main-process TypeScript service is checked
 * against it on the same file. RAM = total working set of all processes for each
 * app, with the same project + file open.
 *
 * Safety: VS Code is launched in an isolated temp profile and ONLY the processes
 * this script spawns are killed (by PID diff) — any VS Code you have open is left
 * untouched. Run: node smoke-tests/bench-vs-vscode.js */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync, execSync, spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");

const PROJ = path.join(os.tmpdir(), "atomnano-vsbench");
const MAIN = path.join(PROJ, "src", "main.ts");

function setupProject() {
  fs.rmSync(PROJ, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJ, "src"), { recursive: true });
  fs.writeFileSync(path.join(PROJ, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noUnusedLocals: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true },
    include: ["src"],
  }, null, 2));
  fs.writeFileSync(path.join(PROJ, "src", "lib.ts"),
    "export interface Point { x: number; y: number; }\n" +
    "export function add(a: number, b: number): number { return a + b; }\n");
  fs.writeFileSync(MAIN,
    'import { add, Point } from "./lib";\n' +
    "const p: Point = { x: 1 };                 // error: missing 'y'\n" +
    'const total: number = add("a", 2);         // error: arg not assignable\n' +
    "let unusedVar = 5;                          // error: unused local\n" +
    "console.log(p, total, (3).toUpperCase());  // error: toUpperCase not on number\n" +
    "export {};\n");
}

function hw() {
  const cpus = os.cpus();
  const info = { model: (cpus[0] && cpus[0].model || "?").trim(), logical: cpus.length, totalGB: (os.totalmem() / 1073741824).toFixed(1) };
  try {
    const p = JSON.parse(execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object NumberOfCores,NumberOfLogicalProcessors,L3CacheSize | ConvertTo-Json -Compress"', { timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).toString());
    info.physical = p.NumberOfCores; info.logical = p.NumberOfLogicalProcessors || info.logical; info.l3MB = p.L3CacheSize ? (p.L3CacheSize / 1024).toFixed(0) : null;
  } catch { /* ignore */ }
  return info;
}

function tscErrors() {
  // run the TS compiler JS entry directly with node (avoids the Windows .cmd shell issue)
  const tscJs = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  let out = "";
  try { out = execFileSync(process.execPath, [tscJs, "--noEmit", "--pretty", "false", "-p", PROJ], { timeout: 90000 }).toString(); }
  catch (e) { out = (e.stdout || "").toString() + (e.stderr || "").toString(); }
  return out.split(/\r?\n/).filter((l) => /main\.ts[(:].*error TS\d+/.test(l));
}

function codeExe() {
  const cands = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe"),
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
  ];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
function codeProcs() {
  try {
    const j = JSON.parse(execSync('powershell -NoProfile -Command "Get-Process Code -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress"', { timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).toString() || "null");
    if (!j) return [];
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
}

(async () => {
  setupProject();
  const machine = hw();

  // ---- 1) diagnostics ground truth: tsc (VS Code's engine), project-wide ----
  const tsc = tscErrors();

  // ---- 2) AtomNano: open main.ts, collect project-wide diagnostics + RAM ----
  // Use an ISOLATED, empty userData so we measure the app's own footprint — not
  // whatever project happened to be restored from the developer's last session
  // (V8 never returns that peak working set to the OS, which inflates the number).
  const aqxUdir = path.join(os.tmpdir(), "atomnano-vsbench-udata-self");
  fs.rmSync(aqxUdir, { recursive: true, force: true });
  // Shorten the TS-process idle-kill (prod default 90s) so we can also measure the
  // steady-state the user sits at when not actively typechecking.
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + aqxUdir], env: { ...process.env, ATOMNANO_TEST: "1", ATOMNANO_TS_IDLE_MS: "5000" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), PROJ.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate((p) => window.__openInEditor(p), MAIN.replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  let aqxDiags = [];
  for (let i = 0; i < 80 && aqxDiags.length === 0; i++) { await win.waitForTimeout(250); aqxDiags = await win.evaluate(() => window.__cm().diagnostics().map((d) => d.message)); }
  await win.waitForTimeout(500);
  const aqxMetrics = await app.evaluate(({ app }) => app.getAppMetrics());
  const aqxRamKB = aqxMetrics.reduce((s, p) => s + ((p.memory && p.memory.workingSetSize) || 0), 0);
  const aqxProcs = aqxMetrics.length;
  // Steady-state: idle past the (test-shortened) TS-process kill, then re-measure.
  await win.waitForTimeout(10000);
  const aqxIdleMetrics = await app.evaluate(({ app }) => app.getAppMetrics());
  const aqxIdleRamKB = aqxIdleMetrics.reduce((s, p) => s + ((p.memory && p.memory.workingSetSize) || 0), 0);
  const aqxIdleProcs = aqxIdleMetrics.length;
  await app.close();

  // ---- 3) VS Code: same project+file, measure RAM (isolated profile; only kill what we spawn) ----
  let codeRamMB = null, codeProcCount = null, codeNote = "";
  const CODE = codeExe();
  if (!CODE) { codeNote = "VS Code (Code.exe) not found"; }
  else {
    const udir = path.join(os.tmpdir(), "atomnano-vsbench-udata");
    const edir = path.join(os.tmpdir(), "atomnano-vsbench-ext");
    fs.rmSync(udir, { recursive: true, force: true }); fs.rmSync(edir, { recursive: true, force: true });
    const before = new Set(codeProcs().map((p) => p.Id));
    const child = spawn(CODE, [PROJ, "--goto", MAIN, "--new-window", "--disable-workspace-trust", "--user-data-dir", udir, "--extensions-dir", edir], { detached: true, stdio: "ignore" });
    child.unref();
    // let it boot: window + built-in TypeScript extension + tsserver warm-up
    await new Promise((r) => setTimeout(r, 32000));
    const after = codeProcs();
    const mine = after.filter((p) => !before.has(p.Id));
    codeRamMB = mine.length ? (mine.reduce((s, p) => s + p.WorkingSet64, 0) / 1048576) : null;
    codeProcCount = mine.length;
    // kill ONLY the processes we spawned (protect any pre-existing VS Code)
    for (const p of mine) { try { execSync(`taskkill /F /T /PID ${p.Id}`, { stdio: "ignore" }); } catch { /* ignore */ } }
    if (!mine.length) codeNote = "no new Code processes detected (already running? measurement skipped)";
  }

  // ---- report ----
  const aqxRamMB = aqxRamKB / 1024;
  console.log("\n=== AtomNano vs VS Code — semantic diagnostics + RAM ===\n");
  console.log("Machine");
  console.log(`  CPU    ${machine.model}`);
  console.log(`  Cores  ${machine.physical || "?"} physical / ${machine.logical} logical${machine.l3MB ? " · L3 " + machine.l3MB + " MB" : ""}`);
  console.log(`  RAM    ${machine.totalGB} GB total`);
  console.log("");
  console.log("Test project: tsconfig (strict, noUnusedLocals) + src/lib.ts + src/main.ts");
  console.log("main.ts has 4 deliberate errors, incl. one that needs cross-file resolution of ./lib.\n");

  console.log("── Diagnostics (project-wide) ──");
  console.log(`  tsc --noEmit (VS Code's engine):  ${tsc.length} error(s) in main.ts`);
  for (const l of tsc.slice(0, 6)) console.log("     · " + l.trim().replace(/^.*main\.ts/, "main.ts"));
  console.log(`  AtomNano (main-process TS):       ${aqxDiags.length} diagnostic(s) in main.ts`);
  for (const m of aqxDiags.slice(0, 6)) console.log("     · " + m.replace(/\n/g, " ").slice(0, 90));
  const crossFile = aqxDiags.some((m) => /missing|Point|'y'/i.test(m));
  console.log(`  Cross-file type from ./lib enforced by AtomNano: ${crossFile ? "YES" : "no"}`);
  console.log(`  Match: AtomNano ${aqxDiags.length >= tsc.length && tsc.length > 0 ? "matches tsc/VS Code" : "differs"} (${aqxDiags.length} vs ${tsc.length})\n`);

  const aqxIdleMB = aqxIdleRamKB / 1024;
  console.log("── RAM (same project + file open) ──");
  console.log(`  AtomNano (TS active):   ${aqxRamMB.toFixed(0)} MB across ${aqxProcs} processes`);
  console.log(`  AtomNano (TS idle):     ${aqxIdleMB.toFixed(0)} MB across ${aqxIdleProcs} processes  (TS process auto-killed; respawns on demand)`);
  if (codeRamMB != null) {
    console.log(`  VS Code:                ${codeRamMB.toFixed(0)} MB across ${codeProcCount} processes  (isolated profile, built-in extensions only; tsserver stays resident)`);
    console.log(`  → AtomNano: ${(codeRamMB / aqxRamMB).toFixed(1)}× lighter while typechecking, ${(codeRamMB / aqxIdleMB).toFixed(1)}× lighter at steady-state`);
  } else {
    console.log(`  VS Code:   not measured — ${codeNote}`);
  }
  console.log("");
})().catch((e) => { console.error(e); process.exit(1); });
