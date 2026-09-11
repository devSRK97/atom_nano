/* Image generation: "/image <prompt>" (and the Image button) produce a viewable,
 * downloadable image message. Uses an injected fake backend (no key/network).
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-imagegen");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-imagegen-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = []; win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => window.atomnano.image && window.atomnano.test.imagegenFake && typeof window.__composerSend === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  ok(await win.evaluate(() => !!document.getElementById("imageBtn")), "the Image button is in the composer");

  /* ---------- success: /image <prompt> → an image message ---------- */
  await win.evaluate(() => window.atomnano.test.imagegenFake(false));
  await win.evaluate(() => window.__composerSend("/image a red circle on white"));
  await win.waitForFunction(() => document.querySelector("#chatMessages .msg .img-gen-cap"), null, { timeout: 8000 });
  const card = await win.evaluate(() => {
    const cap = document.querySelector("#chatMessages .img-gen-cap");
    const img = document.querySelector("#chatMessages .img-gen-cap")?.closest(".msg")?.querySelector(".msg-att-img");
    return { caption: cap ? cap.textContent : "", hasImage: !!img, src: img ? img.getAttribute("src") : "" };
  });
  ok(/Generated image/.test(card.caption) && /red circle/.test(card.caption), `image message shows the prompt caption (${card.caption.slice(0, 40)}…)`);
  ok(card.hasImage && /^data:image/.test(card.src), "the generated image renders (data URL)");
  // the user prompt also became a normal message
  ok(await win.evaluate(() => [...document.querySelectorAll("#chatMessages .msg.user")].some((m) => /red circle/.test(m.textContent))), "the prompt was added as a user message");

  /* ---------- natural-language request routes to image gen (no hallucination) ---------- */
  await win.evaluate(() => window.__composerSend("generate cat image"));
  await win.waitForFunction(() => [...document.querySelectorAll("#chatMessages .img-gen-cap")].some((c) => /cat image/.test(c.textContent)), null, { timeout: 8000 });
  ok(true, "natural-language 'generate cat image' routes to the image pipeline");
  // coding requests with the word "image" must NOT route to image gen
  ok(await win.evaluate(() => window.__imgIntent("fix the docker image build") === false), "a coding request ('docker image') does NOT route to image gen");
  ok(await win.evaluate(() => !window.__imgIntent || window.__imgIntent("add an image upload component") === false), "'image upload component' does NOT route to image gen");
  ok(await win.evaluate(() => !window.__imgIntent || window.__imgIntent("draw a logo of a fox") === true), "'draw a logo of a fox' DOES route to image gen");

  /* ---------- KEY-FREE vector (SVG) generation via the text model/CLI ---------- */
  await win.evaluate(() => window.atomnano.test.imagegenFake(false, true));   // fake text runner → returns an <svg>
  await win.evaluate(() => window.__composerSend("/image a friendly robot"));
  await win.waitForFunction(() => [...document.querySelectorAll("#chatMessages .img-gen-cap")].some((c) => /friendly robot/.test(c.textContent)), null, { timeout: 8000 });
  const vec = await win.evaluate(() => {
    const cap = [...document.querySelectorAll("#chatMessages .img-gen-cap")].find((c) => /friendly robot/.test(c.textContent));
    const img = cap.closest(".msg").querySelector(".msg-att-img");
    return { caption: cap.textContent, src: img ? img.getAttribute("src") : "" };
  });
  ok(/vector/.test(vec.caption), `vector mode labelled in the caption (${vec.caption.slice(-30)})`);
  ok(/^data:image\/svg\+xml/.test(vec.src), "the generated SVG renders inline (no API key needed)");

  /* ---------- clicking the generated image opens the viewer ---------- */
  await win.evaluate(() => { const im = document.querySelector("#chatMessages .img-gen-cap").closest(".msg").querySelector(".msg-att-img"); im.click(); });
  await win.waitForFunction(() => document.getElementById("imgViewer"), null, { timeout: 5000 });
  ok(await win.evaluate(() => !!document.querySelector("#imgViewer a.iv-btn[download]")), "the generated image opens in the viewer with a download control");
  await win.evaluate(() => { const b = [...document.querySelectorAll("#imgViewer .iv-btn")].find((x) => /Close/.test(x.title)); if (b) b.click(); });

  /* ---------- failure path (no key / backend error) shows a clear message ---------- */
  await win.evaluate(() => window.atomnano.test.imagegenFake(true));
  await win.evaluate(() => window.__composerSend("/image something"));
  await win.waitForFunction(() => [...document.querySelectorAll("#chatMessages .error-card, #chatMessages .msg")].some((e) => /Image generation failed/.test(e.textContent)), null, { timeout: 8000 });
  ok(await win.evaluate(() => [...document.querySelectorAll("#chatMessages .msg")].some((e) => /Image generation failed/.test(e.textContent) && /API key/.test(e.textContent))), "a failed generation shows a clear error pointing to API keys");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME IMAGEGEN TESTS FAILED" : "\nALL IMAGEGEN TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
