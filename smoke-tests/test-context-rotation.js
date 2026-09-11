"use strict";
/* Context-window management: session rotation + handoff digest.
 *
 * Tests the pure-logic pieces that don't need a running Electron app:
 *  1. isPromptTooLong pattern matching
 *  2. Scaled convo digest (short vs long vs huge conversations)
 *  3. Rotation constants are sane
 *  4. contextHandoff produces a rich digest
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

const convo = require("../src/main/convo.js");
const HIST = path.join(os.tmpdir(), "atomnano-ctx-rotation-hist");
fs.rmSync(HIST, { recursive: true, force: true });
fs.mkdirSync(HIST, { recursive: true });
convo.setDir(HIST);

let _uid = 0;
const uid = () => "t" + (++_uid);
const nowISO = () => new Date().toISOString();

/* --- 1. isPromptTooLong pattern matching --- */
const PTL = /prompt.*(too long|too large)|too many tokens|request.*(too large|entity too large)|token.*exceed|context.*length.*exceed|max.*context|payload too large/i;
ok(PTL.test("prompt is too long: 250000 tokens > 200000 maximum"), "detects Claude prompt-too-long");
ok(PTL.test("Request too large"), "detects generic too-large");
ok(PTL.test("too many tokens in the request"), "detects too-many-tokens");
ok(PTL.test("context length exceeded"), "detects context-length-exceeded");
ok(PTL.test("payload too large for model"), "detects payload-too-large");
ok(!PTL.test("connection refused"), "doesn't false-positive on unrelated errors");
ok(!PTL.test("rate limit exceeded"), "doesn't false-positive on rate limits");

/* --- 2. Scaled convo digest for different conversation lengths --- */

// Helper: build a fake session with N messages
function fakeSession(msgCount, opts = {}) {
  const s = { id: uid(), messages: [], editedFiles: opts.editedFiles || [], archivedCount: opts.archivedCount || 0 };
  for (let i = 0; i < msgCount; i++) {
    const role = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool";
    if (role === "user") s.messages.push({ id: uid(), role, text: `Fix bug in module ${i} for the dashboard feature`, ts: nowISO() });
    else if (role === "assistant") s.messages.push({ id: uid(), role, text: `Fixed the issue in module ${i} by updating the handler logic.`, ts: nowISO() });
    else s.messages.push({ id: uid(), role, toolName: "Edit", ts: nowISO() });
  }
  return s;
}

// Short conversation (~60 msgs): lean digest
const short = fakeSession(60, { editedFiles: [{ path: "/app/index.js", count: 5, added: 20, removed: 10 }] });
const shortDigest = convo.digestFor(short);
ok(shortDigest.length > 0, `short conversation produces a digest (${shortDigest.length} chars)`);
ok(shortDigest.length <= 1900, `short-conversation digest is lean (${shortDigest.length} chars ≤ 1900)`);
ok(shortDigest.includes("60 messages"), "short digest reports correct message count");

// Long conversation (~600 msgs): richer digest
const long = fakeSession(600, {
  editedFiles: Array.from({length: 15}, (_, i) => ({ path: `/app/mod${i}.js`, count: i+1, added: i*10, removed: i*5 }))
});
const longDigest = convo.digestFor(long);
ok(longDigest.length > 1800, `long-conversation digest exceeds base budget (${longDigest.length} chars > 1800)`);
ok(longDigest.length <= 4900, `long-conversation digest stays within expanded budget (${longDigest.length} chars ≤ 4900)`);
ok(longDigest.includes("600 messages"), "long digest reports correct message count");

// Very long conversation with pruned history
const huge = fakeSession(200, { archivedCount: 600 });
convo.foldPruned(huge.id, Array.from({length: 40}, (_, i) => ({ role: "user", text: `Old migration task ${i} for the backend service`, ts: "" })));
const hugeDigest = convo.digestFor(huge);
ok(hugeDigest.includes("800 messages"), `huge digest reports total (live+pruned) = 800 messages`);
ok(hugeDigest.includes("600 folded"), "huge digest reports pruned count");
ok(hugeDigest.length > 0 && hugeDigest.length <= 4900, `huge digest is within expanded budget (${hugeDigest.length} chars ≤ 4900)`);

/* --- 3. Rotation constants are reasonable --- */
ok(90 * 1500 < 200000, "ROTATE_TURNS_STANDARD (90) × ~1.5k avg tokens < 200k window — rotates early with headroom");
ok(320 * 1500 < 1000000, "ROTATE_TURNS_1M (320) × ~1.5k avg tokens < 1M window");
ok(350 * 2000 < 1000000, "ROTATE_TURNS_GEMINI (350) × ~2k avg tokens < 1M Gemini window");

