"use strict";
/* The integrated terminal's command-exit MARKER parser (src/main/workspace/terminal.js push / partialMarkIndex) —
 * DESIRED behaviour after the 2026-09-18 fix (MARK_RE no longer requires a line break after the marker: Windows
 * ConPTY re-renders with absolute cursor moves instead of "\r\n", so terminal:command-exit never fired there):
 *   · a marker followed by "\r\n", by "\n", by a ConPTY cursor sequence, or by nothing → ONE command-exit each,
 *     the exit code parsed (negative codes too), only the marker text removed from the data stream;
 *   · a marker split across reads at ANY point → exactly one event, the marker never reaches the renderer, the
 *     surrounding output is preserved byte for byte (the line break that belonged to the marker is swallowed
 *     even when it arrives in the next read);
 *   · CHUNK INDEPENDENCE (re-review 2026-09-18): for every stream — marker + "\r\n", + "\n", + "\r" + text, + a
 *     ConPTY cursor move, or the marker last — EVERY way of cutting it into 1, 2 or 3 reads (cuts inside the
 *     marker, between "\r" and "\n", right after the "\r") yields exactly the data of the unsplit read. A "\r"
 *     that arrives alone after a marker is HELD until the next character decides: "\n" → the marker's line break,
 *     swallowed with it; anything else → real output, delivered (`marker | "\r" | "\nnext"` used to leak the "\n",
 *     `marker+"\r" | "next"` used to lose the "\r" that a single read keeps);
 *   · two markers in one read → two events, in order;
 *   · cmd.exe's echo of the typed `echo __ATOM_CMD__9_%ERRORLEVEL%_` line is ordinary output (no event, never
 *     held back in `pend`); a chunk-final marker prefix is held, then completed by the next read.
 * The module is loaded with `electron` stubbed (it does not need it) and node-pty absent (never touched): only the
 * parser runs, on a plain { id, buf, pend } object, the emitter captured through configure().
 * Run: node scripts/test-terminal-marker.js */
