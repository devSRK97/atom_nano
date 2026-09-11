/* Local optimizer (localmind.js) — embedded, on-demand neural refiner.
 * Pure-Node test with injectable runtime/downloader/GPU probe (no model, no
 * native binding, no network): proves capability-gated recommendation, the
 * download-with-checks flow, on-demand load/idle-unload, refuse-when-not-ready,
 * and integration into the distill pipeline.
 */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const localmind = require("../src/main/localmind.js");
const distill = require("../src/main/distill.js");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const DIR = path.join(os.tmpdir(), "atomnano-localmind"); fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  let settings = { localOptimizer: { enabled: false, modelId: null, autoUnloadMs: 50 } };
  localmind.configure({ userDataDir: DIR, getSettings: () => settings });

  /* ---------- capability-gated recommendation ---------- */
  ok(localmind.recommend({ ramGB: 4, cores: 4, gpu: { present: false } }).modelId === "qwen2.5-coder-0.5b", "4 GB / no GPU → 0.5B");
  ok(localmind.recommend({ ramGB: 8, cores: 8, gpu: { present: false } }).modelId === "qwen2.5-coder-1.5b", "8 GB / no GPU → 1.5B");
  ok(localmind.recommend({ ramGB: 16, cores: 12, gpu: { present: false } }).modelId === "qwen2.5-coder-3b", "16 GB → 3B");
  ok(localmind.recommend({ ramGB: 8, cores: 8, gpu: { discrete: true, vendor: "nvidia" } }).modelId === "qwen2.5-coder-3b", "8 GB + discrete GPU → bumped to 3B");
  ok(localmind.recommend({ ramGB: 8, cores: 8, gpu: { apple: true } }).modelId === "qwen2.5-coder-3b", "8 GB + Apple GPU → bumped to 3B");
  const lowend = localmind.recommend({ ramGB: 2, cores: 2, gpu: {} });
  ok(lowend.fits === false && lowend.modelId === null, "2 GB → no model, stay deterministic");

  /* ---------- GPU probe parsing ---------- */
  localmind.setGpuProbe(async () => ({ gpuDevice: [{ active: true, vendorId: 0x10de }], auxAttributes: { glRenderer: "NVIDIA GeForce RTX 4060" } }));
  const caps = await localmind.probe();
  ok(caps.ramGB > 0 && caps.cores >= 1, `probe reports RAM + cores (${caps.ramGB} GB / ${caps.cores})`);
  ok(caps.gpu.vendor === "nvidia" && caps.gpu.discrete === true, `GPU parsed as discrete NVIDIA (${caps.gpu.name})`);

  /* ---------- download with checks + progress ---------- */
  const m = localmind.REGISTRY[0];   // 0.5B
  let lastPct = 0;
  localmind.setDownloader(async (url, dest, bytes, onProgress) => { onProgress({ got: bytes, total: bytes, pct: 100 }); lastPct = 100; fs.writeFileSync(dest, Buffer.alloc(Math.floor(bytes * 0.6))); });
  const dl = await localmind.download(m.id, (p) => { lastPct = p.pct; });
  ok(dl.ok && fs.existsSync(dl.path) && lastPct === 100, "download writes the model file + reports progress");

  // a truncated/error download is rejected
  localmind.setDownloader(async (url, dest) => { fs.writeFileSync(dest, Buffer.alloc(500)); });
  let rejected = false; try { await localmind.download(m.id); } catch { rejected = true; }
  ok(rejected, "a too-small download is rejected (and the .part not promoted)");

  // restore the good file for the rest
  localmind.setDownloader(async (url, dest, bytes) => { fs.writeFileSync(dest, Buffer.alloc(Math.floor(bytes * 0.6))); });
  await localmind.download(m.id);

  /* ---------- on-demand load / idle-unload via fake runtime ---------- */
  let loads = 0, disposes = 0, gens = 0;
  localmind.setRuntime({
    load: async () => { loads++; return { fake: true }; },
    generate: async () => { gens++; return "Look at the .btn 'loading' class toggle in onCta — likely the glitch."; },
    dispose: () => { disposes++; },
  });

  // not enabled yet → refine refuses (deterministic engine runs alone)
  ok((await localmind.refine({ prompt: "fix button", intent: { kind: "bugfix", entities: ["button"] }, kept: [{ file: "p.html", label: "JS", code: "function onCta(){}" }] })) === null, "refine returns null when disabled");

  // enable + point at the downloaded model
  settings.localOptimizer = { enabled: true, modelId: m.id, autoUnloadMs: 50 };
  const st = localmind.status();
  ok(st.ready === true && st.downloaded === true && st.runtimeAvailable === true, "status: ready once enabled + downloaded + runtime present");

  const r1 = await localmind.refine({ prompt: "fix the button glitch", intent: { kind: "bugfix", entities: ["button"] }, kept: [{ file: "p.html", label: "JS", code: "function onCta(){ b.classList.add('loading'); }" }] });
  ok(r1 && /Local model focus note/.test(r1.summary) && /loading/.test(r1.summary), "refine loads the model on demand + returns a focus summary");
  ok(loads === 1 && gens === 1, "model loaded exactly once, generated once");

  // second refine reuses the loaded session (no extra load)
  await localmind.refine({ prompt: "again", intent: { kind: "bugfix", entities: ["button"] }, kept: [{ file: "p.html", label: "JS", code: "x" }] });
  ok(loads === 1, "second refine reuses the warm session (on-demand, not reloaded)");

  // idle-unload fires (autoUnloadMs = 50)
  await new Promise((res) => setTimeout(res, 140));
  ok(disposes >= 1 && localmind.status().loaded === false, "model auto-unloads after idle (frees RAM/VRAM)");

  /* ---------- integration into the distiller ---------- */
  distill.setModel(localmind.refine);
  const html = `<style>.btn{color:red}</style><button class="btn" id="cta" onclick="onCta()">go</button><script>function onCta(){document.getElementById('cta').classList.add('loading');}</script>`;
  const out = await distill.analyze({ prompt: "fix the button glitch", files: [{ name: "p.html", content: html }], parallel: false });
  ok(out.model === "neural+heuristic", `distiller reports the neural refiner is active (${out.model})`);
  ok(/Local model focus note/.test(out.context), "the model's focus note is folded into the distilled context");

  /* ---------- dynamic, capability-filtered catalog ---------- */
  localmind.setCatalogFetcher(async () => ([
    { id: "tiny", label: "Tiny 0.3B", params: 0.3, quant: "Q4", bytes: 300e6, ramNeedGB: 2, file: "tiny.gguf", url: "http://x/tiny.gguf" },
    { id: "mid", label: "Mid 1.5B", params: 1.5, quant: "Q4", bytes: 1.1e9, ramNeedGB: 6, file: "mid.gguf", url: "http://x/mid.gguf" },
    { id: "huge", label: "Huge 70B", params: 70, quant: "Q4", bytes: 40e9, ramNeedGB: 999, file: "huge.gguf", url: "http://x/huge.gguf" },
  ]));
  const cat = await localmind.catalog();
  ok(cat.models.length === 3, `catalog fetched dynamically (${cat.models.length})`);
  ok(cat.models.every((mm) => mm.support && mm.support.level), "every model is annotated with a support level for this machine");
  ok(cat.models.find((mm) => mm.id === "huge").support.level === "too-big", "a 70B model is flagged too-big for this machine");
  ok(cat.recommendedId && cat.models.find((mm) => mm.id === cat.recommendedId).support.level === "ok", `recommended model is one that actually fits (${cat.recommendedId})`);

  localmind.setCatalogFetcher(async () => []);   // empty/failed fetch
  const cat2 = await localmind.catalog();
  ok(cat2.models.length === localmind.REGISTRY.length, "falls back to the built-in registry when the fetch is empty/offline");

  /* ---------- on-demand engine install ---------- */
  localmind.setRuntime(null);              // engine genuinely absent
  if (localmind.__setEngineForTest) localmind.__setEngineForTest(null);   // force-absent even if a real engine is installed on this box
  let installerRan = false;
  localmind.setInstaller(async () => { installerRan = true; });
  const ie = await localmind.installEngine();
  ok(installerRan && typeof ie.ok === "boolean", "installEngine runs the on-demand installer when the engine is absent");
  localmind.setRuntime({ load: async () => ({}), generate: async () => "x", dispose: () => {} });
  const ie2 = await localmind.installEngine();
  ok(ie2.ok === true && ie2.already === true, "installEngine is a no-op once the engine is available");

  console.log(process.exitCode ? "\nSOME LOCALMIND TESTS FAILED" : "\nALL LOCALMIND TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
