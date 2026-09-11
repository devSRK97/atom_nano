/* Responsiveness while a reply streams:
 *  1. Per-token deltas are COALESCED to one DOM sync per animation frame (not one
 *     rebuild per token) — keeps the main thread free so Stop/paste stay snappy.
 *  2. The chat's own auto-scroll during streaming must NOT close an open dropdown;
 *     a scroll anywhere else still closes it. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  const udir = path.join(os.tmpdir(), "atomnano-streamperf-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__streamPartial === "function" && typeof window.__openFirstDD === "function", null, { timeout: 15000 });

  /* ---------- 1. coalescing: many deltas in a frame → one pending rAF ---------- */
  const res = await win.evaluate(() => {
    window.__clearStream();
    for (let i = 0; i < 200; i++) window.__streamPartial(0, "text", "tok" + i + " ");
    return { pendingAfterBurst: window.__liveRafPending() };
  });
  ok(res.pendingAfterBurst, "200 deltas in one tick schedule a SINGLE pending frame (coalesced, not 200 rebuilds)");

  // Wait for the scheduled frame to actually flush (rAF can be throttled when the
  // test window is backgrounded — poll instead of guessing a timeout).
  await win.waitForFunction(() => !window.__liveRafPending(), null, { timeout: 4000 });
  const after = await win.evaluate(() => ({ pending: window.__liveRafPending(), text: window.__liveText() }));
  ok(!after.pending, "after the frame fires, no work is left pending");
  ok(after.text.includes("tok0 ") && after.text.includes("tok199 "), "the live text reflects every coalesced token (first..last)");

  /* ---------- 1b. multi-line append keeps EARLIER lines intact (tail-only sync) ---------- */
  const multi = await win.evaluate(async () => {
    window.__clearStream();
    // stream line-by-line across several frames, like a real reply
    for (let ln = 0; ln < 12; ln++) {
      window.__streamPartial(0, "text", "line " + ln + " content\n");
      await new Promise((r) => requestAnimationFrame(r));   // force a real frame between lines
    }
    await new Promise((r) => requestAnimationFrame(r));
    const lines = [...document.querySelectorAll("#chatLive .stream-lines .sl")].map((d) => d.textContent.replace(/​/g, ""));
    return lines;
  });
  ok(multi[0] === "line 0 content", `first line stays correct after many appends (got "${multi[0]}")`);
  ok(multi[5] === "line 5 content", `middle line stays correct (got "${multi[5]}")`);
  ok(multi.filter((l) => l.startsWith("line ")).length === 12, `all 12 streamed lines present (got ${multi.filter((l) => l.startsWith("line ")).length})`);

  /* ---------- 2. dropdown survives the chat's streaming auto-scroll ---------- */
  await win.evaluate(() => window.__clearStream());
  const opened = await win.evaluate(() => window.__openFirstDD());
  ok(opened >= 1, "a composer dropdown opens");
  await win.waitForTimeout(30);   // let the outside/scroll listeners register (setTimeout 0)

  const afterChatScroll = await win.evaluate(() => { window.__scrollChat(); return window.__ddMenuCount(); });
  ok(afterChatScroll >= 1, "the chat's auto-scroll while streaming does NOT close the open dropdown");

  const afterOtherScroll = await win.evaluate(() => { window.__scrollElsewhere(); return window.__ddMenuCount(); });
  ok(afterOtherScroll === 0, "a scroll elsewhere still closes the dropdown (orphan guard intact)");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME STREAM-PERF TESTS FAILED" : "\nALL STREAM-PERF TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
