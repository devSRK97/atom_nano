"use strict";
/* Renderer module-graph check: serve src/renderer over a local HTTP socket and load the entry
 * module in headless Chromium with the IPC bridge stubbed. Fails on anything that breaks the
 * module GRAPH — a syntax error, an import of a name a module does not export, a binding read
 * before its module initialised (a cycle hazard), a missing file. Errors that come from the
 * stubbed bridge afterwards are only listed.  node scripts/check-renderer.js */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const RDIR = path.join(ROOT, "src", "renderer");
const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const GRAPH_ERROR = /SyntaxError|does not provide an export named|before initialization|Unexpected token|Failed to fetch dynamically imported|Failed to load module script|Importing binding name|Cannot use import statement|Identifier .* has already been declared|Unexpected identifier|has already been declared/i;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = url === "/" || url === "/index.html" ? null : path.join(RDIR, url);
  if (!file) {   // the app shell with the IPC bridge stubbed, then the real entry module
    const stylesDir = path.join(RDIR, "styles");
    const links = fs.existsSync(stylesDir) ? fs.readdirSync(stylesDir).filter((f) => f.endsWith(".css")).sort().map((f) => `<link rel="stylesheet" href="/styles/${f}">`).join("") : '<link rel="stylesheet" href="/styles.css">';
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><head><meta charset="utf-8">${links}</head><body>
<div id="app"><header id="titlebar"><div class="tb-left"><span id="brandMark"></span><div id="tbActions"></div></div><div class="tb-right"><button id="winMin"></button><button id="winMax"></button><button id="winClose"></button></div></header>
<div id="body"><aside id="sidebar"><div id="folderBar"></div><div id="fileTree"></div><div id="sidebarFooter"></div></aside><div id="sidebarResizer"></div><section id="editorPane" class="hidden"><div id="editorTabs"></div><div id="editorBreadcrumbs" class="hidden"></div><div id="editorBody"></div><div id="editorStatus"></div></section><div id="editorResizer" class="hidden"></div>
<main id="main"><div id="chatHeader"><div id="tabs"></div><button id="tabOverflow" class="hidden"></button><div class="cht-actions"><div id="headerProvider"></div><button id="chatSearchBtn"></button><button id="newTab"></button><button id="chatMore"></button></div></div><div id="chatWrap"><div id="chat"></div></div><div id="composer"></div></main>
<div id="changesResizer" class="hidden"></div><aside id="changesPanel" class="hidden"></aside><aside id="fleetPanel" class="side-dock hidden"></aside><aside id="testsPanel" class="side-dock hidden"></aside><aside id="agentsPanel" class="side-dock hidden"></aside><aside id="boardPanel" class="side-dock hidden"></aside></div></div>
<div id="ctxMenu" class="hidden"></div><div id="modalRoot"></div><div id="toast" class="hidden"></div>
<script>
  // A stub bridge: every call resolves to a plausible empty value so init() runs as far as it can.
  const val = (k) => (/^on[A-Z]/.test(k) ? () => () => {} : (...a) => Promise.resolve(k === "list" ? [] : k === "get" && a.length === 0 ? {} : k === "create" || k === "get" ? { id: "s1", name: "s", cwd: "C:/p", messages: [], editedFiles: [], status: "idle", totalMessages: 0, firstIndex: 0 } : k === "project" ? "C:/p" : k === "info" ? { platform: "win32", version: "check" } : k === "catalog" ? null : k === "status" ? { loggedIn: false } : null));
  const ns = () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : val(String(k))) });
  window.atomnano = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : ns()) });
</script>
<script type="module" src="/app.js"></script></body></html>`);
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + url); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [], missing = [];
  // e.stack keeps the "SyntaxError:" prefix a module parse failure is reported with (e.message drops it)
  page.on("pageerror", (e) => errors.push(String((e && (e.stack || e.message)) || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("response", (r) => { if (r.status() === 404) missing.push(r.url()); });
  // a module that fails to PARSE never reaches pageerror with a location — the debugger names it
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Debugger.enable");
  cdp.on("Debugger.scriptFailedToParse", (ev) => errors.push(`SyntaxError: module failed to parse: ${String(ev.url || "").replace(/^http:\/\/[^/]+/, "")}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const graph = errors.filter((e) => GRAPH_ERROR.test(e));
  const modulesLoaded = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => /\.js(\?|$)/.test(r.name)).length);
  await browser.close(); server.close();
  console.log(`modules fetched: ${modulesLoaded}; page errors: ${errors.length}; 404s: ${missing.length}`);
  for (const m of missing) console.log("  404", m.replace(/^http:\/\/[^/]+/, ""));
  for (const e of errors) {
    const lines = e.split("\n");
    const frame = (lines.find((l, i) => i > 0 && /^\s+at /.test(l)) || "").trim().replace(/http:\/\/[^/]+/, "");
    console.log((GRAPH_ERROR.test(e) ? "  GRAPH  " : "  info   ") + lines[0].slice(0, 220) + (frame ? `   ← ${frame.slice(0, 140)}` : ""));
  }
  if (graph.length || missing.length) { console.log("\nrenderer module graph: FAIL"); process.exit(1); }
  console.log("\nrenderer module graph: ok");
})().catch((e) => { console.error(e); process.exit(2); });