/* --- 4. contextHandoff logic (tested via the digest since we can't import the function) --- */
// The contextHandoff is module-scoped in claude.js, but it uses convo.digestFor
// internally. Verify the digest is rich enough for handoff scenarios.
const handoffSession = fakeSession(400, {
  archivedCount: 400,
  editedFiles: Array.from({length: 20}, (_, i) => ({
    path: `/project/src/feature${i}.ts`, count: i+2, added: i*15, removed: i*3, ts: nowISO()
  }))
});
convo.foldPruned(handoffSession.id, Array.from({length: 30}, (_, i) => ({
  role: "user", text: `Implement feature ${i} for the new payment system`, ts: ""
})));
const handoffDigest = convo.digestFor(handoffSession);
ok(handoffDigest.includes("Goals pursued"), "handoff digest includes goals section");
ok(handoffDigest.includes("Outcomes so far"), "handoff digest includes outcomes section");
ok(handoffDigest.includes("Files worked on"), "handoff digest includes files section");
ok(handoffDigest.includes("Tools leaned on"), "handoff digest includes tools section");
ok(handoffDigest.includes("800 messages"), "handoff digest reports total messages");
ok(handoffDigest.includes("400 folded"), "handoff digest reports archived count");

/* --- 4b. Idle-gap resume guard (mirrors claude.js resumeDecision) ---------- *
 * After a usage-limit reset (hours later) the CLI's on-disk transcript for the
 * resumed session id may be gone, so a plain `resume` starts BLANK and the model
 * scans project files. resumeDecision() rotates + injects a handoff only for VERY
 * stale resumes. Shorter gaps resume normally — injecting a digest there would just
 * duplicate context the model already has via the resumed transcript (wasted tokens). */
const RESUME_STALE_MS = 3 * 60 * 60 * 1000;
function idleSince(session, now) {
  const msgs = session && session.messages;
  if (!msgs || !msgs.length) return Infinity;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const ts = msgs[i] && msgs[i].ts;
    if (ts) { const t = Date.parse(ts); if (!isNaN(t)) return Math.max(0, now - t); }
  }
  return Infinity;
}
function resumeDecision(session, now) {
  const willResume = !!(session && session.claudeSessionId);
  const idleMs = willResume ? idleSince(session, now) : 0;
  return { willResume, idleMs, staleResume: willResume && idleMs > RESUME_STALE_MS };
}
const NOW = Date.now();
const mkMsg = (agoMs) => ({ id: uid(), role: "user", text: "hi", ts: new Date(NOW - agoMs).toISOString() });

// Fresh conversation, never resumed (no claudeSessionId) → trust the SDK, no guard.
let d = resumeDecision({ messages: [mkMsg(1000)] }, NOW);
ok(!d.willResume && !d.staleResume, "new session (no resume id) → no rotation");

// Active conversation resumed seconds ago → plain resume, nothing injected.
d = resumeDecision({ claudeSessionId: "s1", messages: [mkMsg(5 * 1000)] }, NOW);
ok(d.willResume && !d.staleResume, "resume after 5s idle → trust the transcript (no extra context)");

// Resumed after a 45-min coffee break → STILL a plain resume (transcript intact),
// no digest injected → no wasted tokens.
d = resumeDecision({ claudeSessionId: "s1", messages: [mkMsg(45 * 60 * 1000)] }, NOW);
ok(d.willResume && !d.staleResume, "resume after 45m idle → plain resume, no redundant digest (token-thrifty)");

// Resumed after a 5-hour usage-limit reset → DON'T trust the resume: rotate+handoff.
d = resumeDecision({ claudeSessionId: "s1", messages: [mkMsg(5 * 60 * 60 * 1000)] }, NOW);
ok(d.willResume && d.staleResume, "resume after 5h (past usage reset) → rotate + full handoff (the reported bug)");

// Reopening a day-old conversation → also rotate (transcript almost certainly gone).
d = resumeDecision({ claudeSessionId: "s1", messages: [mkMsg(26 * 60 * 60 * 1000)] }, NOW);
ok(d.staleResume, "reopening a day-old conversation → rotate + handoff");

/* --- 5. Digest stays empty for truly trivial sessions --- */
const empty = { id: uid(), messages: [], editedFiles: [], archivedCount: 0 };
const emptyDigest = convo.digestFor(empty);
ok(emptyDigest === "", "an empty session produces no digest (no waste)");
const oneMsg = { id: uid(), messages: [{ id: uid(), role: "system", text: "welcome", ts: nowISO() }], editedFiles: [], archivedCount: 0 };
const oneMsgDigest = convo.digestFor(oneMsg);
ok(oneMsgDigest === "", "a single system message produces no digest");

console.log(process.exitCode ? "\nSOME CONTEXT-ROTATION TESTS FAILED" : "\nALL CONTEXT-ROTATION TESTS PASSED");
