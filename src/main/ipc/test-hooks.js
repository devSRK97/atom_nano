"use strict";
/* IPC: test-only hooks — the test:* handlers, registered only under ATOMNANO_TEST, that give the
 * smoke tests deterministic fakes (fleet runner, council, image generation, model discovery, the Test
 * Director agent) and probes (settings scope, user-data bundle, AST) without a live model. */
const os = require("os");
const fs = require("fs");
const store = require("../storage/store");
const claude = require("../session/index");
const fleet = require("../agents/fleet");
const zipper = require("../workspace/zipper");
const { buildUserdataBundle, applyUserdataBundle } = require("./settings");

function register(ctx) {
  const { handle, createWindow } = ctx;
  // ---- test-only hooks (deterministic fleet/heal without a live model) ----
  // A scripted ACP agent (transport) for the Gemini primary test: speaks the
  // same JSON-RPC the real CLI does — streams text + a thought, opens a tool
  // call, asks permission, writes a file via fs/write_text_file, then ends.
  function makeFakeAcp() {
    let onLine = null, onClose = null, aid = 0;
    const pending = {};
    const emit = (o) => setImmediate(() => onLine && onLine(JSON.stringify(o)));
    const notify = (method, params) => emit({ jsonrpc: "2.0", method, params });
    const request = (method, params, cb) => { const id = "a" + (++aid); pending[id] = cb; emit({ jsonrpc: "2.0", id, method, params }); };
    const upd = (update) => notify("session/update", { sessionId: "s1", update });
    return {
      write: (s) => {
        let m; try { m = JSON.parse(s); } catch { return; }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending[m.id]) { const cb = pending[m.id]; delete pending[m.id]; cb(m.result); return; }
        if (m.method === "initialize") return emit({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
        if (m.method === "session/new") return emit({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
        // Resume: replay one history chunk (the client must SUPPRESS it), then ack.
        if (m.method === "session/load") { upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED HISTORY — should be suppressed" } }); return emit({ jsonrpc: "2.0", id: m.id, result: null }); }
        if (m.method === "session/prompt") {
          const pid = m.id;
          global.__geminiPromptBlocks = (m.params && m.params.prompt) || null;   // capture for attachment assertions
          upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering the request…" } });
          upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
          upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from Gemini" } });
          upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Write out.txt", kind: "edit", status: "pending", locations: [{ path: "out.txt" }], rawInput: { file_path: "out.txt", content: "hi" } });
          request("session/request_permission", { sessionId: "s1", toolCall: { title: "Write out.txt", kind: "edit", rawInput: { file_path: "out.txt", content: "hi" } }, options: [{ optionId: "allow1", kind: "allow_once", name: "Allow" }, { optionId: "reject1", kind: "reject_once", name: "Reject" }] }, (result) => {
            global.__geminiPerm = result && result.outcome;
            const allowed = result && result.outcome && result.outcome.outcome === "selected" && /allow/i.test(result.outcome.optionId || "");
            if (allowed) {
              request("fs/write_text_file", { sessionId: "s1", path: "out.txt", content: "hi from gemini" }, () => {
                upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "wrote out.txt" } }] });
                emit({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn" } });
              });
            } else {
              upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
              emit({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn" } });
            }
          });
          return;
        }
        if (m.id !== undefined) emit({ jsonrpc: "2.0", id: m.id, result: null });
      },
      onLine: (cb) => { onLine = cb; },
      onClose: (cb) => { onClose = cb; },
      kill: () => { if (onClose) onClose(0); },
    };
  }
  if (process.env.ATOMNANO_TEST) {
    handle("test:fleet-fake-runner", async (_e, holdMs) => {
      // A runner that simulates an agent editing the file named in its prompt
      // ("edit <relpath>"), exercising the FileLockManager without the SDK.
      const testLog = (global.__fleetTestLog = []);
      fleet.configure({ runner: (sessionId, opts) => new Promise((resolve) => {
        const cwd = (store.getSession(sessionId) || {}).cwd || "";
        const m = /edit\s+(\S+)/i.exec(opts.text || "");
        if (m && opts.canUseToolOverride) {
          const file = cwd.replace(/[\\/]+$/, "") + "/" + m[1];
          const dec = opts.canUseToolOverride("Edit", { file_path: file });
          testLog.push({ sessionId, file: m[1], behavior: dec && dec.behavior });
        }
        setTimeout(resolve, holdMs || 250);
      }) });
      return true;
    });
    handle("test:fleet-log", async () => global.__fleetTestLog || []);
    handle("test:council-runner", async () => { require("../providers/council").setRunner(async (provider, model, prompt) => ({ ok: true, text: `[${provider}/${model || "default"}] ${/proposed this answer/.test(prompt) ? "REVIEW" : "ADVICE"}: noted` })); return true; });
    handle("test:council-consult", async (_e, cwd, reviewers, prompt) => {
      const sess = store.createSession({ cwd: cwd || os.homedir(), name: "council" });
      const full = store.getSession(sess.id);
      // seed a prior exchange so we can verify the reviewer is given context
      full.messages.push({ id: store.uid(), role: "assistant", text: "DevOps is a culture bridging dev and ops.", ts: store.nowISO() });
      full.messages.push({ id: store.uid(), role: "user", text: prompt || "", ts: store.nowISO() });
      const digest = await claude.consultReviewers(full, reviewers || [], prompt || "");
      return { digest, messages: full.messages.filter((m) => m.role === "reviewer").map((m) => ({ provider: m.reviewProvider, model: m.reviewModel, kind: m.reviewKind, text: m.text, asked: m.asked })) };
    });
    handle("test:council-review", async (_e, cwd, reviewers, prompt, answer) => {
      const sess = store.createSession({ cwd: cwd || os.homedir(), name: "council2" });
      const full = store.getSession(sess.id);
      full.messages.push({ id: store.uid(), role: "assistant", text: answer || "the answer", ts: store.nowISO() });
      await claude.reviewAfter(full, reviewers || [], prompt || "");
      return { messages: full.messages.filter((m) => m.role === "reviewer").map((m) => ({ provider: m.reviewProvider, model: m.reviewModel, kind: m.reviewKind, text: m.text })) };
    });
    // Gemini primary — drive the REAL GeminiClient over a scripted in-process ACP
    // agent (no live CLI). Exercises JSON-RPC framing, streaming, tool cards,
    // the permission round-trip, and client-side fs writes.
    handle("test:last-run-payload", async () => global.__lastRunPayload || null);
    handle("test:clear-last-run-payload", async () => { global.__lastRunPayload = null; return true; });
    // Pin/unpin a fake live runner so claude.isRunning(id) reports a busy session —
    // lets tests exercise the queue-dispatch readiness gate without a real SDK turn.
    handle("test:fake-running", async (_e, id, on) => {
      if (on) claude.runners.set(id, { running: true, fake: true });
      else { const r = claude.runners.get(id); if (r && r.fake) claude.runners.delete(id); }
      return claude.isRunning(id);
    });
    handle("test:new-pick-window", async () => { createWindow(null, { pick: true }); return true; });
    handle("test:settings-scope", async () => {
      const A = "/tmp/projA", B = "/tmp/projB";
      store.saveSettings({ llmProvider: "google", defaultModel: "gemini-3.1-pro-preview", theme: "blue" }, A);
      store.saveSettings({ llmProvider: "openai", defaultModel: "gpt-5.5", theme: "rose", apiKey: "sk-secret-xyz" }, B);
      const a = store.getSettings(A), b = store.getSettings(B), g = store.getSettings();
      return { aProvider: a.llmProvider, aModel: a.defaultModel, aTheme: a.theme, bProvider: b.llmProvider, bModel: b.defaultModel, bTheme: b.theme, globalApiKey: g.apiKey, aSeesGlobalKey: a.apiKey, aHasProvider: "llmProvider" in (store.getSettings().projectSettings || {}) };
    });
    handle("test:imagegen-fake", async (_e, fail, vector) => {
      const ig = require("../providers/image-gen");
      if (vector) {
        ig.setBackend(null);
        ig.setTextRunner(async () => fail ? { ok: false, error: "the model's CLI isn't authorized" } : { ok: true, text: 'Sure: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1a1a"/><circle cx="32" cy="28" r="14" fill="#f0a94e"/></svg> there you go.' });
      } else {
        ig.setBackend(async ({ prompt }) => { if (fail) throw new Error("Add an OpenAI API key (with image access) in Settings → Providers."); return [{ data: "R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", mediaType: "image/gif" }]; });
      }
      return true;
    });
    handle("test:openai-run", async (_e, cwd, text) => {
      require("../providers/council").setRunner(async (provider, model, prompt, opts) => ({ ok: true, text: `[${provider}/${model}] effort=${opts && opts.effort} :: ${/extend/.test(prompt) ? "extended" : "answered"}` }));
      store.saveSettings({ llmProvider: "openai", defaultModel: "gpt-5.5", defaultThinking: "high" });
      const sess = store.createSession({ cwd: cwd || os.homedir(), name: "openai" });
      await claude.run(sess.id, { text: text || "extend to 120 words", model: "gpt-5.5", thinking: "high" });
      const full = store.getSession(sess.id);
      return { msgs: full.messages.map((m) => ({ role: m.role, text: (m.text || "").slice(0, 90), provider: m.meta && m.meta.provider })), lastRun: claude._lastRun && claude._lastRun.sent };
    });
    handle("test:discover-fake", async (_e, provider) => {
      require("../providers/catalog").setModelFetcher(async (prov) => prov === "openai" ? [{ id: "gpt-6-turbo", name: "GPT-6 Turbo" }, { id: "gpt-5.5", name: "GPT-5.5" }] : prov === "google" ? [{ id: "gemini-4.0-pro", name: "Gemini 4.0 Pro", ctx1m: true }] : []);
      return require("../providers/catalog").discover(provider, { keys: { openai: "k", google: "k" } });
    });
    // (Gemini / Antigravity and local-optimizer test handlers were removed with those integrations.)
    // `arg` is the zip path, or { path, includeSessions } for the full bundle (the bridge forwards one
    // argument). `skills` is the bundle's per-project skill-file count — the backup inventory the
    // export smoke checks (the skill store itself is the Workflow Studio's).
    handle("test:userdata-export", async (_e, arg) => {
      const { path: p, includeSessions } = typeof arg === "string" ? { path: arg } : (arg || {});
      const b = buildUserdataBundle({ includeSessions: !!includeSessions });
      fs.writeFileSync(p, b.buf);
      const unz = zipper.unzip(b.buf);
      const names = unz.map((f) => f.name.replace(/\\/g, "/"));
      const pe = unz.find((f) => /preferences\.json$/.test(f.name));
      const prefs = pe ? JSON.parse(pe.data.toString("utf8")) : {};
      return { sessions: b.sessions, skills: b.skills, names, prefKeys: Object.keys(prefs), hasSecret: prefs.apiKey !== undefined, hasSubAgents: prefs.subAgents !== undefined };
    });
    handle("test:userdata-import", async (_e, p) => applyUserdataBundle(fs.readFileSync(p)));
    handle("test:ast", async (_e, kind, source) => {
      const ast = require("../lang/ast");
      if (kind === "available") return ast.available();
      if (kind === "classify") return ast.classify(source, "probe.tsx");
      if (kind === "assertions") return ast.assertions(source, "probe.ts");
      if (kind === "mutate") return ast.mutate(source, 8);
      if (kind === "imports") return ast.imports(source, "probe.ts");
      return null;
    });
    // Drive the goal→green orchestrator deterministically with a scripted "agent".
    handle("test:director-scenario", async (_e, cwd, scenario) => {
      const fsx = require("fs"), p = require("path");
      const td = require("../testing/testdir");
      const calc = p.join(cwd, "calc.js"), test = p.join(cwd, "calc.test.js");
      require("../testing/director").setAgentRunner(async (ctx) => {
        if (ctx.role === "tester") {
          // "weak" → a test with no real assertion; others → a real assertion on add()
          const body = scenario === "weak"
            ? "process.exit(0)\n"
            : "const c=require('./calc'); if(c.add(2,3)!==5){console.error('add wrong');process.exit(1)} process.exit(0)\n";
          fsx.writeFileSync(test, body);
          const up = td.upsert(cwd, { title: "add works", adapter: "node", category: "regression", file: "calc.test.js", coveredFiles: [cwd + "/calc.js"], bulletIds: scenario === "ambiguous" ? [] : (ctx.spec || []).map((b) => b.id) });
          if (up.ok) td.attachTest(cwd, ctx.goalId, up.test.id);
        } else if (ctx.role === "builder") {
          fsx.writeFileSync(calc, scenario === "weak" ? "exports.add=(a,b)=>a + b;\n" : "exports.add=(a,b)=>a + b + 1;\n");
        } else if (ctx.role === "fixer") {
          if (scenario !== "exhausted") fsx.writeFileSync(calc, "exports.add=(a,b)=>a + b;\n");
        }
      });
      return true;
    });
  }
}

module.exports = { register };