const os = require("os");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? os.tmpdir() : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence !== undefined ? JSON.stringify(evidence).slice(0, 700) : ""}`); } }

const terminal = require(path.join(ROOT, "src/main/workspace/terminal.js"));
const { push, partialMarkIndex, MARK_RE, MARK_PREFIX } = terminal.__internals || {};
check("T00", "terminal.js exposes the parser seam (__internals: push, partialMarkIndex, MARK_RE, MARK_PREFIX) and configure(emit)", typeof push === "function" && typeof partialMarkIndex === "function" && MARK_RE instanceof RegExp && MARK_PREFIX === "__ATOM_CMD__" && typeof terminal.configure === "function");
if (typeof push !== "function") { console.log(`\nterminal-marker: ${pass} passed, ${failN} failed\n  ${failures.join("\n  ")}`); process.exit(1); }

// Every event the parser emits, captured; `feed` runs the chunks through ONE fresh terminal object.
let events = [];
terminal.configure({ emit: (name, payload) => events.push({ name, payload }) });
const feed = (chunks) => { events = []; const t = { id: "t1", buf: "", pend: "" }; for (const c of chunks) push(t, c); return t; };
const exits = () => events.filter((e) => e.name === "terminal:command-exit").map((e) => e.payload);
const data = () => events.filter((e) => e.name === "terminal:data").map((e) => e.payload.chunk).join("");
const order = () => events.map((e) => (e.name === "terminal:command-exit" ? "exit:" + e.payload.code : "data"));

// ---- one marker, the four line endings it can have ----
let t = feed(["__ATOM_CMD__7_0_\r\n"]);
check("T01", 'a marker followed by "\\r\\n" → one command-exit (token, code 0), nothing left in the data stream, nothing held', exits().length === 1 && exits()[0].token === "__ATOM_CMD__7" && exits()[0].code === 0 && exits()[0].id === "t1" && data() === "" && t.buf === "" && t.pend === "", { exits: exits(), data: data(), pend: t.pend });
t = feed(["__ATOM_CMD__7_0_\n"]);
check("T02", 'a marker followed by "\\n" → the same', exits().length === 1 && exits()[0].code === 0 && data() === "" && t.pend === "", { exits: exits(), data: data() });
t = feed(["__ATOM_CMD__9_0_\x1b[10;1HE:\\proj>"]);
check("T03", "the ConPTY form (a cursor-positioning sequence right after the marker, no line break) → ONE exit event with code 0; only the marker text is removed, the cursor sequence and the prompt stay in the data", exits().length === 1 && exits()[0].token === "__ATOM_CMD__9" && exits()[0].code === 0 && data() === "\x1b[10;1HE:\\proj>" && t.buf === "\x1b[10;1HE:\\proj>" && t.pend === "", { exits: exits(), data: JSON.stringify(data()) });
t = feed(["__ATOM_CMD__3_-1_\r\n"]);
check("T04", "a negative exit code (__ATOM_CMD__3_-1_) parses as -1", exits().length === 1 && exits()[0].token === "__ATOM_CMD__3" && exits()[0].code === -1 && data() === "", { exits: exits() });
t = feed(["build ok\r\n__ATOM_CMD__4_2_"]);
check("T05", "a marker with NOTHING after it (the read ended exactly there) fires at once — the event is never deferred to the next read — and the output before it is delivered", exits().length === 1 && exits()[0].code === 2 && data() === "build ok\r\n" && t.pend === "", { exits: exits(), data: data(), pend: t.pend });
push(t, "\r\nE:\\proj>");
check("T05b", "…and the line break that belonged to that marker, arriving in the next read, is swallowed too (no blank line where the marker was); the prompt after it passes", data() === "build ok\r\nE:\\proj>" && exits().length === 1, { data: JSON.stringify(data()) });

// ---- a marker split across reads at EVERY cut point ----
const STREAM = "abc\r\n__ATOM_CMD__12_7_\r\nnext";
const splitFailures = [];
for (let i = 0; i <= STREAM.length; i++) {
  t = feed([STREAM.slice(0, i), STREAM.slice(i)]);
  const ex = exits(), d = data();
  const good = ex.length === 1 && ex[0].token === "__ATOM_CMD__12" && ex[0].code === 7 && !d.includes("__ATOM_CMD__") && d === "abc\r\nnext" && t.buf === "abc\r\nnext" && t.pend === "";
  if (!good) splitFailures.push({ cut: i, head: JSON.stringify(STREAM.slice(0, i)), exits: ex, data: JSON.stringify(d), pend: JSON.stringify(t.pend) });
}
check("T06", `a marker split across two reads at every one of the ${STREAM.length + 1} cut points → exactly one command-exit (code 7), "__ATOM_CMD__" never reaches the data stream, "abc\\r\\n" + "next" preserved exactly (the marker's own line break swallowed whichever read it lands in), nothing left held`, splitFailures.length === 0, splitFailures.slice(0, 4));
// three-way splits through the whole stream — the marker body (the partial prefix grows read by read) AND the "\r\n"
// suffix after it (a read may end between the marker and the "\r", or between the "\r" and the "\n")
const tri = [];
for (let i = 0; i <= STREAM.length; i++) for (let j = i + 1; j <= STREAM.length; j++) {
  t = feed([STREAM.slice(0, i), STREAM.slice(i, j), STREAM.slice(j)]);
  if (!(exits().length === 1 && exits()[0].code === 7 && data() === "abc\r\nnext" && t.pend === "")) tri.push({ i, j, data: JSON.stringify(data()), exits: exits() });
}
check("T06b", `a marker arriving in THREE reads (every pair of cuts across the whole ${STREAM.length}-byte stream, the "\\r\\n" suffix included) → still one event, the output intact`, tri.length === 0, tri.slice(0, 4));

// ---- two markers in one read ----
t = feed(["__ATOM_CMD__1_0_\r\n__ATOM_CMD__2_3_\r\n"]);
check("T07", "two markers in one read → two command-exit events, in order (token 1 code 0, then token 2 code 3), no data", exits().length === 2 && exits()[0].token === "__ATOM_CMD__1" && exits()[0].code === 0 && exits()[1].token === "__ATOM_CMD__2" && exits()[1].code === 3 && data() === "", { exits: exits(), data: data() });
t = feed(["one\r\n__ATOM_CMD__5_0_\r\ntwo\r\n__ATOM_CMD__6_1_\x1b[3;1H>"]);
check("T07b", "two markers with output between them → the events interleave with the data in stream order, both texts delivered", exits().map((e) => e.code).join() === "0,1" && data() === "one\r\ntwo\r\n\x1b[3;1H>" && order().join() === "exit:0,exit:1,data", { order: order(), data: JSON.stringify(data()) });

// ---- cmd.exe's echo of the typed line is ordinary output ----
t = feed(["echo __ATOM_CMD__9_%ERRORLEVEL%_\r\n"]);
check("T08", "cmd.exe's echo of the typed `echo __ATOM_CMD__9_%ERRORLEVEL%_` line passes through as data — no event, nothing held back in pend", exits().length === 0 && data() === "echo __ATOM_CMD__9_%ERRORLEVEL%_\r\n" && t.pend === "", { exits: exits(), data: data(), pend: t.pend });
t = feed(["echo __ATOM_CMD__9_", "%ERRORLEVEL%_\r\n", "__ATOM_CMD__9_0_\r\nE:\\proj>"]);
check("T08b", "the typed line split right inside `__ATOM_CMD__9_` is held while it could still become a marker, released as data once `%ERRORLEVEL%` proves it is not; the real marker that follows fires", exits().length === 1 && exits()[0].code === 0 && data() === "echo __ATOM_CMD__9_%ERRORLEVEL%_\r\nE:\\proj>" && t.pend === "", { exits: exits(), data: JSON.stringify(data()), pend: t.pend });

// ---- a partial prefix at a chunk end is held, then completed ----
t = feed(["out\r\n__ATOM_C"]);
const heldData = data(), heldPend = t.pend;
push(t, "MD__5_0_\r\nE:\\proj>");
check("T09", 'the partial prefix "__ATOM_C" at a read\'s end is held (the output before it delivered), then completed by the next read → one event, the prompt after it delivered, no marker text anywhere', heldData === "out\r\n" && heldPend === "__ATOM_C" && exits().length === 1 && exits()[0].token === "__ATOM_CMD__5" && exits()[0].code === 0 && data() === "out\r\nE:\\proj>" && t.pend === "", { heldData, heldPend, exits: exits(), data: data(), pend: t.pend });
t = feed(["done _", "_ATOM_CMD__8_0_\r\n"]);
check("T09b", "a single trailing underscore is held as a possible prefix and completes with the next read", exits().length === 1 && exits()[0].code === 0 && data() === "done ", { exits: exits(), data: data() });
t = feed(["plain text with an under_score\r\n", "and __ATOM_ elsewhere\r\n"]);
check("T09c", "text that cannot continue a marker (an underscore mid-word, a prefix followed by other text) is never held", exits().length === 0 && data() === "plain text with an under_score\r\nand __ATOM_ elsewhere\r\n" && t.pend === "", { data: data(), pend: t.pend });

// ---- partialMarkIndex directly ----
// partialMarkIndex sees the chunk AFTER complete markers were removed: it answers "where does a possible marker start
// at the very end?" — a lone trailing "_" counts (held, released by the next read — T09b / T08b), a line break never does.
check("T10", "partialMarkIndex: the start of a chunk-final prefix / partial marker (digits, `_`, a negative sign, a trailing `_`); -1 when the chunk cannot end in one", partialMarkIndex("abc__ATOM_C") === 3 && partialMarkIndex("abc__ATOM_CMD__") === 3 && partialMarkIndex("abc__ATOM_CMD__12") === 3 && partialMarkIndex("abc__ATOM_CMD__12_") === 3 && partialMarkIndex("abc__ATOM_CMD__12_-") === 3 && partialMarkIndex("abc__ATOM_CMD__12_-1") === 3 && partialMarkIndex("done _") === 5 && partialMarkIndex("abc") === -1 && partialMarkIndex("echo __ATOM_CMD__9_%ERRORLEVEL%_\r\n") === -1 && partialMarkIndex("x\r\n") === -1 && partialMarkIndex("") === -1, { a: partialMarkIndex("abc__ATOM_C"), b: partialMarkIndex("abc__ATOM_CMD__12_-1"), c: partialMarkIndex("done _"), d: partialMarkIndex("echo __ATOM_CMD__9_%ERRORLEVEL%_\r\n") });
check("T11", "MARK_RE does not require a line break after the marker (the ConPTY fix) and still swallows one when present", "__ATOM_CMD__1_0_X".replace(MARK_RE, "") === "X" && "__ATOM_CMD__1_0_\r\nX".replace(MARK_RE, "") === "X" && "__ATOM_CMD__1_0_\nX".replace(MARK_RE, "") === "X" && "__ATOM_CMD__1_0\r\n".replace(MARK_RE, "") === "__ATOM_CMD__1_0\r\n", null);

// ---- CHUNK INDEPENDENCE (re-review 2026-09-18): every 1-, 2- and 3-way split of a stream reads like the unsplit stream ----
// `want` is what the ONE-read parse must produce (asserted first, so the invariant is anchored to a stated byte string, not
// to whatever the parser happens to do); `codes` the exit events, in order. Every cut position is tried, including cuts
// inside the marker, between "\r" and "\n", and right after a "\r" (empty middle reads included — push() ignores them).
const M = "__ATOM_CMD__12_7_";
function everySplit(id, label, S, want, codes = [7]) {
  const bad = [];
  let n = 0;
  const tryChunks = (chunks) => {
    n++;
    t = feed(chunks);
    const ex = exits(), d = data();
    const ok = ex.map((e) => e.code).join() === codes.join() && ex.every((e) => e.token === "__ATOM_CMD__12") && d === want && t.buf === want && t.pend === "" && !d.includes(MARK_PREFIX);
    if (!ok) bad.push({ chunks: chunks.map((c) => JSON.stringify(c)), exits: ex.map((e) => e.code), data: JSON.stringify(d), pend: JSON.stringify(t.pend) });
  };
  tryChunks([S]);
  const unsplitOk = bad.length === 0;
  for (let i = 0; i <= S.length; i++) tryChunks([S.slice(0, i), S.slice(i)]);
  for (let i = 0; i <= S.length; i++) for (let j = i; j <= S.length; j++) tryChunks([S.slice(0, i), S.slice(i, j), S.slice(j)]);
  check(id, `${label}: ${JSON.stringify(S)} read whole → data ${JSON.stringify(want)} and exit ${codes.join(",")}; ALL ${n} ways of cutting it into 1, 2 or 3 consecutive reads give exactly that (${unsplitOk ? "unsplit ok" : "UNSPLIT WRONG"})`, bad.length === 0, bad.slice(0, 5));
}
everySplit("T12", 'marker + "\\r\\n" (a plain PTY / the pipe backend) — the line break is swallowed whichever read(s) it lands in, "next\\r\\n" kept', "out\r\n" + M + "\r\nnext\r\n", "out\r\nnext\r\n");
everySplit("T13", 'marker + "\\r" + text (no "\\n" follows) — the "\\r" is real output: kept in one read, so kept when split (`marker+"\\r" | "next"` used to drop it)', "out\r\n" + M + "\rnext", "out\r\n\rnext");
everySplit("T14", 'marker + "\\n" (LF only)', "out\r\n" + M + "\nnext", "out\r\nnext");
everySplit("T15", "the ConPTY form — a cursor-positioning sequence right after the marker, no line break to swallow: the sequence and the prompt survive intact at every cut", "out\r\n" + M + "\x1b[10;1HE:\\proj>", "out\r\n\x1b[10;1HE:\\proj>");
everySplit("T16", 'marker + "\\r\\r\\n" — only ONE "\\r?\\n" belongs to the marker; the extra "\\r" is output in one read and stays output when the reads end after each "\\r"', "out\r\n" + M + "\r\r\n", "out\r\n\r\r\n");
everySplit("T17", "the marker LAST in the stream, nothing after it — the event fires in the read that completes it, the output before it is delivered, nothing is left held", "out\r\n" + M, "out\r\n");
// …and nothing spurious is emitted afterwards: a lone "\r" then a lone "\n" (the marker's line break in two reads) produce
// no data at all; the prompt that follows arrives clean.
t = feed(["out\r\n" + M]);
const evAfterMarker = events.length;
push(t, "\r"); const evAfterCr = events.length;
push(t, "\n"); const evAfterLf = events.length;
push(t, "E:\\proj>");
check("T17b", 'after a chunk-final marker: a read of just "\\r" emits nothing (held), the "\\n" read emits nothing (the pair was the marker\'s line break), the prompt read is delivered as-is → the renderer sees "out\\r\\nE:\\proj>"', evAfterMarker === 2 && evAfterCr === 2 && evAfterLf === 2 && exits().length === 1 && data() === "out\r\nE:\\proj>" && t.pend === "", { evAfterMarker, evAfterCr, evAfterLf, data: JSON.stringify(data()) });
t = feed(["out\r\n" + M, "\r", "next"]);
check("T17c", 'after a chunk-final marker: a read of just "\\r" then a read "next" → the held "\\r" was real output and comes back before "next" (`marker | "\\r" | "next"` ≡ the single read `marker\\rnext`)', exits().length === 1 && data() === "out\r\n\rnext" && t.pend === "", { data: JSON.stringify(data()) });
// two markers with the second one's line break split — both events in order, one blank line at most where each marker was
const TWO = "a\r\n__ATOM_CMD__12_0_\r\n__ATOM_CMD__12_7_\r\nb";
{
  const bad = [];
  for (let i = 0; i <= TWO.length; i++) {
    t = feed([TWO.slice(0, i), TWO.slice(i)]);
    if (!(exits().map((e) => e.code).join() === "0,7" && data() === "a\r\nb" && t.pend === "")) bad.push({ cut: i, head: JSON.stringify(TWO.slice(0, i)), exits: exits().map((e) => e.code), data: JSON.stringify(data()) });
  }
  check("T18", `two markers back to back, split at every one of the ${TWO.length + 1} cut points → two events in order (0 then 7), data exactly "a\\r\\nb"`, bad.length === 0, bad.slice(0, 4));
}
// random chunkings (seeded, so a failure is reproducible): up to 6 reads of every stream above
{
  let seed = 20260918;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const CASES = [["out\r\n" + M + "\r\nnext\r\n", "out\r\nnext\r\n", "7"], ["out\r\n" + M + "\rnext", "out\r\n\rnext", "7"], ["out\r\n" + M + "\nnext", "out\r\nnext", "7"], ["out\r\n" + M + "\x1b[10;1HE:\\proj>", "out\r\n\x1b[10;1HE:\\proj>", "7"], ["out\r\n" + M + "\r\r\n", "out\r\n\r\r\n", "7"], [TWO, "a\r\nb", "0,7"]];
  const bad = [];
  let runs = 0;
  for (const [S, want, codes] of CASES) for (let k = 0; k < 250; k++) {
    const cuts = [...new Set(Array.from({ length: rnd(6) }, () => rnd(S.length + 1)))].sort((x, y) => x - y);
    const chunks = []; let prev = 0;
    for (const c of cuts) { chunks.push(S.slice(prev, c)); prev = c; }
    chunks.push(S.slice(prev));
    runs++;
    t = feed(chunks);
    if (!(exits().map((e) => e.code).join() === codes && data() === want && t.pend === "")) bad.push({ chunks: chunks.map((c) => JSON.stringify(c)), exits: exits().map((e) => e.code), data: JSON.stringify(data()) });
  }
  check("T19", `${runs} seeded random chunkings (1–6 reads) of the six streams → every one reads exactly like the unsplit stream`, bad.length === 0, bad.slice(0, 4));
}

console.log(`\nterminal-marker: ${pass} passed, ${failN} failed${failN ? "\n  " + failures.join("\n  ") : ""}`);
process.exit(failN ? 1 : 0);
