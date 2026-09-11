/* Conversation thread graph + recall (BM25, no model):
 *  - a wandering chat is segmented into topic THREADS (auth / search / database)
 *  - referencing an earlier thread ("go back to the auth JWT thing") RECALLS it
 *  - a prompt about the CURRENT topic does NOT mis-recall (margin-gated)
 */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DIR = path.join(os.tmpdir(), "atomnano-cgraph");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const udir = path.join(os.tmpdir(), "atomnano-cgraph-udata");
  fs.rmSync(udir, { recursive: true, force: true });
  const app = await electron.launch({ args: [ROOT, "--user-data-dir=" + udir], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => typeof window.__setProject === "function" && window.atomnano && window.atomnano.convograph, null, { timeout: 15000 });
  await win.evaluate((p) => window.__setProject(p), DIR.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  // A conversation that wanders across three clearly distinct sub-topics.
  const T = (i) => new Date(2026, 0, 1, 0, 0, i).toISOString();
  const msgs = [
    { id: "a1u", role: "user", text: "implement OAuth login with JWT tokens in auth.js", ts: T(0) },
    { id: "a1a", role: "assistant", text: "Added auth.js with JWT verify() and a login route.", ts: T(1) },
    { id: "a2u", role: "user", text: "fix the JWT token refresh in the auth.js login flow", ts: T(2) },
    { id: "a2a", role: "assistant", text: "Fixed refresh token rotation in the login flow.", ts: T(3) },
    { id: "b1u", role: "user", text: "add full-text search to the sidebar component", ts: T(4) },
    { id: "b1a", role: "assistant", text: "Added search.js with a searchIndex() over the docs.", ts: T(5) },
    { id: "b2u", role: "user", text: "make the search input debounce by 200ms", ts: T(6) },
    { id: "b2a", role: "assistant", text: "Debounced the search input.", ts: T(7) },
    { id: "c1u", role: "user", text: "migrate the database to postgres with a new schema", ts: T(8) },
    { id: "c1a", role: "assistant", text: "Added db.js migration and a postgres connection pool.", ts: T(9) },
  ];
  const sid = await win.evaluate(() => window.atomnano.sessions.list().then((l) => l[0] && l[0].id));
  await win.evaluate(({ sid, msgs }) => window.atomnano.sessions.update(sid, { messages: msgs }), { sid, msgs });

  /* ---------- segmentation ---------- */
  const peek = await win.evaluate((sid) => window.atomnano.convograph.peek(sid, ""), sid);
  ok(peek.threads.length === 3, `chat segmented into 3 topic threads (${peek.threads.length}: ${peek.threads.map((t) => JSON.stringify(t.title.slice(0, 18))).join(", ")})`);
  const titles = peek.threads.map((t) => t.title.toLowerCase()).join(" | ");
  ok(/oauth|login|auth/.test(titles) && /search/.test(titles) && /database|postgres|migrate/.test(titles), `threads cover auth + search + database (${titles})`);
  ok(peek.threads.some((t) => t.files.some((f) => /auth\.js/.test(f))), "the auth thread captured its files (auth.js)");

  /* ---------- recall an earlier thread ---------- */
  const r1 = await win.evaluate((sid) => window.atomnano.convograph.peek(sid, "go back to the auth JWT login thing we did earlier"), sid);
  ok(r1.recalled && /oauth|login|jwt|auth/i.test(r1.recalled), `referencing the past recalls the AUTH thread (recalled: ${JSON.stringify(r1.recalled)})`);

  /* ---------- no mis-recall on the current topic ---------- */
  const r2 = await win.evaluate((sid) => window.atomnano.convograph.peek(sid, "add a postgres index to the new schema"), sid);
  ok(r2.recalled === null, `a current-topic prompt does NOT mis-recall an old thread (recalled: ${JSON.stringify(r2.recalled)})`);

  /* ---------- recall the search thread by its terms ---------- */
  const r3 = await win.evaluate((sid) => window.atomnano.convograph.peek(sid, "remember the full-text search sidebar we built? tweak it"), sid);
  ok(r3.recalled && /search/i.test(r3.recalled), `referencing search recalls the SEARCH thread (recalled: ${JSON.stringify(r3.recalled)})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? " — " + errors.join(" | ") : ""));
  await app.close();
  console.log(process.exitCode ? "\nSOME CONVO-GRAPH TESTS FAILED" : "\nALL CONVO-GRAPH TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
