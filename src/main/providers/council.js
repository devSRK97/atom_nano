"use strict";
/* MODEL COUNCIL — run OTHER providers as REVIEWERS via their CLIs, non-interactively.
 *
 *  - CONSULT-BEFORE: reviewers advise on the user's request; their input is
 *    injected so the primary (Claude) weighs it before answering.
 *  - REVIEW-AFTER: the primary answers, then each reviewer critiques the answer.
 *
 * Google reviewer support (agy / Antigravity CLI) has been REMOVED — the legacy
 * Gemini CLI is end-of-life (2026-06-18) and the agy integration is no longer
 * maintained here. Only OpenAI (Codex) and Anthropic (Claude) reviewers are
 * supported now. runnerImpl is injectable so the orchestration is testable
 * without the CLIs.
 */
const { spawn, execSync } = require("child_process");

let runnerImpl = null;
function setRunner(fn) { runnerImpl = fn; }   // (provider, model, prompt) => Promise<{ ok, text, error }>

// The executable + base flags per provider. Overridable for tests (point at a
// fake echo binary to prove the prompt is delivered intact).
const BINS = { openai: ["codex", "exec", "--skip-git-repo-check"], anthropic: ["claude"] };
function setBins(obj) { if (obj) for (const k of Object.keys(obj)) BINS[k] = obj[k]; }

// Which CLIs are available (cached; injectable for tests).
let detectImpl = null;
function setDetect(fn) { detectImpl = fn; }
let _present = null;
function present() {
  if (detectImpl) return detectImpl();
  if (_present) return _present;
  _present = {};
  for (const b of ["codex", "claude"]) {
    try { execSync(`${process.platform === "win32" ? "where" : "command -v"} ${b}`, { stdio: "ignore", timeout: 3000, windowsHide: true }); _present[b] = true; }
    catch { _present[b] = false; }
  }
  return _present;
}

// Strip CLI banners / warnings and (for Codex) pull out just the response body.
function cleanCodex(s) {
  let t = String(s || "");
  const i = t.lastIndexOf("\ncodex\n");
  if (i >= 0) { t = t.slice(i + 7); const j = t.indexOf("\ntokens used"); if (j >= 0) t = t.slice(0, j); }
  return t.trim();
}
// Claude print mode (`claude -p`) emits just the answer — only whitespace to trim.
function cleanClaude(s) { return String(s || "").trim(); }
function cleanFor(provider, out) { return provider === "openai" ? cleanCodex(out) : cleanClaude(out); }

// Spawn a process with the prompt ALWAYS via stdin (a multi-line prompt passed as
// a cmd.exe arg gets mangled — the old "How can I help…" bug). `file`+`args` are
// spawned directly; npm-shim CLIs go through cmd.exe (see spawnCli). Returns
// { ok, text, error }.
function runProc(file, args, stdin, cleanKey, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, args, { windowsHide: true }); } catch (e) { resolve({ ok: false, error: String(e.message || e) }); return; }
    let out = "", err = "", done = false, timer = null;
    const finish = (ok) => { if (done) return; done = true; if (timer) clearTimeout(timer); const text = cleanFor(cleanKey, out); resolve({ ok: ok && !!text, text, error: ok ? "" : (err.slice(-400) || "no output") }); };
    if (stdin != null && child.stdin) { try { child.stdin.write(stdin); child.stdin.end(); } catch { /* ignore */ } }
    child.stdout && child.stdout.on("data", (d) => { out += d; });
    child.stderr && child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); } });
    child.on("close", (code) => finish(code === 0));
    timer = setTimeout(() => { if (!done) { try { child.kill(); } catch { /* */ } finish(false); } }, timeoutMs || 180000);
  });
}
// npm-shim CLIs (codex/claude are .cmd on Windows) → run via cmd.exe /c there; spawned directly elsewhere.
function spawnCli(inner, stdin, cleanKey, timeoutMs) { const c = require("../platform").cliCommand(inner[0], inner.slice(1)); return runProc(c.file, c.args, stdin, cleanKey, timeoutMs); }

async function cli(provider, model, prompt, timeoutMs = 180000, opts = {}) {
  // Clamp to the ladder THIS Codex model accepts (max/ultra → xhigh below GPT-5.6,
  // minimal → low, Claude-side names mapped) — an unsupported level fails the run.
  if (provider === "openai") { const P = require("./catalog"); model = P.resolveOpenAIModel(model).model; }   // an id the installed Codex accepts
  const eff = opts.effort ? require("./catalog").openaiEffort(opts.effort, model) : null;
  if (provider === "openai") return spawnCli([...BINS.openai, ...(model ? ["-m", model] : []), ...(eff ? ["-c", `model_reasoning_effort="${eff}"`] : []), "-"], prompt, "openai", timeoutMs);
  if (provider === "anthropic") return spawnCli([...BINS.anthropic, "-p", ...(model ? ["--model", model] : [])], prompt, "anthropic", timeoutMs);
  if (provider === "google") return { ok: false, error: "Google (Antigravity / agy) reviewer support has been removed from this build. Use Anthropic or OpenAI." };
  return { ok: false, error: "unsupported reviewer provider: " + provider };
}

async function reviewerRun(provider, model, prompt, opts = {}) {
  try {
    const r = runnerImpl ? await runnerImpl(provider, model, prompt, opts) : await cli(provider, model, prompt, 180000, opts);
    return r && typeof r === "object" ? r : { ok: false, error: "no result" };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

const PROVIDER_LABEL = { openai: "Codex (OpenAI)", anthropic: "Claude (Anthropic)" };
function label(provider, model) { return (PROVIDER_LABEL[provider] || provider) + (model ? " · " + model : ""); }

module.exports = { reviewerRun, setRunner, setBins, setDetect, present, label };
