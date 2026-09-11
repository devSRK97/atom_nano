/* Go-to-definition on a real CRLF file selects EXACTLY the identifier (no drift).
 * CodeMirror 6 normalises to LF, so doc offsets stay consistent. Skips if the
 * machine-specific sample file isn't present. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const FILE = "D:/CognitoAITesting/Cognitoproject/cognito_ai_api/Models/TestAutomationModule/TcaTestcasesDemoModels.js";
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__openInEditor === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__openInEditor(p), FILE);
  const loaded = await win.waitForSelector(".cm-editor .cm-content", { timeout: 8000 }).then(() => true).catch(() => false);
  await win.waitForTimeout(400);
  const hasDoc = loaded && await win.evaluate(() => window.__cm() && window.__cm().docText().length > 100);
  if (!hasDoc) { console.log("SKIP: file not loaded"); await app.close(); console.log("\nCRLF GOTODEF SKIPPED"); return; }

  // Ctrl+click the function name in the module.exports block (1st occurrence)
  const word = "fetchRecordsFrom_tca_testcases_demo";
  await win.evaluate((w) => { const doc = window.__cm().docText(); window.__gotoDef(doc.indexOf(w) + 5); }, word);
  await win.waitForTimeout(400);
  const r = await win.evaluate(() => {
    const s = window.__cm().selection();
    const line = window.__cm().lineOf(s.from);
    const lr = window.__cm().lineRangeAt(s.from);
    return { selText: s.text, line, lineText: lr.text };
  });
  ok(r.selText === word, `selected EXACTLY the function name, no spaces/extra ("${r.selText}")`);
  ok(/^function\s/.test(r.lineText.trim()), `landed on the 'function …' definition line (line ${r.line}: "${r.lineText.trim().slice(0, 40)}")`);

  await app.close();
  console.log(process.exitCode ? "\nCRLF GOTODEF FAILED" : "\nCRLF GOTODEF PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
