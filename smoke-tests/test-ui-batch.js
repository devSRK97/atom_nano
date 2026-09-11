/* UI test for the latest batch:
 *  - Settings categories (Connection/Appearance/Agent/Editor/Storage) + new controls
 *  - Resend toggle → resend buttons appear under user messages
 *  - Markdown table renders in chat
 *  - Theme-aware checkboxes (no white box)
 *  - Icon footer buttons stay on one line
 *  - Close confirmation uses the in-app modal (no native box, no "don't ask")
 *  - Folder context menu has "Open Terminal here"
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && !!window.atomnano.sessions, null, { timeout: 15000 });

  // ---------- Settings categories + controls ----------
  await win.evaluate(() => { const b = [...document.querySelectorAll("#sidebarFooter .foot-btn")].find((x) => /Settings/i.test(x.textContent)); b.click(); });
  await win.waitForTimeout(450);
  const settings = await win.evaluate(() => {
    const sections = [...document.querySelectorAll(".set-section")].map((s) => s.textContent.trim());
    const labels = [...document.querySelectorAll(".field label")].map((l) => l.textContent.trim());
    return {
      sections,
      hasEditorFontStyle: labels.includes("Editor font style"),
      hasEditorFontSize: labels.includes("Editor font size"),
      hasStepper: !!document.querySelector(".stepper .step-val"),
      hasResend: labels.includes("Resend button on my messages"),
      hasZoom: labels.some((l) => /Interface size/i.test(l)),
    };
  });
  for (const s of ["CONNECTION", "APPEARANCE", "AGENT", "EDITOR"]) {
    ok(settings.sections.some((x) => x.toUpperCase().includes(s)), `settings has “${s}” section`);
  }
  ok(settings.hasEditorFontStyle, "Editor: font style control present");
  ok(settings.hasEditorFontSize && settings.hasStepper, "Editor: font size stepper present");
  ok(settings.hasResend, "Agent: resend toggle present");
  ok(settings.hasZoom, "Agent: interface size / zoom present");

  // Enable the resend toggle.
  const enabled = await win.evaluate(() => {
    const label = [...document.querySelectorAll(".field label")].find((l) => l.textContent.trim() === "Resend button on my messages");
    if (!label) return false;
    const seg = label.parentElement.querySelector(".segmented");
    const on = [...seg.querySelectorAll("button")].find((b) => /^On$/i.test(b.textContent.trim()));
    on.click();
    return true;
  });
  ok(enabled, "resend toggle switched On");
  // Confirm persisted to settings.
  const persisted = await win.evaluate(() => window.atomnano.settings.get().then((s) => s.resendButton));
  ok(persisted === true, "resendButton persisted to settings");

  // close settings
  await win.evaluate(() => { const b = [...document.querySelectorAll(".modal-foot button")].find((x) => x.textContent.trim() === "Done"); if (b) b.click(); });
  await win.waitForTimeout(250);

  // ---------- seed a session with a user msg + an assistant table ----------
  const sid = await win.evaluate(async () => {
    const v = await window.atomnano.sessions.create({ name: "Table Demo" });
    const md = "Here is a table:\n\n| Directory | Stack | Port |\n|---|---|---|\n| atomqx/ | React | 5174 |\n| aqx-backend/ | Fastify | 3800 |\n\nDone.";
    await window.atomnano.sessions.update(v.id, { messages: [
      { id: "u1", role: "user", text: "show me the table", ts: new Date().toISOString() },
      { id: "a1", role: "assistant", text: md, ts: new Date().toISOString() },
    ] });
    return v.id;
  });

  // Open it from History.
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(350);
  await win.evaluate(() => { const seg = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (seg) seg.click(); });
  await win.waitForTimeout(200);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".change-row")].find((r) => (r.querySelector(".change-name") || {}).textContent === "Table Demo");
    const btn = [...row.querySelectorAll("button")].find((b) => /^(Open|Switch)$/.test(b.textContent.trim()));
    btn.click();
  });
  await win.waitForTimeout(500);

  const chat = await win.evaluate(() => ({
    hasTable: !!document.querySelector(".bubble .md-table"),
    headerCells: [...document.querySelectorAll(".md-table thead th")].map((t) => t.textContent.trim()),
    cell: !!([...document.querySelectorAll(".md-table td")].find((t) => t.textContent.trim() === "5174")),
    resendBtns: document.querySelectorAll(".msg.user .msg-resend").length,
  }));
  ok(chat.hasTable, "chat renders a markdown table");
  ok(chat.headerCells.join(",") === "Directory,Stack,Port", "table header cells correct");
  ok(chat.cell, "table body cell (5174) rendered");
  ok(chat.resendBtns >= 1, `resend button shows under user message (${chat.resendBtns})`);

  // ---------- checkbox is theme-aware (open History again) ----------
  await win.locator('[title^="History"]').first().click();
  await win.waitForTimeout(300);
  await win.evaluate(() => { const seg = [...document.querySelectorAll(".segmented button")].find((b) => /All projects/i.test(b.textContent)); if (seg) seg.click(); });
  await win.waitForTimeout(200);
  const cb = await win.evaluate(() => {
    const c = document.querySelector(".hist-check");
    if (!c) return null;
    const cs = getComputedStyle(c);
    return { appearance: cs.appearance || cs.webkitAppearance, bg: cs.backgroundColor };
  });
  ok(cb && cb.appearance === "none", "checkbox uses custom appearance (not native white box)");
  ok(cb && cb.bg !== "rgb(255, 255, 255)" && cb.bg !== "rgba(0, 0, 0, 0)", `checkbox background is theme-shaded (${cb && cb.bg})`);

  // ---------- footer icon buttons stay on one line ----------
  const btnLines = await win.evaluate(() => {
    const imp = [...document.querySelectorAll(".modal-foot button")].find((b) => /Import/i.test(b.textContent));
    if (!imp) return null;
    return { h: imp.getBoundingClientRect().height };
  });
  ok(btnLines && btnLines.h < 44, `Import button stays single-line (h=${btnLines && Math.round(btnLines.h)}px)`);

  // close history
  await win.evaluate(() => { const b = [...document.querySelectorAll(".modal-foot button")].find((x) => x.textContent.trim() === "Done"); if (b) b.click(); });
  await win.waitForTimeout(200);

  // ---------- close-confirm uses in-app modal ----------
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.send("app:confirm-close", { running: 2 });
  });
  await win.waitForTimeout(350);
  const closeModal = await win.evaluate(() => {
    const heads = [...document.querySelectorAll(".modal-head")].map((m) => m.textContent.trim());
    const btns = [...document.querySelectorAll(".modal-foot button")].map((b) => b.textContent.trim());
    const text = (document.querySelector(".modal") || {}).textContent || "";
    const closeBtn = [...document.querySelectorAll(".modal-foot button")].find((b) => /Close AtomNano/i.test(b.textContent));
    return {
      hasCloseTitle: heads.some((t) => /Close AtomNano/i.test(t)),
      hasCloseBtn: btns.some((t) => /Close AtomNano/i.test(t)),
      hasCancel: btns.some((t) => /Cancel/i.test(t)),
      mentionsRunning: /still running/i.test(text),
      hasDontAsk: /don.?t ask/i.test(text),
      closeBtnPrimary: !!(closeBtn && closeBtn.classList.contains("btn-primary") && !closeBtn.classList.contains("btn-danger")),
    };
  });
  ok(closeModal.hasCloseTitle && closeModal.hasCloseBtn, "close-confirm shows in-app modal with Close AtomNano");
  ok(closeModal.hasCancel, "close-confirm has Cancel");
  ok(closeModal.mentionsRunning, "close-confirm mentions running sessions (running=2)");
  ok(!closeModal.hasDontAsk, "close-confirm has NO 'Don't ask again' checkbox");
  ok(closeModal.closeBtnPrimary, "close-confirm button uses the accent primary style (consistent, not washed-out red)");
  // cancel it
  await win.evaluate(() => { const b = [...document.querySelectorAll(".modal-foot button")].find((x) => /Cancel/i.test(x.textContent)); if (b) b.click(); });
  await win.waitForTimeout(200);

  // ---------- folder context menu has Open Terminal ----------
  await win.waitForFunction(() => document.querySelector(".tree-row.is-dir"), null, { timeout: 8000 }).catch(() => {});
  const hasDir = await win.evaluate(() => {
    const dir = document.querySelector(".tree-row.is-dir");
    if (!dir) return false;
    const r = dir.getBoundingClientRect();
    dir.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 10, clientY: r.top + 5 }));
    return true;
  });
  await win.waitForTimeout(300);   // fileContextMenu awaits the .git check before showing
  const termItem = await win.evaluate(() => {
    const items = [...document.querySelectorAll("#ctxMenu .ctx-item")].map((i) => i.textContent.trim());
    return { items, hasTerm: items.some((t) => /Open Terminal/i.test(t)) };
  });
  if (!hasDir) console.log("NOTE: no directory in tree to test terminal menu");
  else ok(termItem.hasTerm, `folder context menu has “Open Terminal here” (${JSON.stringify(termItem.items)})`);

  await app.close();
  console.log(process.exitCode ? "\nSOME UI TESTS FAILED" : "\nALL UI TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
