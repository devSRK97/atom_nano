/* Render a turn with many tool chips and screenshot it to verify spacing. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "chips-spacing.png");

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  await win.evaluate(async () => {
    const v = await window.atomnano.sessions.create({ name: "Chips" });
    const t = (n, tool, input, status = "done") => ({ id: "m" + n, role: "tool", toolName: tool, toolInput: input, status, result: "ok", ts: new Date().toISOString() });
    await window.atomnano.sessions.update(v.id, { messages: [
      { id: "a1", role: "assistant", text: "Tools are fine — the files are named differently than I guessed. Now I have the real map. Let me check server status and read the routing + key flow files.", ts: new Date().toISOString() },
      t(1, "Bash", { command: "echo ':5174 frontend'; curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://localhost:5174" }),
      t(2, "Read", { file_path: "atomqx/src/app/router.tsx" }),
      t(3, "Bash", { command: "cd 'E:/Mac/ATLBS/atomqx_proj'; pwd" }),
      t(4, "Grep", { pattern: "import\\(", path: "atomqx/src/app/router.tsx" }),
      t(5, "Read", { file_path: "start-all.bat" }),
      t(6, "AskUserQuestion", { question: "Which stack?" }),
      t(7, "TaskCreate", { todos: "Bring up full stack" }, "error"),
      t(8, "Bash", { command: "cd aqx-llm-worker && ls .venv/Scripts/" }, "error"),
    ] });
  });

  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(300);
  await win.evaluate(() => { const s = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (s) s.click(); });
  await win.waitForTimeout(200);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".change-row")].find((r) => (r.querySelector(".change-name") || {}).textContent === "Chips");
    const btn = [...row.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim()));
    btn.click();
  });
  await win.waitForTimeout(700);
  await win.locator("#chat").screenshot({ path: OUT });
  console.log("screenshot:", OUT);
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
