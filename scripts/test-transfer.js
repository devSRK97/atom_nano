"use strict";
/* Conversation-transfer regression suite (user decision 2026-09-10):
 *   · EXACT record transfer is the default whenever the record fits the destination model's
 *     context window — nothing changes for ordinary conversations.
 *   · A record that cannot fit degrades VISIBLY: first tool payloads are shortened (text
 *     verbatim), then the OLDEST part is summarised by a model and the NEWEST entries stay
 *     verbatim. Summaries are cached on the session and rolled forward — never recomputed
 *     for the same span (that is the "caching" the user asked for).
 *   · A resumed thread mid-conversation sends ONLY the new prompt (never the record again).
 *   · "Prompt is too long" / "context window exceeded" are recognised for both harnesses.
 * Runs the real store/history/claude modules against an isolated data home with Electron
 * stubbed and the summariser injected (no model requests). Run: node scripts/test-transfer.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-transfer-"));
process.env.ATOMNANO_MAX_MESSAGES = "40";   // small live window → the archive is exercised by the record range reads
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, "claude-home"); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.CODEX_HOME = path.join(HOME, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 500) : ""}`); } }

async function main() {
  const store = require(path.join(ROOT, "src/main/store.js"));
  const history = require(path.join(ROOT, "src/main/history.js"));
  const claude = require(path.join(ROOT, "src/main/claude.js"));
  const CI = claude.__internals;
  store.loadSettings();
  claude.send = () => {};   // no renderer

  // ---- fixture: a long conversation with big tool payloads ----
  const v = store.createSession({ cwd: HOME, name: "long" });
  const s = store.getSession(v.id);
  const big = (n, tag) => (tag + " ").repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);
  for (let i = 0; i < 60; i++) {
    s.messages.push({ id: "u" + i, role: "user", text: `USER-${i}: please do step ${i}`, ts: store.nowISO() });
    s.messages.push({ id: "t" + i, role: "tool", toolName: "Read", toolInput: { file_path: `C:\\p\\f${i}.js` }, status: "done", result: big(12000, `FILE${i}`), ts: store.nowISO() });
    s.messages.push({ id: "a" + i, role: "assistant", text: `ASSIST-${i}: done step ${i} ` + big(8000, "prose"), ts: store.nowISO() });   // long replies: verbatim text cannot be shortened
    s.messages.push({ id: "r" + i, role: "result", text: "", ts: store.nowISO(), meta: {} });   // app-side, never transferred
    store.enforceCap(s);
  }
  s.messages.push({ id: "prompt", role: "user", text: "NEW PROMPT", ts: store.nowISO() });
  store.enforceCap(s); store.flush(v.id);
  const last = history.lastGlobalIndex(s);
  check("T00", "fixture: 60 turns, archive in use, 241 messages", last === 240 && s.archivedCount > 0, { last, archived: s.archivedCount });

  // ---- planTransfer tiers ----
  const exact = history.planTransfer(s, -1, last - 1, { budgetChars: Infinity });
  check("T01", "unlimited budget → EXACT record (180 history entries, results untouched)", exact.mode === "exact" && exact.count === 180 && exact.text.includes(big(12000, "FILE7")) && /verbatim/.test(exact.text.slice(0, 200)), { mode: exact.mode, count: exact.count });
  const fits = history.planTransfer(s, -1, last - 1, { budgetChars: exact.chars + 10 });
  check("T02", "a budget the exact record fits stays EXACT", fits.mode === "exact");
  const short = history.planTransfer(s, -1, last - 1, { budgetChars: exact.chars - 1 });
  check("T03", "one char short → SHORTENED: conversation text verbatim, tool results head + size note", short.mode === "shortened" && short.count === 180 && short.text.includes("USER-59: please do step 59") && short.text.includes("ASSIST-0: done step 0") && !short.text.includes(big(12000, "FILE7")) && /10,500 characters omitted here/.test(short.text) && /entry t7/.test(short.text) && /shortened to fit/.test(short.text.slice(0, 400)), { chars: short.chars, full: short.fullChars });
  const sum = history.planTransfer(s, -1, last - 1, { budgetChars: 60000 });
  check("T04", "too small for shortened → SUMMARY plan: newest entries verbatim within half the budget, oldest summarised", sum.mode === "summary" && sum.headCount > 0 && sum.headCount < 180 && sum.head.from === -1 && sum.tail.to === last - 1 && sum.texts.slice(sum.headCount).join("").length <= 30000 && sum.texts.slice(sum.headCount).join("").includes("USER-59"), { headCount: sum.headCount, head: sum.head });
  const text = history.transferText(sum, "THE SUMMARY");
  check("T05", "summary text: header states counts, summary first, then the recent entries verbatim", /larger than the model's context window/.test(text) && text.indexOf("[Summary of the earlier conversation]\nTHE SUMMARY") > 0 && text.indexOf("[Most recent entries, verbatim]") > text.indexOf("THE SUMMARY") && text.includes("USER-59") && !text.includes("USER-0:"), { head: text.slice(0, 300) });
  const items = history.transferItems(sum, "THE SUMMARY");
  check("T06", "Codex items: the summary is the first (user) item, then the recent entries as user/assistant messages", items[0].role === "user" && /Conversation summary/.test(items[0].content[0].text) && items[0].content[0].text.includes("THE SUMMARY") && items.length === 1 + (180 - sum.headCount) && items.at(-1).role === "assistant" && items.some((it) => it.role === "user" && it.content[0].text === "USER-59: please do step 59"), { n: items.length });
  const forced = history.planTransfer(s, -1, last - 1, { budgetChars: Infinity, forceSummary: true });
  check("T07", "forceSummary with an unlimited budget still summarises the head (tail = half of the shortened size)", forced.mode === "summary" && forced.headCount > 0);
  check("T08", "an empty span plans nothing", history.planTransfer(s, last - 1, last - 1).count === 0 && history.transferText(history.planTransfer(s, 10, 10), "") === "");
  const mid = history.planTransfer(s, 100, 150, { budgetChars: Infinity });
  check("T09", "a partial span (provider switch) transfers only the missing entries", mid.mode === "exact" && mid.msgs[0].g === 101 && mid.msgs.at(-1).g === 150 && !mid.text.includes("USER-0:"));

  // ---- summariser: chunked, rolled forward, cached ----
  const calls = [];
  claude.setSummarizer(async (provider, model, prompt) => { calls.push({ provider, model, prompt }); const prev = /Summary so far[^\n]*\n([\s\S]*?)\n\n---/.exec(prompt); const seen = (prompt.match(/USER-(\d+):/g) || []).map((x) => x.replace(/\D/g, "")); return `SUM[${prev ? prev[1].replace(/^SUM\[|\]$/g, "") + "," : ""}${seen[0]}-${seen.at(-1)}]`; });
  s.summaries = [];
  const tb1 = await claude.transferBlock(s, "anthropic", { model: "claude-opus-4-8", from: -1, to: last - 1, budgetScale: 1, promptChars: 0 });
  check("T10", "transferBlock with the real Claude budget (200k ctx → 400k chars) keeps this 1.1 MB record as a SUMMARY transfer", tb1.mode === "summary" && tb1.count === 180 && tb1.budget === 400000 && calls.length >= 1, { mode: tb1.mode, budget: tb1.budget, calls: calls.length });
  const chunks1 = calls.length;
  check("T11", "the summariser saw every head entry exactly once, in chunks that fit half the budget, rolling the previous summary forward", calls.every((c) => c.prompt.length <= 200000) && (chunks1 === 1 || calls.slice(1).every((c) => /Summary so far/.test(c.prompt))) && /^SUM\[0-/.test(tb1.summary), { chunks: chunks1, summary: tb1.summary.slice(0, 60) });
  check("T12", "the summary card was added to the chat with its span", s.messages.some((m) => m.role === "summary" && m.text === tb1.summary && m.meta.entries === tb1.plan.headCount && m.meta.provider === "anthropic"));
  check("T13", "the summary is cached on the session", Array.isArray(s.summaries) && s.summaries.some((x) => x.from === -1 && x.upTo === tb1.plan.head.to && x.text === tb1.summary));
  const before = calls.length;
  const tb2 = await claude.transferBlock(s, "openai", { model: "gpt-5.5", from: -1, to: last - 1, promptChars: 0 });
  check("T14", "re-synthesising for ANOTHER provider reuses the cached summary — zero new summariser calls", calls.length === before && tb2.mode === "summary" && tb2.summary === tb1.summary, { calls: calls.length - before, mode: tb2.mode });
  check("T15", "Codex budget comes from its catalog context (272k → 544k chars)", tb2.budget === 544000, { budget: tb2.budget });
  // the conversation grows → only the NEW part is summarised on top of the cached summary
  for (let i = 60; i < 80; i++) { s.messages.push({ id: "u" + i, role: "user", text: `USER-${i}: more`, ts: store.nowISO() }, { id: "t" + i, role: "tool", toolName: "Read", toolInput: { file_path: "x" }, status: "done", result: big(6000, `FILE${i}`), ts: store.nowISO() }, { id: "a" + i, role: "assistant", text: `ASSIST-${i}`, ts: store.nowISO() }); store.enforceCap(s); }
  const last2 = history.lastGlobalIndex(s);
  const tb3 = await claude.transferBlock(s, "anthropic", { model: "claude-opus-4-8", from: -1, to: last2, promptChars: 0, budgetScale: 0.5 });
  const rolled = calls.slice(before);
  check("T16", "a longer record rolls the cached summary forward: the new calls carry the previous summary and only newer entries", tb3.mode === "summary" && rolled.length >= 1 && rolled.every((c) => /Summary so far/.test(c.prompt)) && !rolled.some((c) => /USER-1:/.test(c.prompt)), { rolled: rolled.length });
  check("T17", "the rolled summary is cached with the later upTo", s.summaries.some((x) => x.from === -1 && x.upTo === tb3.plan.head.to && x.text === tb3.summary) && s.summaries.length >= 2);
  const persisted = JSON.parse(fs.readFileSync(path.join(store.getSettings().historyDir, `${v.id}.json`), "utf8"));
  store.flush(v.id); store.loadAllSessions();
  const reloaded = store.getSession(v.id);
  check("T18", "summaries persist across a reload (session schema keeps them)", Array.isArray(reloaded.summaries) && reloaded.summaries.length === s.summaries.length && !!persisted, { n: reloaded.summaries && reloaded.summaries.length });
  check("T19", "the summary card is app-side: never part of the transferred record", !history.isHistoryMessage({ role: "summary", text: "x" }) && !history.planTransfer(reloaded, -1, history.lastGlobalIndex(reloaded), { budgetChars: Infinity }).text.includes("SUM["));

  // ---- exact stays exact for ordinary conversations; mid-conversation prompt sends nothing old ----
  const v2 = store.createSession({ cwd: HOME, name: "short" });
  const s2 = store.getSession(v2.id);
  for (let i = 0; i < 6; i++) { s2.messages.push({ id: "u" + i, role: "user", text: "q" + i, ts: store.nowISO() }, { id: "a" + i, role: "assistant", text: "a" + i, ts: store.nowISO() }); }
  const c0 = calls.length;
  const tbS = await claude.transferBlock(s2, "anthropic", { model: "claude-opus-4-8", from: -1, to: history.lastGlobalIndex(s2), promptChars: 5000 });
  check("T20", "an ordinary conversation is transferred EXACTLY (no summary, no summariser call, verbatim header)", tbS.mode === "exact" && tbS.count === 12 && calls.length === c0 && /verbatim/.test(tbS.text.slice(0, 150)) && /verbatim record/.test(tbS.note));
  history.setBinding(s2, "anthropic", { id: "sess_1", syncedIndex: history.lastGlobalIndex(s2) });
  s2.messages.push({ id: "p", role: "user", text: "mid prompt", ts: store.nowISO() });
  const sync = history.pendingSync(s2, "anthropic", history.lastGlobalIndex(s2));
  check("T21", "a prompt in the middle of a live thread needs NO transfer (only the new message is sent)", sync.needed === false);
  s2.messages.push({ id: "a-p", role: "assistant", text: "reply", ts: store.nowISO() }, { id: "res", role: "result", text: "", ts: store.nowISO(), meta: {} });
  history.setBinding(s2, "anthropic", { syncedIndex: history.lastGlobalIndex(s2) });
  s2.messages.push({ id: "p2", role: "user", text: "next", ts: store.nowISO() });
  check("T22", "…and again on the next turn", history.pendingSync(s2, "anthropic", history.lastGlobalIndex(s2)).needed === false);
  const sw = history.pendingSync(s2, "openai", history.lastGlobalIndex(s2));
  check("T23", "switching provider transfers exactly what that provider's thread missed", sw.needed === true && sw.from === -1 && sw.to === history.lastGlobalIndex(s2) - 1);

  // ---- budgets and error classification ----
  check("T24", "context budget: Claude 200k (1M when enabled), Codex from its catalog, custom 128k", claude.contextTokensFor("anthropic", "claude-opus-4-8", { oneM: false }) === 200000 && claude.contextTokensFor("anthropic", "claude-opus-4-8", { oneM: true }) === 1000000 && claude.contextTokensFor("openai", "gpt-5.5", {}) === 272000 && claude.contextTokensFor("custom", "x", {}) === 128000);
  check("T25", "transfer budget = half the window in chars minus the prompt", claude.transferBudgetChars("anthropic", "claude-opus-4-8", { oneM: false }, 10000) === 390000);
  const P = CI.isPromptTooLong;
  check("T26", "prompt-too-long recognised for both harnesses", P(new Error("Prompt is too long")) && P("prompt is too long: 214000 tokens > 200000 maximum") && P({ message: "Your input exceeds the context window of this model." }) && P("context_length_exceeded") && P("The request exceeds the model's context window") && P("413 Request Entity Too Large") && P({ promptTooLong: true }));
  check("T27", "…but not for rate limits, network or ordinary errors", !P("429 rate limit exceeded") && !P("ECONNRESET") && !P("no such table: users") && !CI.isRateLimitError("prompt is too long"));
  check("T28", "the summarisation instruction is a separate request's instruction (not part of the user's turn)", typeof CI.SUMMARY_INSTRUCTIONS === "string" && /faithful working summary/.test(CI.SUMMARY_INSTRUCTIONS) && !tb1.text.includes(CI.SUMMARY_INSTRUCTIONS));
  // audit-harness compatibility: no forbidden identifiers reappeared in claude.js
  const src = fs.readFileSync(path.join(ROOT, "src/main/claude.js"), "utf8");
  check("T29", "no rotation/handoff/digest/cap identifiers from the removed layers", !/ROTATE_TURNS|contextHandoff|rotateSession|convoDigest|HANDOFF_|BATCH_PROMPT_CAP|slice\(0, 8\)|slice\(0, 12000\)|truncateDeep|truncate\(/.test(src));

  console.log(`\nTransfer: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(failures.map((f) => " - " + f).join("\n")); process.exitCode = 1; }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
