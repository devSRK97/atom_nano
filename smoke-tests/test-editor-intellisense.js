/* IntelliSense from the project-wide TypeScript service: completion (members +
 * cross-file), hover, signature help, go-to-definition, quick-fixes, rename, and
 * format. Drives the editor's requestTs hook + formatDoc through the real app. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-intel");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "src"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["src"] }));
  fs.writeFileSync(path.join(DIR, "src", "lib.ts"), "export interface Point { x: number; y: number; }\nexport function add(a: number, b: number): number { return a + b; }\n");
  const MAIN = path.join(DIR, "src", "main.ts");
  const mainSrc = [
    'import { add, Point } from "./lib";',
    "const p: Point = { x: 1, y: 2 };",
    "const mx = p.x;",
    "const total = add(1, 2);",
    "const z: nuber = 1;",
    "export { p, mx, total, z };",
    "",
  ].join("\n");
  fs.writeFileSync(MAIN, mainSrc);
  fs.writeFileSync(path.join(DIR, "src", "messy.ts"), "const o={a:1,b:2}   ;\nfunction f(a:number,b:number){return a+b}\nexport {o,f};\n");

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate((p) => window.__openInEditor(p), MAIN.replace(/\\/g, "/"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(400);

  const req = (kind, payload) => win.evaluate((a) => window.__cm().requestTs(a.kind, a.payload), { kind, payload });
  const at = (needle, off = 0) => mainSrc.indexOf(needle) + off;

  // warm up the TS program (first call loads tsconfig + libs + lib.ts)
  for (let i = 0; i < 40; i++) { const h = await req("hover", { pos: at("add(1") + 1 }); if (h && h.display) break; await win.waitForTimeout(200); }

  // 1) completion — members of an imported cross-file type
  const memberPos = at("p.x") + 2;   // right after the dot
  const comp = await req("completions", { pos: memberPos });
  const names = comp && comp.entries ? comp.entries.map((e) => e.name) : [];
  ok(comp && comp.isMember, "member completion is recognised after '.'");
  ok(names.includes("x") && names.includes("y"), `members of imported type Point completed (${names.slice(0, 6).join(",")})`);

  // 2) hover — type signature
  const hov = await req("hover", { pos: at("add(1") + 1 });
  ok(hov && /add\(a: number, b: number\): number/.test(hov.display), `hover shows the real signature ("${(hov && hov.display || "").replace(/\n/g, " ")}")`);

  // 3) signature help — parameter hints inside the call
  const sig = await req("signature", { pos: at("add(1") + 4 });
  ok(sig && /a: number/.test(sig.label) && Array.isArray(sig.params) && sig.params.length === 2, `signature help lists parameters ("${sig && sig.label}")`);

  // 4) go-to-definition — cross-file, exact
  const def = await req("definition", { pos: at("add(1") + 1 });
  ok(def && /lib\.ts$/.test(def.file), `definition resolves across files to lib.ts (${def && def.file})`);

  // 5) quick-fixes — spelling fix for 'nuber'
  const fixes = await req("codeFixes", { start: at("nuber"), end: at("nuber") + 5 });
  ok(Array.isArray(fixes) && fixes.some((f) => /number/i.test(f.description)), `quick-fix offered for the typo (${(fixes || []).map((f) => f.description).slice(0, 3).join(" | ")})`);

  // 6) rename — project-wide locations across files
  const ren = await req("rename", { pos: at("add(1") + 1, newName: "sum" });
  const rfiles = ren && ren.files ? Object.keys(ren.files).map((k) => k.replace(/^.*\//, "")) : [];
  ok(ren && rfiles.includes("lib.ts") && rfiles.includes("main.ts"), `rename finds 'add' across files (${rfiles.join(", ")})`);

  // 7) format document
  await win.evaluate((p) => window.__openInEditor(p), path.join(DIR, "src", "messy.ts").replace(/\\/g, "/"));
  await win.waitForTimeout(400);
  const beforeFmt = await win.evaluate(() => window.__cm().getValue());
  await win.evaluate(() => window.__cm().formatDoc());
  await win.waitForTimeout(500);
  const afterFmt = await win.evaluate(() => window.__cm().getValue());
  ok(afterFmt !== beforeFmt && /\{ a: 1, b: 2 \}/.test(afterFmt), `format normalised the file (${JSON.stringify(afterFmt.split("\n")[0])})`);

  ok(errors.length === 0, "no page errors during the IntelliSense flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME INTELLISENSE TESTS FAILED" : "\nALL INTELLISENSE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
