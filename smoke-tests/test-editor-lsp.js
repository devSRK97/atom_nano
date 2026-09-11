/* Per-language LSP: Python via bundled pyright. Verifies that a non-JS/TS
 * language gets real semantic features through the LSP client — diagnostics,
 * hover, completion, signature help, and go-to-definition. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-lsp");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

const SRC = [
  "def add(a: int, b: int) -> int:",
  "    return a + b",
  "",
  "",
  "class Greeter:",
  "    def __init__(self, name: str) -> None:",
  "        self.name = name",
  "",
  "    def greet(self) -> str:",
  '        return "Hi " + self.name',
  "",
  "",
  'g = Greeter("x")',
  'result: int = add("oops", 2)',
  "g.greet()",
  "",
].join("\n");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const MAIN = path.join(DIR, "main.py");
  fs.writeFileSync(MAIN, SRC);

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });

  // an LSP server (pyright) is available for python
  const langs = await win.evaluate(() => window.atomnano.lsp.langs());
  ok(Array.isArray(langs) && langs.includes("py"), `LSP server available for Python (${(langs || []).join(",")})`);

  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate((p) => window.__openInEditor(p), MAIN.replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });

  const req = (kind, payload) => win.evaluate((a) => window.__cm().requestTs(a.kind, a.payload), { kind, payload });
  const at = (needle, off = 0) => SRC.indexOf(needle) + off;

  // warm up pyright (first request spawns + initialises the server)
  for (let i = 0; i < 60; i++) { const h = await req("hover", { pos: at("add(\"oops\"") + 1 }); if (h && h.display) break; await win.waitForTimeout(500); }

  // 1) diagnostics — pyright flags the type error (pushed asynchronously)
  let diags = [];
  for (let i = 0; i < 60 && diags.length === 0; i++) { await win.waitForTimeout(500); diags = await win.evaluate(() => window.__cm().diagnosticsDetailed()); }
  ok(diags.length > 0, `pyright produced diagnostics (${diags.length})`);
  ok(diags.some((d) => /int|str|argument|assigned|"oops"/i.test(d.message)), `type error on add("oops", 2) reported ("${(diags[0] && diags[0].message || "").slice(0, 70)}")`);

  // 2) hover
  const hov = await req("hover", { pos: at("add(\"oops\"") + 1 });
  ok(hov && /add/.test(hov.display) && /int/.test(hov.display + (hov.doc || "")), `hover shows the signature ("${(hov && hov.display || "").replace(/\n/g, " ").slice(0, 60)}")`);

  // 3) completion — members of g (Greeter)
  const comp = await req("completions", { pos: at("g.greet()") + 2 });
  const names = comp && comp.entries ? comp.entries.map((e) => e.name) : [];
  ok(names.includes("greet") && names.includes("name"), `member completion lists Greeter members (${names.slice(0, 8).join(",")})`);

  // 4) signature help
  const sig = await req("signature", { pos: at("add(\"oops\"") + 4 });
  ok(sig && /a: int|int/.test(sig.label) && (sig.params || []).length >= 1, `signature help lists parameters ("${sig && sig.label}")`);

  // 5) go-to-definition (same file: add usage → def on line 1)
  const def = await req("definition", { pos: at("add(\"oops\"") + 1 });
  ok(def && /main\.py$/.test(def.file) && def.line === 1, `definition resolves to the function (line ${def && def.line})`);

  ok(errors.length === 0, "no page errors during the LSP flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME LSP TESTS FAILED" : "\nALL LSP TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
