"use strict";
// Real catalog/discovery and budget methods, with local capability responses.
// No credentials, provider calls or saved profiles are involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.join(__dirname, "..");
let passed = 0;
const codexModels = {
  load: () => ({ models: [{ id: "codex-large", name: "Large", ctx: 1048576, efforts: ["low"] }, { id: "codex-small", name: "Small", ctx: 272000, efforts: ["low"] }], defaults: {} }),
  listed: (models) => models, refresh: async () => {},
};
const catalogModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src/main/providers/catalog.js"), "utf8"), {
  module: catalogModule, require: (id) => id === "./codex-models" ? codexModels : require(id), console,
});
const catalog = catalogModule.exports;
const transferModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src/main/session/transfer.js"), "utf8"), {
  module: transferModule, require: (id) => {
    if (id === "../providers/catalog") return catalog;
    if (id === "../storage/store") return {};
    if (id === "../storage/history") return { CHARS_PER_TOKEN: 4 };
    if (id === "./context-packet") return require("../src/main/session/context-packet");
    if (id === "./errors") return require("../src/main/session/errors");
    throw new Error("Unexpected dependency: " + id);
  }, console, process, setTimeout, clearTimeout,
});
const budget = transferModule.exports.methods;
async function check(name, fn) { await fn(); passed++; console.log("PASS " + name); }
async function main() {
  await check("A known 1M model uses 1M before its first reply, with a legacy false flag", () => {
    assert.equal(budget.contextTokensFor("anthropic", "claude-fable-5-1", { oneM: false }), 1000000);
    assert.equal(budget.transferBudgetChars("anthropic", "claude-fable-5-1", { oneM: false }, 10000), 1990000);
  });
  await check("Live context updates for an existing model reach both the picker and backend", async () => {
    catalog.setModelFetcher(async () => [{ id: "claude-fable-5-1", ctx: 1500000 }]);
    const discovered = await catalog.discover("anthropic");
    assert.equal(discovered.models.find((m) => m.id === "claude-fable-5-1").ctx, 1500000);
    assert.equal(budget.contextTokensFor("anthropic", "claude-fable-5-1", { oneM: false }), 1500000);
  });
  await check("Newly discovered numeric capacities are retained without rounding to a fixed window", async () => {
    catalog.setModelFetcher(async () => [{ id: "claude-new-model", ctx: 750000 }, { id: "claude-large-model", ctx: 2000000 }]);
    await catalog.discover("anthropic");
    assert.equal(budget.contextTokensFor("anthropic", "claude-new-model", { oneM: false }), 750000);
    assert.equal(budget.contextTokensFor("anthropic", "claude-large-model", { oneM: false }), 2000000);
    assert.equal(budget.contextTokensFor("anthropic", "claude-large-model", { oneM: true }), 2000000);
    assert.equal(catalog.context1M("anthropic", "claude-large-model"), true);
  });
  await check("A real smaller capability replaces an old catalog guess", async () => {
    catalog.setModelFetcher(async () => [{ id: "claude-fable-5-1", ctx: 500000 }]);
    await catalog.discover("anthropic");
    assert.equal(budget.contextTokensFor("anthropic", "claude-fable-5-1", { oneM: false }), 500000);
    assert.equal(catalog.context1M("anthropic", "claude-fable-5-1"), false);
  });
  await check("Codex uses the installed catalog's exact capacity and advertises 1M when supported", () => {
    assert.equal(budget.contextTokensFor("openai", "codex-large", { oneM: false }), 1048576);
    assert.equal(catalog.context1M("openai", "codex-large"), true);
    assert.equal(budget.contextTokensFor("openai", "codex-small", {}), 272000);
  });
  await check("Custom endpoint context metadata survives discovery", async () => {
    await catalog.discover("custom", { customEndpoints: [{ id: "custom-large", contextWindow: 2000000 }] });
    assert.equal(budget.contextTokensFor("custom", "custom-large", { oneM: false }), 2000000);
    assert.equal(budget.contextTokensFor("custom", "remote-model-name", { model: "custom-large", oneM: true }), 2000000);
    assert.equal(catalog.context1M("custom", "custom-large"), true);
  });
  await check("Models without 1M support keep their own context capacity", () => {
    assert.equal(catalog.context1M("anthropic", "claude-haiku-4-5-20251001"), false);
    assert.equal(budget.contextTokensFor("anthropic", "claude-haiku-4-5-20251001", { oneM: false }), 200000);
  });
  await check("Codex normalization reads the larger supported maximum independently of its default", () => {
    const models = require("../src/main/providers/codex-models").normalize([
      { slug: "large", context_window: 272000, max_context_window: 1050000 },
      { slug: "account-large", context_window: 272000, max_context_window: 872000 },
      { slug: "small", context_window: 128000 },
      { slug: "invalid", context_window: 128000, max_context_window: Infinity }
    ]);
    assert.deepEqual(models.map((m) => m.ctx), [1050000, 872000, 128000, 128000]);
    assert.equal(models[0].defaultCtx, 272000);
  });
  await check("The Codex SDK fallback configures context and compaction on start and resume", async () => {
    const requests = []; let config;
    class Codex {
      constructor(opts) { config = opts.config; }
      startThread(opts) { requests.push({ opts, config }); return { id: "native", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: {} }; })() }) }; }
      resumeThread(_id, opts) { return this.startThread(opts); }
    }
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src/main/providers/codex-exec.js"), "utf8") + "\n_sdk = fake;", {
      module: mod, require: (id) => id === "./codex-appserver" ? { webSearchMode: () => null } : require(id), fake: { Codex }, process, console
    });
    for (const resumeId of [null, "native"]) assert.equal((await mod.exports.run({ model: "large", contextWindow: 1050000, promptText: "Continue", resumeId })).ok, true);
    for (const r of requests) { assert.equal(r.config.model_context_window, 1050000); assert.equal(r.config.model_auto_compact_token_limit, 945000); }
    assert.equal(requests.length, 2);
  });
  await check("Exec turn acceptance is emitted after the thread identity, even when the turn later fails", async () => {
    const events = [], mod = { exports: {} };
    class Codex { startThread() { return { id: "created-thread", runStreamed: async () => ({ events: (async function* () {
      yield { type: "thread.started" }; yield { type: "turn.started" }; yield { type: "turn.failed", error: { message: "later failure" } };
    })() }) }; } }
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src/main/providers/codex-exec.js"), "utf8") + "\n_sdk = fake;", {
      module: mod, require: (id) => id === "./codex-appserver" ? { webSearchMode: () => null } : require(id), fake: { Codex }, process, console
    });
    const result = await mod.exports.run({ promptText: "Work", on: { onThreadId: () => events.push("thread"), onTurnStarted: () => events.push("accepted") } });
    assert.deepEqual(events, ["thread", "accepted"]); assert.equal(result.ok, false);
  });
  await check("Capability snapshots remain serializable", () => {
    assert.ok(structuredClone(catalog.catalog()).anthropic.models.length);
  });
  console.log(`Model context: ${passed} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
