"use strict";
/* AtomNano CLI — headless access to the SAME providers, models, custom endpoints,
 * keys and run options the GUI uses. Runs inside the Electron app process (so it
 * reads the exact same userData / settings), but with no window, no IPC, no session
 * store. Designed to be invoked by other processes / scripts.
 *
 *   atomnano run "your prompt"           # use the configured primary provider/model
 *   atomnano run -m glm-5.3 "..."        # pick a model (incl. a custom endpoint id)
 *   atomnano run -P custom "..."         # force a provider
 *   atomnano run -t ultrathink "..."     # thinking / effort level
 *   atomnano run --1m "..."              # 1M-token context (Claude)
 *   atomnano run --agent "..."           # allow tools (agentic); default is text-only
 *   echo "hi" | atomnano run             # prompt from stdin
 *   atomnano providers | models | endpoints
 */
// Loaded lazily so this module also `require()`s cleanly under plain Node (the
// store reads Electron's userData path at load time, which only exists in the app).
function store() { return require("../main/store"); }

const HELP = `AtomNano CLI — your configured AI providers from the command line.

USAGE
  atomnano run [options] [prompt]      Run one turn (prompt from args or stdin)
  atomnano ask  [options] [prompt]     Alias of run
  atomnano providers                   List providers and which are authorized
  atomnano models  [-P provider]       List available models (incl. custom endpoints)
  atomnano endpoints                   List configured custom API endpoints
  atomnano version | --version
  atomnano help | --help

RUN OPTIONS
  -P, --provider <id>     anthropic | openai | google | custom  (default: configured primary)
  -m, --model <id>        Model id, or a custom endpoint id/name
  -t, --thinking <level>  off | think | think-hard | think-harder | ultrathink
      --effort <level>    Alias of --thinking (low|medium|high|xhigh|max|ultra for OpenAI; clamped to the model)
      --1m                Use the 1,000,000-token context window (Claude)
  -s, --system <text>     Extra system instructions
      --agent             Allow tool use (file edits, bash, …). Default: text only.
      --cwd <dir>         Working directory (default: current)
      --json              Emit {provider,model,text} as JSON
      --no-stream         Buffer the whole reply, print at the end

CONTEXT (read files/code — works for every provider)
  -f, --file <path>       Include a file's contents (repeatable)
  -d, --dir <path>        Include code/text files from a directory (repeatable)
      @path               Mention a path in the prompt to include it, e.g. "explain @src/app.js"
      --max-tokens <n>    Input context budget in tokens (default 24000; ~4 chars/token)
      --max-bytes <n>     Hard byte cap for inlined context (overrides --max-tokens)
      --context-window <n> Total token window assumed when sizing context (default 32000)
  # Files are bounded so they never exceed the budget — for custom endpoints the
  # output max_tokens in your payload JSON is subtracted so the request can't explode.

Reads settings, API keys and custom endpoints from the AtomNano app — configure
them once in the app (Settings -> Providers), then use them anywhere.`;

const MULTI = new Set(["file", "dir"]);   // repeatable flags accumulate into arrays
function assignFlag(flags, key, val) {
  if (MULTI.has(key)) { (flags[key] = flags[key] || []).push(val); } else flags[key] = val;
}
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const aliases = { P: "provider", m: "model", t: "thinking", s: "system", h: "help", f: "file", d: "dir" };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--cli") continue;
    if (a.startsWith("--")) {
      let key = a.slice(2);
      if (key === "1m" || key === "oneM") { flags.oneM = true; continue; }
      if (key === "agent") { flags.agent = true; continue; }
      if (key === "json") { flags.json = true; continue; }
      if (key === "no-stream") { flags.stream = false; continue; }
      if (key === "stream") { flags.stream = true; continue; }
      if (key === "help") { flags.help = true; continue; }
      if (key === "version") { flags.version = true; continue; }
      if (key === "effort") key = "thinking";
      // value-taking long flags
      const next = argv[i + 1];
      if (next != null && !next.startsWith("-")) { assignFlag(flags, key, next); i++; } else flags[key] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      const k = aliases[a.slice(1)] || a.slice(1);
      if (k === "help") { flags.help = true; continue; }
      const next = argv[i + 1];
      if (next != null && !next.startsWith("-")) { assignFlag(flags, k, next); i++; } else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift() || "";
  return { cmd, prompt: positional.join(" "), flags };
}

// ---- File/dir context: read code/text and inline it so ANY provider (incl. raw
// custom endpoints that can't use tools) can "see" the files you point it at. ----
const _fs = require("fs");
const _path = require("path");
const TEXT_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|md|markdown|txt|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|css|scss|sass|less|html|htm|vue|svelte|yml|yaml|toml|ini|cfg|conf|sh|bash|zsh|sql|xml|csv|env|gradle|proto|graphql|gql|swift|m|lua|r|pl|dart)$/i;
const IGNORE_DIR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", ".cache", "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode", "target", "bin", "obj"]);

