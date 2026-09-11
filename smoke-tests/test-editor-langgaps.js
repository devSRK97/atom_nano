/* Language-intelligence gap probes:
 * 1. setTimeout/console/fetch globals must NOT be "not defined" (no tsconfig + with tsconfig)
 * 2. member completions after a dot (typed string member + object literal member)
 * 3. tsconfig `paths` aliases (@/...) — diagnostics resolve + go-to-def + completions
 * 4. auto-import suggestion from a sibling file
 * 5. completions still appear when the variable is implicitly `any` (word fallback)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-langgaps");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
const P = (...n) => path.join(DIR, ...n).replace(/\\/g, "/");

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  // Project A: NO tsconfig at all (plain folder)
  fs.mkdirSync(path.join(DIR, "plain"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "plain", "timers.ts"),
    "const t = setTimeout(() => console.log(\"x\"), 100);\nclearTimeout(t);\nconst s = \"hello\";\nconst up = s.toUpperCase();\nexport { up };\n");
  // Project B: tsconfig WITH baseUrl + paths alias  @/* -> src/*
  fs.mkdirSync(path.join(DIR, "aliased", "src", "utils"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "aliased", "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler", noEmit: true, baseUrl: ".", paths: { "@/*": ["src/*"] } },
    include: ["src"],
  }, null, 2));
  fs.writeFileSync(path.join(DIR, "aliased", "src", "utils", "math.ts"),
    "export function double(n: number) { return n * 2; }\nexport const MAGIC = 42;\n");
  fs.writeFileSync(path.join(DIR, "aliased", "src", "main.ts"),
    'import { double } from "@/utils/math";\n' +
    "const user = { name: \"jo\", age: 3 };\n" +
    "const r = double(user.age);\n" +
    "let loose;\nloose = { username: \"x\" };\n" +
    "export { r };\n");

  const udir = path.join(os.tmpdir(), "atomnano-langgaps-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function" && typeof window.__cm === "function", null, { timeout: 15000 });

  /* ---------- 1) globals in a no-tsconfig project ---------- */
  await win.evaluate((p) => window.__setProject(p), P("plain"));
  await win.evaluate((p) => window.__openInEditor(p), P("plain", "timers.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 10000 });
  await win.waitForTimeout(3500);   // let semantic lint run fully
  let diags = await win.evaluate(() => window.__cm().diagnosticsDetailed());
  const undef = diags.filter((d) => /Cannot find name/i.test(d.message));
  ok(undef.length === 0, `no "Cannot find name" for setTimeout/console/clearTimeout (${undef.length}: ${JSON.stringify(undef.map((d) => d.message.slice(0, 40)))})`);

  /* ---------- 2) member completions after a dot (typed object) ---------- */
  await win.evaluate((p) => window.__setProject(p), P("aliased"));
  await win.evaluate((p) => window.__openInEditor(p), P("aliased", "src", "main.ts"));
  await win.waitForTimeout(2500);
  const comp = await win.evaluate(() => {
    const cm = window.__cm();
    const i = cm.docText().indexOf("user.age");
    return cm.requestTs("completions", { pos: i + 5 });   // right after "user."
  });
  const names = ((comp && comp.entries) || []).map((e) => e.name);
  ok(names.includes("name") && names.includes("age"), `dot-completions list object members (${JSON.stringify(names.slice(0, 6))})`);

  /* ---------- 3) @/ paths alias: no unresolved-module error + gotodef ---------- */
  diags = await win.evaluate(() => window.__cm().diagnosticsDetailed());
  const modErr = diags.filter((d) => /Cannot find module/i.test(d.message));
  ok(modErr.length === 0, `"@/utils/math" import resolves via tsconfig paths (${modErr.length} module errors)`);
  // go-to-def on the alias import string should open math.ts
  await win.evaluate(() => { const cm = window.__cm(); const i = cm.docText().indexOf("@/utils/math") + 4; window.__gotoDef(i); });
  await win.waitForTimeout(1800);
  const after = await win.evaluate(() => window.__editorState().path);
  ok(/math\.ts$/.test(after), `ctrl+click on "@/utils/math" opened the aliased file (got ${after.split(/[\\/]/).pop()})`);

  /* ---------- 4) symbol from aliased module: gotodef on usage ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("aliased", "src", "main.ts"));
  await win.waitForTimeout(500);
  await win.evaluate(() => { const cm = window.__cm(); const i = cm.docText().indexOf("double(user") + 2; window.__gotoDef(i); });
  await win.waitForTimeout(1800);
  const after2 = await win.evaluate(() => window.__editorState().path);
  ok(/math\.ts$/.test(after2), `go-to-def on double() crossed the @/ alias (got ${after2.split(/[\\/]/).pop()})`);

  /* ---------- 5) completions when receiver is implicitly any (word fallback) ---------- */
  await win.evaluate((p) => window.__openInEditor(p), P("aliased", "src", "main.ts"));
  await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 });
  await win.waitForTimeout(600);
  // type "loose." at the end — `loose` is implicitly any → TS returns nothing; the
  // editor should still offer SOMETHING (word-based fallback), like VS Code does.
  await win.click(".cm-content");
  await win.keyboard.press("Control+End");
  await win.keyboard.press("Enter");
  await win.keyboard.type("loose.");
  await win.waitForTimeout(900);
  const popupCount = await win.evaluate(() => document.querySelectorAll(".cm-tooltip-autocomplete .cm-completionLabel").length);
  ok(popupCount > 0, `completion popup appears even on an \`any\` receiver (${popupCount} options)`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME LANG-GAP TESTS FAILED" : "\nALL LANG-GAP TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
