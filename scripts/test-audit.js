"use strict";
/* Regression harness for the 2026-09-09 audit fixes. Runs the REAL project
 * modules (store, history, attachments, profiles, providers, codex-appserver,
 * codex, claude internals, markdown) against an isolated data home, with
 * `electron` stubbed — no window, no credentials, no paid model requests.
 *
 *   node scripts/test-audit.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-audit-"));
process.env.ATOMNANO_MAX_MESSAGES = "20";            // small live window so archiving is exercised
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home");
process.env.CODEX_HOME = path.join(HOME, "codex-home");
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

// ---- electron stub (store/attachments/convo read app.getPath at load) ----
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "electron") return { app: { getPath: (k) => k === "userData" ? HOME : os.homedir(), getAppPath: () => ROOT, isPackaged: false } };
  return origLoad.call(this, req, ...rest);
};

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  — " + detail : ""}`);
}
async function run() {
  const store = require(path.join(ROOT, "src/main/store.js"));
  const history = require(path.join(ROOT, "src/main/history.js"));
  const attachments = require(path.join(ROOT, "src/main/attachments.js"));
  const profiles = require(path.join(ROOT, "src/main/profiles.js"));
  const providers = require(path.join(ROOT, "src/main/providers.js"));
  const appserver = require(path.join(ROOT, "src/main/codex-appserver.js"));
  const codex = require(path.join(ROOT, "src/main/codex.js"));
  const claude = require(path.join(ROOT, "src/main/claude.js"));
  const auth = require(path.join(ROOT, "src/main/auth.js"));
  const CI = claude.__internals;

  // ---------------- settings: removed-key migration + atomic save + failure ----------------
  const settingsPath = path.join(HOME, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ enableCavemanBrevity: true, smartThinkingGate: true, enableReadGate: true, enableFrugalContext: true, enableCodeFrugal: true, maxBudgetUsd: 5, fallbackModel: "x", commandParallelism: "max", theme: "amber", projectSettings: { "e:/p": { enableCavemanBrevity: true, defaultModel: "m" } } }));
  store.loadSettings();
  const s0 = store.getSettings();
  check("R14 removed settings stripped from global + project on load", !("enableCavemanBrevity" in s0) && !("smartThinkingGate" in s0) && !("maxBudgetUsd" in s0) && !("fallbackModel" in s0) && !("commandParallelism" in s0) && !("enableCavemanBrevity" in (JSON.parse(fs.readFileSync(settingsPath, "utf8")).projectSettings["e:/p"] || {})));
  check("R14 saveSettings drops a removed key even if a caller sends it", !("enableReadGate" in store.saveSettings({ enableReadGate: true, theme: "blue" })));
  // F07: a disk failure must surface AND leave memory + file unchanged
  const before = store.getSettings().theme;
  const realOpen = fs.openSync;
  fs.openSync = (p, flags) => { if (String(p).includes("settings.json")) { const e = new Error("ENOSPC: no space left on device"); e.code = "ENOSPC"; throw e; } return realOpen(p, flags); };
  let threw = null; try { store.saveSettings({ theme: "rose", openaiApiKey: "sk-synthetic" }); } catch (e) { threw = e; }
  fs.openSync = realOpen;
  const after = store.getSettings();
  check("F07 settings save on ENOSPC throws, memory unchanged, no key claimed saved", !!threw && /Could not save settings/.test(threw.message) && after.theme === before && !after.openaiApiKey, threw ? threw.message : "no throw");
  check("F07 settings file still valid JSON after failed save", (() => { try { JSON.parse(fs.readFileSync(settingsPath, "utf8")); return true; } catch { return false; } })());
  let errs = []; const off = store.onError((i) => errs.push(i));

  // ---------------- sessions: schema v2 round-trip (F28, F24) ----------------
  const v = store.createSession({ cwd: HOME, name: "rt" });
  const sess = store.getSession(v.id);
  history.setBinding(sess, "openai", { id: "thr_abc", syncedIndex: 3, account: "login" });
  history.setBinding(sess, "anthropic", { id: "sess_xyz", syncedIndex: 3 });
  sess.lastProvider = "openai"; sess.totalTokensIn = 100; sess.totalTokensOut = 20;
  for (let i = 0; i < 5; i++) sess.messages.push({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: "msg " + i, ts: store.nowISO() });
  store.flush(v.id);
  store.loadAllSessions();   // drop caches → reload from disk
  const re = store.getSession(v.id);
  check("F28 codexThreadId survives reload", re.codexThreadId === "thr_abc" && re.bindings.openai.id === "thr_abc" && re.bindings.openai.syncedIndex === 3 && re.bindings.openai.account === "login");
  check("F28 claudeSessionId + lastProvider survive reload", re.claudeSessionId === "sess_xyz" && re.lastProvider === "openai");
  check("F24 token totals survive reload", re.totalTokensIn === 100 && re.totalTokensOut === 20);
  check("F28 schema version stamped", re.schemaVersion === 2);
  // legacy v1 file: codexThreadId only, no bindings → migrated conservatively
  const legacyId = "legacy1";
  fs.writeFileSync(path.join(store.getSettings().historyDir, legacyId + ".json"), JSON.stringify({ id: legacyId, name: "old", messages: [{ id: "a", role: "user", text: "hi", ts: "" }, { id: "b", role: "assistant", text: "yo", ts: "" }], claudeSessionId: "c1", codexThreadId: "t1" }));
  store.loadAllSessions();
  const lg = store.getSession(legacyId);
  check("F28 legacy v1 session migrates ids into bindings (synced = whole record)", lg.bindings.openai.id === "t1" && lg.bindings.anthropic.id === "c1" && lg.bindings.openai.syncedIndex === 1);
  // import drops foreign native ids
  const imp = store.importSession({ name: "imp", messages: [{ id: "x", role: "user", text: "q", ts: "" }], claudeSessionId: "foreign", codexThreadId: "foreign2" });
  const impFull = store.getSession(imp.id);
  check("F26 import never reuses another install's native thread ids", !impFull.claudeSessionId && !impFull.codexThreadId);

  // ---------------- archive: durable-first (F08) + full export (F26) ----------------
  const a = store.createSession({ cwd: HOME, name: "arch" });
  const as = store.getSession(a.id);
  for (let i = 0; i < 20; i++) as.messages.push({ id: "k" + i, role: "user", text: "keep " + i, ts: "" });
  // 21st message with archive failing → nothing removed
  fs.openSync = (p, flags) => { if (String(p).endsWith(".archive.jsonl")) { const e = new Error("ENOSPC"); e.code = "ENOSPC"; throw e; } return realOpen(p, flags); };
  as.messages.push({ id: "k20", role: "user", text: "keep 20", ts: "" });
  const pruned = store.enforceCap(as);
  fs.openSync = realOpen;
  check("F08 archive write failure removes nothing and reports", pruned === 0 && as.messages.length === 21 && as.archivedCount === 0 && errs.some((e) => e.kind === "archive"), `pruned=${pruned} live=${as.messages.length} errs=${errs.length}`);
  // now let it succeed
  const pruned2 = store.enforceCap(as);
  check("F08 archive succeeds → one row moved, counts consistent", pruned2 === 1 && as.messages.length === 20 && as.archivedCount === 1);
  const rows = fs.readFileSync(path.join(store.getSettings().historyDir, a.id + ".archive.jsonl"), "utf8").trim().split("\n");
  check("F08 archived row is the oldest message, written once", rows.length === 1 && JSON.parse(rows[0]).id === "k0");
  const exp = store.exportSession(a.id);
  check("F26 full export includes archived + live messages in order", exp.messages.length === 21 && exp.messages[0].id === "k0" && exp.messages[20].id === "k20" && exp.archivedCount === 0);
  // F08: session flush failure reported, not swallowed
  fs.openSync = (p) => { if (String(p).includes(a.id + ".json")) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; } return realOpen(p); };
  const okFlush = store.flush(a.id);
  fs.openSync = realOpen;
  check("F08 session flush failure is reported (returns false, emits error)", okFlush === false && errs.some((e) => e.kind === "session"));
  off();

  // ---------------- history adapter (F30 / F21 / F02) ----------------
  const hsv = store.createSession({ cwd: HOME, name: "hist" });
  const hs = store.getSession(hsv.id);
  const long = "Constraint: " + "x".repeat(320) + " SENTINEL-AFTER-300 must hold.";
  hs.messages.push({ id: "u1", role: "user", text: long, ts: "" });
  hs.messages.push({ id: "a1", role: "assistant", text: "Sure.\n```js\nconst SENTINEL_CODE = 1;\n```", ts: "" });
  hs.messages.push({ id: "t1", role: "tool", toolName: "Bash", toolInput: { command: "echo SENTINEL-CMD" }, result: "SENTINEL-RESULT", status: "done", ts: "" });
  hs.messages.push({ id: "s1", role: "system", text: "app note", ts: "" });
  hs.messages.push({ id: "u2", role: "user", text: "current prompt", ts: "" });
  const last = history.lastGlobalIndex(hs);
  const blk = history.transcriptBlock(hs, -1, last - 1);
  check("F30 transfer block carries exact text after char 300, fenced code and tool results", blk.count === 3 && blk.text.includes("SENTINEL-AFTER-300") && blk.text.includes("SENTINEL_CODE") && blk.text.includes("SENTINEL-CMD") && blk.text.includes("SENTINEL-RESULT") && !blk.text.includes("app note"));
  check("F30 transfer block excludes the current prompt", !blk.text.includes("current prompt"));
  const items = history.codexItems(hs, -1, last - 1);
  check("F30 codex inject items: user → input_text, assistant/tool → output_text", items.count === 3 && items.items[0].role === "user" && items.items[0].content[0].type === "input_text" && items.items[1].role === "assistant" && items.items[2].content[0].text.includes("SENTINEL-RESULT"));
  const ps = history.pendingSync(hs, "openai", last);
  check("F30 pendingSync on a never-synced provider needs everything before the prompt", ps.needed && ps.from === -1 && ps.to === last - 1);
  history.setBinding(hs, "openai", { id: "t", syncedIndex: last - 1 });
  check("F30 pendingSync after full sync needs nothing", !history.pendingSync(hs, "openai", last).needed);
  // switching provider must NOT clear the other binding
  history.setBinding(hs, "anthropic", { id: "c" });
  check("F30/F31 a second provider binding never clears the first", hs.bindings.openai.id === "t" && hs.bindings.anthropic.id === "c");

  // ---------------- attachments (F03) ----------------
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const persisted = attachments.persist({ kind: "image", name: "p.png", data: png, mediaType: "image/png", thumb: "data:x" });
  check("F03 pasted image gets a durable path and sha; data not kept on the record", !!persisted.path && fs.existsSync(persisted.path) && !("data" in persisted) && persisted.sha && attachments.light([persisted])[0].path === persisted.path && !("data" in attachments.light([persisted])[0]));
  check("F03 bytes read back for the provider equal the original", attachments.readBase64(persisted.path) === png);
  const again = attachments.persist({ kind: "image", data: png, mediaType: "image/png" });
  check("F03 same bytes → same file (storage dedup), still a real input", again.path === persisted.path);
  const codexInput = codex.buildInput("hello", [persisted, { kind: "file", path: path.join(ROOT, "package.json"), name: "package.json" }]);
  check("F02/F03 codex exec input: full file inline (no 12k cap) + local_image", Array.isArray(codexInput) && codexInput[0].text.includes("\"@openai/codex-sdk\"") && codexInput[0].text.length > 1000 && codexInput[1].type === "local_image" && codexInput[1].path === persisted.path);
  // F02: nine files, none dropped, none clipped
  const nine = []; for (let i = 0; i < 9; i++) { const f = path.join(HOME, `f${i}.txt`); fs.writeFileSync(f, `FILE-${i}-START ` + "y".repeat(13000) + ` FILE-${i}-END`); nine.push({ kind: "file", path: f, name: `f${i}.txt` }); }
  const nineIn = codex.buildInput("q", nine);
  check("F02 nine attached files all inlined in full (no 8-file / 12k caps)", typeof nineIn === "string" && nineIn.includes("FILE-8-START") && nineIn.includes("FILE-0-END") && nineIn.includes("FILE-8-END"));

  // ---------------- profiles identity (F05) ----------------
  const A = { email: "me@corp.com", id: "acct_personal" }, B = { email: "me@corp.com", id: "acct_work" };
  check("F05 same email + different account ids are DIFFERENT accounts", !profiles.sameAccount(A, B) && profiles.conflict(A, B));
  check("F05 same id, different display email → same account", profiles.sameAccount({ email: "a@x", id: "same" }, { email: "b@x", id: "same" }));
  check("F05 email still identifies when no ids exist", profiles.sameAccount({ email: "a@x" }, { email: "A@X" }));

  // ---------------- providers strict capability (F17) ----------------
  const effErr = providers.openaiEffortStrict("max", "gpt-5.5");
  check("F17 unsupported Codex effort is an explicit error, not a downshift", !!effErr.error && effErr.effort === null);
  check("F17 legacy name translates (rename), supported level passes", providers.openaiEffortStrict("ultrathink", "gpt-5.5").effort === "xhigh" && providers.openaiEffortStrict("high", "gpt-5.5").effort === "high");
  const live = providers.get("openai");
  const mErr = providers.resolveOpenAIModelStrict("gpt-5.6");
  check("F17 unknown / short Codex model id is an explicit error when a catalog exists (or passes through without one)", live.fromCatalog ? !!mErr.error : mErr.model === "gpt-5.6", JSON.stringify(mErr));
  check("F17/R08 Claude xhigh on Opus 4.6 is an explicit error", !!CI.effortFor("claude-opus-4-6", "xhigh").error && CI.effortFor("claude-opus-4-8", "xhigh").effort === "xhigh" && CI.effortFor("claude-opus-4-6", "max").effort === "max");

  // ---------------- codex app-server internals (F15, F09) ----------------
  {
    const { onData, isThreadLost, StringDecoder } = appserver.__internals;
    const got = [];
    const s = { buf: "", pending: new Map(), threads: new Map(), dec: new StringDecoder("utf8") };
    s.threads.set("T", { onNotification: (m, p) => got.push([m, p]), onServerRequest: async () => ({}), notice() {}, fail() {} });
    const full = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "T", itemId: "i", delta: "नमस्ते 🙂 ok" } }) + "\n");
    // split INSIDE the 4-byte emoji and inside a Devanagari 3-byte sequence
    const cut1 = full.indexOf(Buffer.from("🙂")) + 2, cut2 = full.indexOf(Buffer.from("स")) + 1;
    for (const [a1, b1] of [[cut1, full.length], [cut2, full.length]]) { got.length = 0; s.buf = ""; s.dec = new StringDecoder("utf8"); onData(s, s.dec.write(full.subarray(0, a1))); onData(s, s.dec.write(full.subarray(a1, b1))); }
    check("F15 stdout split inside a multibyte char decodes intact (no U+FFFD)", got.length === 1 && got[0][1].delta === "नमस्ते 🙂 ok" && !got[0][1].delta.includes("\uFFFD"), JSON.stringify(got));
    check("F09 thread-lost classification is explicit", isThreadLost(new Error("no rollout found for thread id x")) && !isThreadLost(new Error("unauthorized")));
    check("R10 opt-out list keeps lifecycle/usage/progress notifications", !JSON.stringify(fs.readFileSync(path.join(ROOT, "src/main/codex-appserver.js"), "utf8").match(/OPT_OUT_NOTIFICATIONS = \[[^\]]*\]/)[0]).match(/tokenUsage|thread\/started|account\/rateLimits|hook\//));
    check("F01 auth contexts: API key → isolated context key; login → 'login'", appserver.ctxKeyOf({ apiKey: "sk-x" }).startsWith("apikey:") && appserver.ctxKeyOf({}) === "login" && appserver.ctxKeyOf({ apiKey: "sk-x" }) !== appserver.ctxKeyOf({ apiKey: "sk-y" }));
  }

  // ---------------- claude.js run-scoped permissions (F06) + terminal state (F04) ----------------
  {
    const events = [];
    claude.setEmitter((ch, p) => events.push([ch, p]));
    const sessA = store.getSession(store.createSession({ cwd: HOME, name: "A" }).id);
    const sessB = store.getSession(store.createSession({ cwd: HOME, name: "B" }).id);
    const pA = claude.requestPermission(sessA.id, "Bash", { command: "a" }, undefined, "run-A");
    const pB = claude.requestPermission(sessB.id, "Bash", { command: "b" }, undefined, "run-B");
    claude.finalizeRun(sessA, { id: "run-A", interrupted: true, interruptReason: "stop" }, { aborted: true });
    const rA = await Promise.race([pA, new Promise((r) => setTimeout(() => r("pending"), 200))]);
    const rB = await Promise.race([pB, new Promise((r) => setTimeout(() => r("pending"), 200))]);
    check("F06 stopping session A cancels only A's permission; B stays pending", rA && rA.behavior === "deny" && rB === "pending", JSON.stringify({ rA, rB }));
    const bReq = [...claude.permResolvers.entries()].find(([, rec]) => rec.sessionId === sessB.id);
    if (bReq) claude.respondPermission(bReq[0], { allow: true });
    const rB2 = await Promise.race([pB, new Promise((r) => setTimeout(() => r("still-pending"), 500))]);
    check("F06 B's request still answerable afterwards", rB2 && rB2.behavior === "allow", JSON.stringify(rB2));
    // Same session, two runs: the old run's cleanup must not touch the new run's prompt.
    const pOld = claude.requestPermission(sessB.id, "Bash", { command: "old" }, undefined, "run-old");
    const pNew = claude.requestPermission(sessB.id, "Bash", { command: "new" }, undefined, "run-new");
    claude.cancelPermissionsFor(sessB.id, "run-old", "Run ended");
    const rOld = await Promise.race([pOld, new Promise((r) => setTimeout(() => r("pending"), 200))]);
    const rNew = await Promise.race([pNew, new Promise((r) => setTimeout(() => r("pending"), 200))]);
    check("F14/F06 a superseded run's cleanup leaves the replacement run's permission intact", rOld && rOld.behavior === "deny" && rNew === "pending");
    const newReq = [...claude.permResolvers.entries()].find(([, rec]) => rec.runId === "run-new");
    if (newReq) claude.respondPermission(newReq[0], { allow: false, message: "cleanup" });
    // F04: error result → runner.failed, error message, terminal "error"
    const sessE = store.getSession(store.createSession({ cwd: HOME, name: "E" }).id);
    const runner = { id: "run-E", running: true };
    claude.handleMessage(sessE, { type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 2 } }, runner);
    claude.finalizeRun(sessE, runner, { aborted: false });
    check("F04 error result → failed run, status error, never completedClean", runner.failed === true && runner.completedClean === false && sessE.status === "error" && sessE.messages.some((m) => m.role === "error" && /max budget usd/.test(m.text)));
    const sessE2 = store.getSession(store.createSession({ cwd: HOME, name: "E2" }).id);
    const runner2 = { id: "run-E2", running: true };
    claude.handleMessage(sessE2, { type: "result", subtype: "success", is_error: true, result: "boom" }, runner2);
    claude.finalizeRun(sessE2, runner2, { aborted: false });
    check("F04 success frame with is_error is classified as failed", runner2.failed === true && sessE2.status === "error");
    const sessOK = store.getSession(store.createSession({ cwd: HOME, name: "OK" }).id);
    const runner3 = { id: "run-OK", running: true };
    claude.handleMessage(sessOK, { type: "result", subtype: "success", is_error: false, modelUsage: { m: { inputTokens: 5, outputTokens: 7 } } }, runner3);
    claude.finalizeRun(sessOK, runner3, { aborted: false });
    check("F04 genuine success → done + completedClean, usage applied once", runner3.completedClean === true && sessOK.status === "done" && sessOK.totalTokensIn === 5 && sessOK.totalTokensOut === 7);
    // F11/F13: early tool card from content_block_start; subagent text tagged, never resets main stream
    const sessT = store.getSession(store.createSession({ cwd: HOME, name: "T" }).id);
    const rT = { id: "run-T", running: true };
    events.length = 0;
    claude.handleMessage(sessT, { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "Bash", input: {} } } }, rT);
    claude.handleMessage(sessT, { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"sleep 5\"}" } } }, rT);
    const card = sessT.messages.find((m) => m.role === "tool" && m.toolUseId === "tu1");
    check("F11 tool card exists at content_block_start ('preparing') and fills from input_json_delta", !!card && card.toolInput && card.toolInput.command === "sleep 5");
    claude.handleMessage(sessT, { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 5" } }] } }, rT);
    check("F11 completed tool_use block upserts the SAME card (no duplicate), now running", sessT.messages.filter((m) => m.toolUseId === "tu1").length === 1 && card.status === "running");
    claude.handleMessage(sessT, { type: "tool_progress", tool_use_id: "tu1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 3.2 }, rT);
    check("F11 tool_progress patches elapsed time on the card (no fake stdout)", events.some(([ch, p]) => ch === "session:message-update" && p.messageId === card.id && p.patch.elapsedSeconds === 3.2));
    claude.handleMessage(sessT, { type: "task_notification", task_id: "bg1", tool_use_id: "tu1", status: "failed", summary: "exit 1" }, rT);
    check("F11 background task failure completes the owning card as error", card.status === "error" && /exit 1/.test(card.result || ""));
    events.length = 0;
    claude.handleMessage(sessT, { type: "stream_event", parent_tool_use_id: "task-9", event: { type: "message_start" } }, rT);
    claude.handleMessage(sessT, { type: "stream_event", parent_tool_use_id: "task-9", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "child text" } } }, rT);
    claude.handleMessage(sessT, { type: "assistant", parent_tool_use_id: "task-9", message: { content: [{ type: "text", text: "child final" }] } }, rT);
    check("F13 subagent message_start never resets the parent stream; child delta carries parent id", !events.some(([ch, p]) => ch === "session:partial-reset" && p.index === undefined) && events.some(([ch, p]) => ch === "session:partial" && p.parent === "task-9"));
    const childMsg = sessT.messages.find((m) => m.role === "assistant" && m.text === "child final");
    check("F13 child final text is tagged with its parent tool id (not an untagged main reply)", !!childMsg && childMsg.parentToolUseId === "task-9");
  }

  // ---------------- auth: logout marker (F23) ----------------
  {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    fs.writeFileSync(path.join(dir, ".atomnano-logged-out"), "x");
    check("F23 intentional logout state is recognised while no login exists", auth.isIntentionallyLoggedOut() === true);
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 1e6 } }));
    check("F23 a new login clears the logged-out state", auth.isIntentionallyLoggedOut() === false);
    fs.unlinkSync(path.join(dir, ".credentials.json"));
    check("F23 providerAuthStatus reads Codex login from CODEX_HOME (isolated home → not signed in)", auth.providerAuthStatus().openai.loggedIn === false);
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    check("F23 providerAuthStatus honours an explicit CODEX_HOME", auth.providerAuthStatus().openai.loggedIn === true);
  }

  // ---------------- markdown file links (F27) ----------------
  {
    const md = await import("file:///" + path.join(ROOT, "src/renderer/markdown.js").replace(/\\/g, "/"));
    const html = md.renderMarkdown("see [auth](E:/Mac/AtomNano/src/main/auth.js:65) and [rel](src/main/store.js) and [web](https://example.com) and `src/x.js`", { fileLinks: true });
    check("F27 absolute file:line link becomes an in-app file link with line", /class="md-link md-file" data-path="E:\/Mac\/AtomNano\/src\/main\/auth.js" data-line="65"/.test(html));
    check("F27 relative file link becomes an in-app file link", /data-path="src\/main\/store.js"/.test(html));
    check("F27 http link stays external; javascript: never becomes a link", /href="https:\/\/example.com"/.test(html) && !/href="javascript/.test(md.renderMarkdown("[x](javascript:alert(1))", { fileLinks: true })));
    check("F27 path-shaped inline code is promoted to a clickable file span", /md-fp/.test(html));
    const pl = md.parseFileLink("C:\\repo\\a.ts:12:4");
    check("F27 parseFileLink splits drive path + line + col", pl && pl.path === "C:\\repo\\a.ts" && pl.line === 12 && pl.col === 4);
  }

  // ---------------- source-level guards for removed layers ----------------
  {
    const src = fs.readFileSync(path.join(ROOT, "src/main/claude.js"), "utf8");
    check("R01 no bundled behaviour instructions in claude.js", !/caveman|frugal|codefrugal|readgate/.test(src));
    check("R04 no rotation / handoff / digest layers", !/ROTATE_TURNS|contextHandoff|rotateSession|convoDigest|HANDOFF_/.test(src));
    check("R05 no prompt / file caps", !/BATCH_PROMPT_CAP|slice\(0, 8\)|slice\(0, 12000\)/.test(src));
    check("R06 no image dedup / read gate", !/_imgHashes|imageHash/.test(src));
    check("R07/R09 no env tuning or hidden caps", !/CLAUDE_CODE_MAX_WEB_SEARCHES|ENABLE_PROMPT_CACHING_1H|MAKEFLAGS|maxBudgetUsd|taskBudget/.test(src));
    check("R08 no smart thinking gate / fallback model", !/isTrivialContinuation|resolveThinkingLevel|fallbackModel/.test(src));
    check("R10 no strictMcpConfig on interactive runs (probe only)", (src.match(/strictMcpConfig/g) || []).length === 1);
    check("R11 no self-heal", !/maybeHeal|_healTurn|planHeal/.test(src));
    check("R12 no stored tool payload truncation", !/truncateDeep|truncate\(/.test(src));
    check("R02 no <session-context> wrapper", !/session-context/.test(src));
    check("F10 no batch reviewer-CLI fallback for interactive Codex turns", !/reviewerRun\("openai", model, promptText/.test(src));
    for (const f of ["caveman.js", "frugal.js", "codefrugal.js", "readgate.js", "context.js", "graph.js", "convo-graph.js", "capabilities.js", "distill.js", "localmind.js"]) check(`removed module deleted: ${f}`, !fs.existsSync(path.join(ROOT, "src/main", f)));
    const app = fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf8");
    check("F29 New session never reuses a blank tab", !/find\(\(ts\) => tabIsEmpty\(ts\) && samePath/.test(app));
    check("F19 no live-line tail cap", !/MAX_LIVE_LINES/.test(app));
    check("F12 tool cards are patched in place", /patchToolCard\(node, m, ts\)/.test(app));
    check("R13 optimise / local optimizer UI removed", !/renderOptimiseBar|openLocalSetupModal|atom\.localmind/.test(app));
  }

  console.log(`\n${pass} passed, ${fail} failed  (data home: ${HOME})`);
  process.exitCode = fail ? 1 : 0;
}
run().catch((e) => { console.error("harness crashed:", e); process.exitCode = 2; });