function readFileSafe(p, perCap) {
  try {
    const b = _fs.readFileSync(p);
    if (b.length && b.includes(0)) return null;     // looks binary
    let t = b.toString("utf8");
    if (t.length > perCap) t = t.slice(0, perCap) + "\n… (truncated)";
    return t;
  } catch { return null; }
}
function walkDir(dir, out, budget) {
  if (budget.files <= 0 || budget.bytes <= 0) return;
  let entries; try { entries = _fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.files <= 0 || budget.bytes <= 0) return;
    const full = _path.join(dir, e.name);
    if (e.isDirectory()) { if (IGNORE_DIR.has(e.name) || e.name.startsWith(".")) continue; walkDir(full, out, budget); }
    else if (e.isFile() && (TEXT_EXT.test(e.name) || /^(dockerfile|makefile|readme|license)$/i.test(e.name))) {
      const t = readFileSafe(full, budget.bytes);   // per-file capped only by the remaining total budget
      if (t != null) { out.push({ path: full, text: t }); budget.files--; budget.bytes -= t.length; }
    }
  }
}
function atMentions(prompt, cwd) {
  const found = [];
  const re = /(?:^|\s)@([^\s"']+)/g; let m;
  while ((m = re.exec(prompt || ""))) {
    try { const p = _path.resolve(cwd, m[1]); if (_fs.existsSync(p)) found.push({ p, isDir: _fs.statSync(p).isDirectory() }); } catch { /* */ }
  }
  return found;
}
// Compute a safe byte budget for inlined file context (≈4 chars/token) so the
// request can't explode the model's window. Honors --max-bytes / --max-tokens,
// and for custom endpoints subtracts the output `max_tokens` configured in the
// payload JSON from a conservative window so input + output fits.
const CHARS_PER_TOKEN = 4;
function inputByteBudget(args, s, provider, model, prompt, userSystem) {
  if (args.flags["max-bytes"]) return Math.max(2000, +args.flags["max-bytes"] || 0);
  let inputTokens;
  if (args.flags["max-tokens"]) {
    inputTokens = +args.flags["max-tokens"];        // explicit → authoritative
  } else if (args.flags.oneM) {
    inputTokens = +args.flags["context-window"] || 900000;   // --1m → use a big window (e.g. GLM 1M)
  } else {
    inputTokens = 24000;                            // safe default
    const window = +args.flags["context-window"] || 32000;
    if (provider === "custom") {
      // Reserve the endpoint's output max_tokens (from the payload JSON) so the
      // request can't exceed a conservative window.
      try {
        const customApi = require("../main/customApi");
        const ep = customApi.getEndpoint(s, model) || customApi.listEndpoints(s)[0];
        const body = ep ? JSON.parse(ep.payloadTemplate || "{}") : {};
        const outTok = +(body.max_tokens || body.maxOutputTokens || body.max_output_tokens || 0);
        if (outTok > 0) inputTokens = Math.min(inputTokens, Math.max(2000, window - outTok - 1000));
      } catch { /* keep default */ }
    }
  }
  // Leave room for the prompt + any --system already counted toward the budget.
  const usedTokens = Math.ceil(((prompt || "").length + (userSystem || "").length) / CHARS_PER_TOKEN);
  inputTokens = Math.max(1000, inputTokens - usedTokens);
  return inputTokens * CHARS_PER_TOKEN;
}
function gatherContext({ files = [], dirs = [], cwd, maxBytes = 96000 }) {
  const out = [];
  const budget = { files: 60, bytes: maxBytes };
  for (const f of files) {
    const p = _path.resolve(cwd, f);
    let st; try { st = _fs.statSync(p); } catch { err(`atomnano: not found — ${f}\n`); continue; }
    if (st.isDirectory()) { walkDir(p, out, budget); continue; }
    const t = readFileSafe(p, Math.min(60000, budget.bytes));
    if (t != null) { out.push({ path: p, text: t }); budget.files--; budget.bytes -= t.length; }
    else err(`atomnano: couldn't read (binary?) — ${f}\n`);
  }
  for (const d of dirs) { const p = _path.resolve(cwd, d); walkDir(p, out, budget); }
  if (!out.length) return { text: "", count: 0, truncated: false };
  const rel = (p) => _path.relative(cwd, p) || p;
  const blocks = out.map((o) => `--- ${rel(o.path)} ---\n${o.text}`).join("\n\n");
  return { text: "Files provided as context:\n\n" + blocks, count: out.length, truncated: budget.files <= 0 || budget.bytes <= 0 };
}

function readStdin() {
  // The launcher forwards piped stdin via this env var (reliable across the hop).
  if (process.env.ATOMNANO_STDIN != null) return Promise.resolve(process.env.ATOMNANO_STDIN);
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");   // interactive — nothing piped
    let data = "", done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { data += d; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
    setTimeout(finish, 5000);   // generous safety so a stray non-TTY stdin can't hang us
  });
}

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

// ---- commands ----

async function cmdProviders() {
  const auth = require("../main/auth");
  const st = auth.providerAuthStatus();
  const labels = { anthropic: "Anthropic (Claude)", openai: "OpenAI (Codex/GPT)", google: "Antigravity (Google)", custom: "Custom (any API)" };
  const primary = store().getSettings().llmProvider || "anthropic";
  out("Providers:\n");
  for (const id of ["anthropic", "openai", "google", "custom"]) {
    const p = st[id] || {};
    let state;
    if (id === "custom") state = (store().getSettings().customEndpoints || []).length ? "configured" : "no endpoints";
    else state = p.loggedIn ? "authorized" : p.key ? "api key" : "not set";
    out(`  ${id === primary ? "*" : " "} ${id.padEnd(10)} ${labels[id].padEnd(24)} ${state}\n`);
  }
  out("\n* = current primary. Configure in the AtomNano app -> Settings -> Providers.\n");
  return 0;
}

async function cmdModels(flags) {
  const providers = require("../main/providers");
  const s = store().getSettings();
  const provider = flags.provider || s.llmProvider || "anthropic";
  const res = await providers.discover(provider, {
    customModels: s.customModels, customEndpoints: s.customEndpoints,
    keys: { openai: s.openaiApiKey, google: s.geminiApiKey, anthropic: s.apiKey },
  }).catch((e) => ({ models: [], error: e.message }));
  out(`Models for ${provider}:\n`);
  if (!res.models || !res.models.length) { out("  (none — configure this provider in the app)\n"); return 0; }
  for (const m of res.models) out(`  ${m.id === s.defaultModel ? "*" : " "} ${m.id}${m.name && m.name !== m.id ? "  (" + m.name + ")" : ""}${m.desc ? "  - " + m.desc : ""}\n`);
  return 0;
}

async function cmdEndpoints() {
  const customApi = require("../main/customApi");
  const eps = customApi.listEndpoints(store().getSettings());
  if (!eps.length) { out("No custom endpoints configured. Add them in the app -> Settings -> Providers -> Custom.\n"); return 0; }
  out("Custom endpoints:\n");
  for (const e of eps) out(`  ${e.id}\n    name:     ${e.name || e.id}\n    endpoint: ${e.endpoint || "(none)"}\n    model:    ${e.model || "(in payload)"}\n`);
  return 0;
}

async function runTurn(args) {
  const s = store().getSettings(args.flags.cwd || process.cwd());
  const provider = args.flags.provider || s.llmProvider || "anthropic";
  const model = args.flags.model || s.defaultModel || "";
  const thinking = args.flags.thinking || s.defaultThinking || "off";
  const oneM = args.flags.oneM != null ? !!args.flags.oneM : !!s.oneM;
  const cwd = args.flags.cwd || process.cwd();
  let prompt = args.prompt || (await readStdin());
  prompt = String(prompt || "").trim();
  if (!prompt) { err('No prompt. Usage: atomnano run "your question"  (or pipe via stdin)\n'); return 1; }

  // Build context from -f/--file, -d/--dir, and @path mentions in the prompt, so
  // any provider (incl. raw custom endpoints) can read the files/code you point at.
  const userSystem = typeof args.flags.system === "string" ? args.flags.system : "";
  const fileArgs = [].concat(args.flags.file || []);
  const dirArgs = [].concat(args.flags.dir || []);
  for (const m of atMentions(prompt, cwd)) (m.isDir ? dirArgs : fileArgs).push(m.p);
  // Token-aware input budget so big files/dirs can't explode the request. Derived
  // from the model's window minus the configured output max_tokens (read from the
  // custom endpoint's payload JSON). Override with --max-tokens / --max-bytes.
  const maxBytes = inputByteBudget(args, s, provider, model, prompt, userSystem);
  let fileCtx = "";
  if (fileArgs.length || dirArgs.length) {
    const g = gatherContext({ files: fileArgs, dirs: dirArgs, cwd, maxBytes });
    fileCtx = g.text;
    if (g.count) err(`atomnano: included ${g.count} file${g.count === 1 ? "" : "s"} as context (~${Math.round(g.text.length / 4 / 100) / 10}k tokens)${g.truncated ? " — truncated to fit the budget (raise with --max-tokens)" : ""}\n`);
  }
  const system = [userSystem, fileCtx].filter(Boolean).join("\n\n");

  // Streaming only makes sense for the Claude SDK path; the others are batch.
  const wantStream = args.flags.json ? false : (args.flags.stream !== false);

  let text = "";
  try {
    if (provider === "custom") {
      text = await runCustom(s, model, prompt, system);
    } else if (provider === "openai") {
      text = await runCouncil(s, "openai", model, prompt, system, thinking);
    } else if (provider === "google") {
      text = await runCouncil(s, "google", model, prompt, system, thinking);
    } else {
      const claude = require("../main/claude");
      const streaming = wantStream;
      text = await claude.runHeadlessAnthropic({
        settings: s, model, thinking, oneM, system, prompt,
        cwd: args.flags.cwd || process.cwd(),
        allowTools: !!args.flags.agent, stream: streaming,
        onText: streaming ? (d) => out(d) : null,
      });
      if (streaming) { out("\n"); if (args.flags.json) { /* handled below */ } return 0; }
    }
  } catch (e) {
    err("atomnano: " + ((e && e.message) || e) + "\n");
    return 1;
  }

  if (args.flags.json) out(JSON.stringify({ provider, model, text }) + "\n");
  else out(text + (text.endsWith("\n") ? "" : "\n"));
  return 0;
}

async function runCustom(s, model, prompt, system) {
  const customApi = require("../main/customApi");
  const ep = customApi.getEndpoint(s, model) || customApi.listEndpoints(s)[0];
  if (!ep) throw new Error('no custom endpoint configured (run "atomnano endpoints")');
  const r = await customApi.call({
    endpoint: ep.endpoint, headers: ep.headers, payloadTemplate: ep.payloadTemplate,
    outputPath: ep.outputPath, model: ep.model || ep.id, apiKey: ep.apiKey, prompt, system,
  });
  if (!r.ok || !r.text) throw new Error((r.error || "no output") + (r.candidates && r.candidates.length ? "  (detected keys: " + r.candidates.slice(0, 4).map((c) => c.path).join(", ") + ")" : ""));
  return r.text;
}

async function runCouncil(s, provider, model, prompt, system, thinking) {
  const council = require("../main/council");
  const providers = require("../main/providers");
  let m = model;
  if (provider === "openai") m = providers.resolveOpenAIModel(/gpt|^o\d|codex|daybreak/i.test(m || "") ? m : "").model;
  if (provider === "google" && !/gemini/i.test(m || "")) m = providers.get("google").defaultModel;
  const full = system ? system + "\n\n----\n\n" + prompt : prompt;
  const opts = provider === "openai" ? { effort: providers.openaiEffort(thinking, m) } : {};
  const r = await council.reviewerRun(provider, m, full, opts);
  if (!r.ok || !r.text) throw new Error(r.error || "no output");
  return r.text;
}

// ---- entry ----
async function run(rawArgs) {
  try { store().loadSettings(); } catch (e) { err("atomnano: failed to load settings: " + e.message + "\n"); return 1; }
  const args = parseArgs(rawArgs || []);
  if (args.flags.help || args.cmd === "help") { out(HELP + "\n"); return 0; }
  if (args.flags.version || args.cmd === "version") {
    let v = "?"; try { v = require("../../package.json").version; } catch { /* */ }
    out("atomnano " + v + "\n"); return 0;
  }
  switch (args.cmd) {
    case "providers": return cmdProviders();
    case "models": return cmdModels(args.flags);
    case "endpoints": return cmdEndpoints();
    case "run": case "ask": case "chat": case "-p": return runTurn(args);
    default:
      // No subcommand → treat the whole thing as a prompt if there is one.
      if (args.cmd) { args.prompt = (args.cmd + " " + args.prompt).trim(); return runTurn(args); }
      if (!process.stdin.isTTY) return runTurn(args);   // piped prompt
      out(HELP + "\n"); return 0;
  }
}

// Is this process being launched as the CLI (vs the GUI app)?
function isCliInvocation(rawArgs) {
  if (process.env.ATOMNANO_CLI === "1") return true;
  const a = rawArgs || [];
  if (a.includes("--cli")) return true;
  const KNOWN = new Set(["run", "ask", "chat", "providers", "models", "endpoints", "version", "help", "-p"]);
  const first = a.find((x) => !x.startsWith("-")) || (a[0] && a[0].startsWith("-") ? a[0] : "");
  return KNOWN.has(a[0]) || KNOWN.has(first);
}

module.exports = { run, isCliInvocation, parseArgs, inputByteBudget, gatherContext, atMentions };
