"use strict";
// Offline, no model calls or saved profiles. Byte budgets, source retrieval and tool outcomes.
const assert = require("node:assert/strict");
const Module = require("node:module"), originalLoad = Module._load;
// History's pure text adapter needs no disk-backed store in this suite.
Module._load = function (id, parent, ...rest) {
  if (id === "./store" && /[\\/]storage[\\/]history\.js$/.test(parent.filename)) return {};
  return originalLoad.call(this, id, parent, ...rest);
};
const packet = require("../src/main/session/context-packet");
const query = require("../src/main/storage/history-query");
const history = require("../src/main/storage/history");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log("PASS " + name); };
async function main() {
  check("A 600 MiB logical transcript is planned without constructing an oversized string", () => {
    const messages = Array.from({ length: 600 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: "x".repeat(1024 * 1024) }));
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/main/storage/history.js"), "utf8"), { module: mod, require: () => ({ getMessagesRange: (_id, end, n) => ({ messages: messages.slice(end - n, end) }) }) });
    const plan = mod.exports.planTransfer({ id: "scale", messages }, -1, 599, { budgetChars: 32768 });
    assert.equal(plan.mode, "summary"); assert.equal(plan.count, 600); assert.ok(plan.fullChars > 600 * 1024 * 1024);
  });
  const source = "BEGIN " + "🧑🏽‍💻東京తెలుగు".repeat(400) + " END";
  check("UTF-8 excerpts honor every small byte limit without replacement characters", () => {
    for (let size = 0; size <= 1024; size++) {
      const text = packet.excerpt(source, size);
      assert.ok(Buffer.byteLength(text) <= size); assert.ok(!text.includes("�"));
    }
  });
  const messages = Array.from({ length: 400 }, (_, i) => ({ id: "id" + i, role: i % 2 ? "assistant" : "user", text: "ENTRY " + i + " " + source, ts: "2026-09-17" }));
  messages.push({ id: "failure", role: "tool", toolName: "Bash", toolInput: { command: "npm test" }, status: "error", result: "Log ".repeat(100000) + "FAIL: account cursor skipped context" });
  const rows = messages.map((m, g) => ({ m, g }));
  const session = { id: "portable", archivedCount: 380, messages: messages.slice(380), tasks: { sets: [{ status: "active", title: "Fix login" }], items: [{ n: 1, status: "blocked", title: "Account switch", notes: [{ text: "Test failed" }] }] } };
  check("Adaptive allocation grows with requests, outcomes and open work; remains bounded", () => {
    assert.ok(packet.budgetFor({}, []) < packet.budgetFor(session, rows));
    assert.ok(packet.budgetFor(session, rows) <= 32768);
  });
  check("Selected handoff retains recent constraints, actual failures, board state and exact source refs", () => {
    const built = packet.assemble(session, rows, { to: 400, summary: "Keep credentials isolated", summaryThrough: 200 });
    assert.ok(built.bytes <= built.budget); assert.equal(built.bytes, Buffer.byteLength(built.text));
    for (const text of ["ENTRY 398", "ENTRY 399", "FAIL: account cursor", "T1 [blocked]", "Keep credentials", "--session portable", "entry 400 / failure"]) assert.ok(built.text.includes(text), text);
    assert.ok(!built.text.includes("ENTRY 100 "));
  });
  check("An enormous summary and source map cannot overflow the handoff", () => {
    const built = packet.assemble(session, rows, { summary: source.repeat(30), mapText: source.repeat(30), maxBytes: 20000 });
    assert.ok(built.bytes <= 20000); assert.ok(!built.text.includes("�"));
    const input = packet.summarizerInput(session, rows, { from: -1, to: 400, previous: source.repeat(30) });
    assert.ok(Buffer.byteLength(input.text) <= 32768);
  });
  const store = { getMessagesRange: (_id, end, count) => ({ messages: messages.slice(Math.max(0, end - count), end) }) };
  check("Archived entries are retrievable by index and stable message id", () => {
    const a = query.read(store, session, 5), b = query.read(store, session, "id5");
    assert.deepEqual(a, b); assert.equal(a.archived, true); assert.equal(a.id, "id5");
  });
  check("Byte pagination reconstructs exact Unicode history without gaps or duplicate bytes", () => {
    let offset = 0, reconstructed = "";
    do { const page = query.read(store, session, "id399", { offset, limit: 113 }); reconstructed += page.text; assert.ok(page.bytes <= 113); offset = page.nextOffset; } while (offset != null);
    assert.equal(reconstructed, history.entryText(messages[399]));
  });
  const found = await query.search(store, session, "account cursor", { limit: 2 });
  check("History search finds recorded tool failures as well as conversational text", () => { assert.equal(found.matches.length, 1); assert.equal(found.matches[0].id, "failure"); assert.ok(found.matches[0].snippet.includes("FAIL:")); });
  const page1 = await query.search(store, session, "ENTRY", { limit: 2 });
  const page2 = await query.search(store, session, "ENTRY", { limit: 2, before: page1.nextBefore });
  check("Search pagination has no repeats and includes archived matches", () => { assert.deepEqual(page1.matches.map((m) => m.index), [399, 398]); assert.deepEqual(page2.matches.map((m) => m.index), [397, 396]); });
  check("Read rejects invalid pagination and missing records", () => {
    for (const ref of [99999, "missing-id"]) assert.throws(() => query.read(store, session, ref), (e) => e.status === 404);
    assert.throws(() => query.read(store, session, 0, { limit: 999999 }), (e) => e.status === 400);
    assert.throws(() => query.read(store, session, 0, { offset: -1 }), (e) => e.status === 400);
  });
  await assert.rejects(query.search(store, session, ""), (e) => e.status === 400);
  console.log(`Adaptive context: ${checks} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
