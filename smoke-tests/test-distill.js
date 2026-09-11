/* Local pre-mind (distill.js) — the on-device, zero-cost context distiller.
 * Pure-Node test (no Electron): proves the engine extracts the relevant slice
 * and strips the rest for the two canonical cases — "use the same design system"
 * and "fix the button glitch" — plus CSS-only and multi-file (worker) paths.
 */
"use strict";
const distill = require("../src/main/distill.js");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

const HTML = `<!doctype html><html><head>
<style>
  :root { --brand: #4f46e5; --radius: 8px; --space: 12px; }
  body { font-family: Inter, sans-serif; }
  .btn { background: var(--brand); border-radius: var(--radius); padding: 10px 18px; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  .btn:hover { opacity: .9; }
  .card { padding: var(--space); }
  .footer-note { color: #888; }
</style>
<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments);}gtag('config','UA-ANALYTICS');</script>
</head><body>
<header class="site-header"><nav class="navbar">nav ${"x".repeat(3000)}</nav></header>
<main>
  <div class="card">Hello</div>
  <button class="btn" id="cta" onclick="onCta()">Click me</button>
  <p class="footer-note">${"filler ".repeat(800)}</p>
</main>
<script>
function onCta(){ const b = document.getElementById('cta'); b.classList.add('loading'); doUnrelatedThing(); }
function doUnrelatedThing(){ for(let i=0;i<100;i++){ console.log('noise', i); } }
document.querySelector('.btn').addEventListener('click', () => console.log('btn clicked'));
</script>
</body></html>`;

(async () => {
  /* ---------- design-system ---------- */
  const ds = await distill.analyze({ prompt: "use the same design system for a new pricing page", files: [{ name: "page.html", content: HTML }], parallel: false });
  ok(ds.intent === "design-system", `classified as design-system (${ds.intent})`);
  ok(/--brand: #4f46e5/.test(ds.context) && /Inter/.test(ds.context), "kept the design tokens (brand var + font)");
  ok(!/dataLayer/.test(ds.context) && !/lots of nav|filler filler/.test(ds.context), "stripped analytics JS + filler");
  ok(ds.strippedBytes > 3000, `stripped the bulk locally (${Math.round(ds.strippedBytes / 1024)} KB)`);

  /* ---------- bugfix: "fix the button glitch" ---------- */
  const bug = await distill.analyze({ prompt: "fix the button glitch", files: [{ name: "page.html", content: HTML }], parallel: false });
  ok(bug.intent === "bugfix" && bug.entities.includes("button"), `classified bugfix + entity button (${bug.entities})`);
  ok(/<button class="btn"/.test(bug.context), "kept the button markup");
  ok(/\.btn\s*\{/.test(bug.context), "kept the .btn CSS rule (via harvested class)");
  ok(/function onCta/.test(bug.context), "kept the onCta handler (via harvested inline handler)");
  ok(!/doUnrelatedThing\(\)\s*\{[^]*console\.log\('noise'/.test(bug.context), "dropped the unrelated function body");
  ok(!/dataLayer/.test(bug.context) && !/footer-note/.test(bug.context.replace(/<button[^]*?<\/button>/g, "")), "dropped analytics + unrelated markup");

  /* ---------- CSS-only ---------- */
  const css = await distill.analyze({ prompt: "match the colour palette", files: [{ name: "theme.css", content: ":root{--p:#abcdef}\n.x{color:#abcdef}\n.btn{border-radius:6px}" }], parallel: false });
  ok(/--p: #abcdef/.test(css.context), "CSS-only: extracted design tokens");

  /* ---------- multi-file (parallel worker threads = multicore) ---------- */
  const multi = await distill.analyze({ prompt: "fix the button", files: [{ name: "a.html", content: HTML }, { name: "b.css", content: ".btn{color:red}\n.btn:hover{color:blue}" }], parallel: true });
  ok(multi.files.length === 2, `multi-file distilled across worker threads (${multi.files.length})`);
  ok(/color:red/.test(multi.context), "the second file's relevant CSS is included");

  /* ---------- classify sanity ---------- */
  ok(distill.classify("refactor the navbar").kind === "refactor", "classify: refactor");
  ok(distill.classify("explain how the search works").kind === "explain", "classify: explain");

  console.log(process.exitCode ? "\nSOME DISTILL TESTS FAILED" : "\nALL DISTILL TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
