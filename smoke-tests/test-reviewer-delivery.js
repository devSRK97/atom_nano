/* PROOF that the reviewer prompt is delivered intact.
 *
 * The "How can I help you today?" bug was Gemini receiving a BROKEN prompt: the
 * multi-line prompt was passed as a cmd.exe command-line ARG, which cmd mangles
 * at the first newline/quote. The fix routes the prompt through STDIN (like
 * Codex). This test runs the REAL council.cli path against a fake "gemini" that
 * echoes back what it received, and shows:
 *   • via stdin (the fix) → the full multi-line prompt arrives intact
 *   • via a -p arg (the old way) → it gets truncated at the first newline
 *
 * Pure Node (real subprocess via cmd.exe) — no Electron, no live CLI.
 */
"use strict";
const path = require("path");
const council = require("../src/main/council.js");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };

const ECHO_STDIN = path.join(__dirname, "fixtures", "echo-stdin.js");
const ECHO_ARGS = path.join(__dirname, "fixtures", "echo-args.js");
const ECHO_EMPTY = path.join(__dirname, "fixtures", "echo-empty.js");

// A realistic reviewer prompt: multi-line, with quotes — exactly what mangles.
const PROMPT = [
  "Conversation so far:",
  'Assistant: "DevOps is a culture bridging dev and ops."',
  "",
  'The user now asks: """extend to 150"""',
  "",
  "In 2-5 sentences, give concrete advice. Do NOT reply to the user yourself.",
].join("\n");

(async () => {
  if (process.platform !== "win32") { console.log("SKIP: cmd.exe path is Windows-only"); return; }

  /* ---- THE FIX: prompt via stdin (point the CLI at the echo-stdin fixture) ---- */
  council.setDetect(() => ({ gemini: true, agy: false }));
  council.setBins({ gemini: ["node", ECHO_STDIN] });
  const viaStdin = await council.reviewerRun("google", null, PROMPT);
  ok(viaStdin.ok, "google reviewer ran (fake CLI)");
  ok(viaStdin.text.includes("Conversation so far") && viaStdin.text.includes("extend to 150") && viaStdin.text.includes("Do NOT reply"), "the FULL multi-line prompt reaches the reviewer via stdin (fix)");
  ok(viaStdin.text.split("\n").length >= 5, `all lines delivered, not truncated (${viaStdin.text.split("\n").length} lines)`);

  /* ---- MIGRATION: Antigravity (agy) is preferred over gemini ---- */
  council.setDetect(() => ({ agy: true, gemini: true }));
  council.setBins({ agy: ["node", ECHO_STDIN], gemini: ["node", ECHO_ARGS] });   // agy echoes stdin; gemini would mangle
  const viaAgy = await council.reviewerRun("google", null, PROMPT);
  ok(viaAgy.ok && viaAgy.text.includes("extend to 150") && viaAgy.text.split("\n").length >= 5, "Antigravity (agy) is used first and gets the full prompt via stdin");

  /* ---- FALLBACK: agy returns nothing (its non-TTY stdout bug) → use gemini ---- */
  council.setBins({ agy: ["node", ECHO_EMPTY], gemini: ["node", ECHO_STDIN] });
  const fellBack = await council.reviewerRun("google", null, PROMPT);
  ok(fellBack.ok && fellBack.text.includes("extend to 150"), "falls back to gemini when agy yields no output (stdout bug-safe)");

  /* ---- THE OLD BUG: same prompt as a -p arg gets mangled at the first newline ---- */
  const { spawn } = require("child_process");
  const mangled = await new Promise((res) => {
    const c = spawn("cmd.exe", ["/c", "node", ECHO_ARGS, "-p", PROMPT], { windowsHide: true });
    let o = ""; c.stdout.on("data", (d) => { o += d; }); c.on("close", () => res(o));
  });
  ok(!mangled.includes("extend to 150") || mangled.split("\n").length < PROMPT.split("\n").length, `old -p-arg path is mangled/truncated by cmd.exe (got ${mangled.split("\n").length} of ${PROMPT.split("\n").length} lines)`);

  /* ---- Codex/OpenAI already used stdin — confirm it still delivers intact ---- */
  council.setBins({ openai: ["node", ECHO_STDIN] });
  const oa = await council.reviewerRun("openai", null, PROMPT);
  ok(oa.text.includes("Conversation so far") && oa.text.includes("extend to 150"), "Codex/OpenAI reviewer also gets the full prompt via stdin");

  console.log(process.exitCode ? "\nSOME REVIEWER-DELIVERY TESTS FAILED" : "\nALL REVIEWER-DELIVERY TESTS PASSED");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
