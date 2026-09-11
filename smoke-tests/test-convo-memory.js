/* Session-memory (convo graph) batch:
 *  - a long transcript is capped at MAX_MESSAGES; the oldest fold into memory
 *    + an on-disk archive (totalMessages + archivedCount reported correctly)
 *  - the auto-distilled digest survives pruning: goals/outcomes/files from the
 *    pruned region still appear (this is what the resume path injects, so a
 *    fresh retry after a lost CLI session is no longer amnesiac)
 *  - token-aware: a trivial/empty session produces no digest
 *  - the chat header sentinel tells the user N messages were folded into memory
 *
 * Cap is forced low via ATOMNANO_MAX_MESSAGES so we don't fabricate 5000 msgs.
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-convo");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const udir = path.join(os.tmpdir(), "atomnano-convo-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({
    args: [ROOT, "--user-data-dir=" + udir],
    env: { ...process.env, ATOMNANO_TEST: "1", ATOMNANO_MAX_MESSAGES: "20" },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__reloadTab === "function" && typeof window.__setProject === "function", null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(400);

  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  ok(!!sid, "have a session id");

  /* ---------- fabricate a 30-message conversation (cap = 20) ----------
   * All the user GOALS live in the first 10 (the region that gets pruned), so a
   * digest that still mentions them proves the pruned gist was folded into memory.
   * The kept tail is assistant/tool only — no live goals to crowd them out. */
  const loginPath = (DIR + "/login.js").replace(/\\/g, "/");
  const msgs = [];
  const ts = (i) => new Date(2026, 0, 1, 0, 0, i).toISOString();
  msgs.push({ id: "u0", role: "user", text: "implement the login form with field validation", ts: ts(0) });
  msgs.push({ id: "a0", role: "assistant", text: "Added a LoginForm component with validation.", ts: ts(1) });
  msgs.push({ id: "u1", role: "user", text: "add a password strength meter to signup", ts: ts(2) });
  msgs.push({ id: "a1", role: "assistant", text: "Implemented the password strength meter.", ts: ts(3) });
  for (let i = 4; i < 10; i++) msgs.push({ id: "p" + i, role: i % 2 ? "assistant" : "tool", toolName: i % 2 ? undefined : "Edit", text: i % 2 ? "early step " + i : undefined, status: i % 2 ? undefined : "done", toolInput: i % 2 ? undefined : { file_path: loginPath }, ts: ts(i) });
  // kept tail (indices 10..29): assistant notes + Edit tools, no user goals
  for (let i = 10; i < 29; i++) msgs.push({ id: "k" + i, role: i % 2 ? "tool" : "assistant", toolName: i % 2 ? "Edit" : undefined, text: i % 2 ? undefined : "progress note " + i, status: i % 2 ? "done" : undefined, toolInput: i % 2 ? { file_path: loginPath } : undefined, ts: ts(i) });
  msgs.push({ id: "klast", role: "assistant", text: "All tests passing ✓", ts: ts(29) });
  ok(msgs.length === 30, `fabricated ${msgs.length} messages`);

  await win.evaluate(({ sid, msgs, loginPath }) =>
    window.atomnano.sessions.update(sid, { messages: msgs, editedFiles: [{ path: loginPath, count: 5, added: 40, removed: 3 }] }),
    { sid, msgs, loginPath });

  /* ---------- 1) cap + archive ---------- */
  const view = await win.evaluate((sid) => window.atomnano.sessions.get(sid), sid);
  ok(view.totalMessages === 20, `live transcript capped at 20 (got ${view.totalMessages})`);
  ok(view.archivedCount === 10, `10 oldest archived past the cap (got ${view.archivedCount})`);
  const archPath = path.join(udir, "sessions", sid + ".archive.jsonl");
  let archLines = [];
  try { archLines = fs.readFileSync(archPath, "utf8").split("\n").filter(Boolean); } catch { /* missing */ }
  ok(archLines.length === 10, `archive file holds the 10 pruned messages (got ${archLines.length})`);
  ok(/login form with field validation/.test(archLines.join(" ") || ""), "archived message content is the real (lossless) transcript");

  /* ---------- 2) digest survives pruning (the resume / anti-amnesia payload) ---------- */
  const peek = await win.evaluate((sid) => window.atomnano.convo.peek(sid), sid);
  ok(peek.pruned === 10 && peek.live === 20, `convo memory sees both sides (live=${peek.live}, pruned=${peek.pruned})`);
  ok(/Session memory/.test(peek.digest), "digest is labelled session memory");
  ok(/10 folded into memory/.test(peek.digest), "digest notes how many messages were folded in");
  ok(/login form/.test(peek.digest) && /strength meter/.test(peek.digest), "digest still carries the PRUNED user goals (fold worked)");
  ok(/Files worked on:.*login\.js/.test(peek.digest), "digest lists files worked on");
  ok(/Outcomes so far|All tests passing/.test(peek.digest), "digest carries outcomes from the kept tail");
  ok(peek.digest.length <= 1900, `digest stays bounded (${peek.digest.length} chars)`);

  /* ---------- 3) token-aware: trivial sessions get no digest ---------- */
  const emptyDigest = await win.evaluate(async () => {
    const s = await window.atomnano.sessions.create({});
    return window.atomnano.convo.digest(s.id);
  });
  ok(emptyDigest === "", "a brand-new session produces no digest (nothing to inject)");

  /* ---------- 4) renderer surfaces the folded-into-memory count ---------- */
  await win.evaluate((sid) => window.__reloadTab(sid), sid);
  await win.waitForTimeout(500);
  const sentinel = await win.evaluate(() => {
    const el = document.querySelector("#chatMessages .load-more");
    return el ? { text: el.textContent, static: el.classList.contains("load-more-static") } : null;
  });
  ok(sentinel && /folded into session memory/.test(sentinel.text), `chat header tells the user about folded messages (${sentinel && JSON.stringify(sentinel.text)})`);
  ok(sentinel && sentinel.static, "the archived-only sentinel is informational (not a load target)");

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME CONVO-MEMORY TESTS FAILED" : "\nALL CONVO-MEMORY TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
