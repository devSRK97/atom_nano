"use strict";
/* Pure project-search logic (no Electron). Runs inside a worker thread. */
const fsp = require("fs/promises");
const path = require("path");

const SKIP_SEARCH = new Set([".git", "node_modules", ".idea", "dist", "build", "out", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".venv", "venv", "$RECYCLE.BIN", ".turbo", "vendor"]);

function looksBinary(buf) {
  const len = Math.min(buf.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 14 && c < 32)) suspicious++;
  }
  return suspicious / Math.max(len, 1) > 0.12;
}

// Yields { path, isDir } entries. Directories are yielded only when ctx.dirs
// (folder search); an `exclude` filter prunes whole subtrees before descending.
async function* walk(dir, depth, ctx) {
  if (depth > 14) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = (await fsp.stat(full)).isDirectory(); } catch { continue; } }
    if (ctx.exclude && ctx.exclude(ctx.rel(full), e.name)) continue;
    if (isDir) {
      if (SKIP_SEARCH.has(e.name)) continue;
      if (ctx.dirs) yield { path: full, isDir: true };
      yield* walk(full, depth + 1, ctx);
    } else yield { path: full, isDir: false };
  }
}
// Walk a mix of directory roots and individual file paths (used by the worker
// pool — each worker gets a shard of the project's top-level entries). A shard
// root that is itself a sub-folder of the search base counts as a folder hit.
async function* walkRoots(roots, ctx) {
  for (const r of roots) {
    let st; try { st = await fsp.stat(r); } catch { continue; }
    const name = path.basename(r);
    if (ctx.exclude && ctx.exclude(ctx.rel(r), name)) continue;
    if (st.isDirectory()) {
      if (SKIP_SEARCH.has(name)) continue;
      if (ctx.dirs && ctx.base && path.resolve(r) !== path.resolve(ctx.base)) yield { path: r, isDir: true };
      yield* walk(r, 0, ctx);
    } else yield { path: r, isDir: false };
  }
}
function rootsOf(opts) { return (opts.roots && opts.roots.length) ? opts.roots : (opts.root ? [opts.root] : []); }

/* ---- include / exclude filters ----------------------------------------------
 * A filter is a comma/space-separated list of tokens, any of which may match:
 *   *.js  src/**  test?.py   → glob against the root-relative path (forward
 *                              slashes) AND the basename
 *   .log                     → shorthand for *.log
 *   node_modules  src/tests  → a path segment (or segment sequence) anywhere
 */
function globToRe(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") { if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; } else re += "[^/]*"; }
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}
function compileFilter(spec) {
  const toks = String(spec || "").split(/[,\s]+/).map((t) => t.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "")).filter(Boolean);
  if (!toks.length) return null;
  const tests = toks.map((t) => {
    if (/^\.[\w-]+$/.test(t)) t = "*" + t;
    if (/[*?]/.test(t)) { const re = globToRe(t); return (rel, base) => re.test(rel) || re.test(base); }
    const needle = "/" + t.toLowerCase() + "/";
    return (rel) => ("/" + rel.toLowerCase() + "/").includes(needle);
  });
  return (rel, base) => tests.some((fn) => fn(rel, base));
}
// Per-search context: root-relative paths + compiled filters. `base` is the
// ORIGINAL search root even when this worker only received a shard of it, so
// patterns like "src/**" mean the same thing in every worker.
function ctxFor(opts, dirs) {
  const roots = rootsOf(opts);
  const base = opts.base || opts.root || (roots.length ? path.dirname(roots[0]) : "");
  const rel = (p) => path.relative(base, p).replace(/\\/g, "/");
  return { roots, base, rel, dirs: !!dirs, include: compileFilter(opts.include), exclude: compileFilter(opts.exclude) };
}
function included(ctx, p) { return !ctx.include || ctx.include(ctx.rel(p), path.basename(p)); }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
/* buildMatcher(query, caseSensitive, wholeWord, regex)
 * regex=true treats `query` as a real regular expression instead of literal text.
 * An INVALID pattern must never throw (it would kill a search worker mid-scan and
 * blank the panel while the user is still typing "foo("), so we fall back to a
 * literal match — the same thing the user would have got before regex existed. */
function buildMatcher(query, caseSensitive, wholeWord, regex) {
  const flags = caseSensitive ? "g" : "gi";
  if (regex) {
    // MULTILINE for regex mode: searching is line-oriented, and the whole-file
    // pre-test would otherwise make "^foo" only match the first line of a file
    // (so a file whose match is on line 200 would be skipped entirely).
    try { return new RegExp(query, flags + "m"); } catch { /* invalid → literal below */ }
  }
  let pat = escapeRe(query);
  if (wholeWord) pat = `(?<![\\w$])${pat}(?![\\w$])`;
  return new RegExp(pat, flags);
}
// Is this a usable regular expression? Used to tell the UI a pattern is bad.
function validRegex(q) { try { new RegExp(q); return true; } catch { return false; } }
function clip(s, n = 240) { return s.length > n ? s.slice(0, n) + "…" : s; }

// Name search over files, folders, or both (`kind`: files | folders | all).
// Matches the basename; a query containing "/" also matches the relative path
// (so "src/comp" finds src/components). Honors include / exclude filters.
async function searchNames(opts = {}) {
  const { query, limit = 300, kind = "files" } = opts;
  if (!query) return { files: [], truncated: false };
  const ctx = ctxFor(opts, kind !== "files");
  const q = query.toLowerCase().replace(/\\/g, "/");
  const pathy = q.includes("/");
  const out = [];
  let truncated = false;
  for await (const it of walkRoots(ctx.roots, ctx)) {
    if (kind === "files" && it.isDir) continue;
    if (kind === "folders" && !it.isDir) continue;
    const name = path.basename(it.path);
    if (!(name.toLowerCase().includes(q) || (pathy && ctx.rel(it.path).toLowerCase().includes(q)))) continue;
    if (!included(ctx, it.path)) continue;
    out.push({ path: it.path, name, isDir: it.isDir });
    if (out.length >= limit) { truncated = true; break; }
  }
  return { files: out, truncated };
}

async function searchContent(opts = {}) {
  const { query, caseSensitive = false, wholeWord = false, regex = false, maxFiles = 300, maxPerFile = 50, maxTotal = 2000 } = opts;
  if (!query) return { results: [], fileCount: 0, matchCount: 0, truncated: false };
  const ctx = ctxFor(opts, false);
  const results = [];
  let matchCount = 0, scanned = 0, truncated = false;
  outer:
  for await (const { path: f } of walkRoots(ctx.roots, ctx)) {
    if (!included(ctx, f)) continue;
    if (scanned++ > 6000) { truncated = true; break; }
    let st; try { st = await fsp.stat(f); } catch { continue; }
    if (st.size > 1_500_000) continue;
    let buf; try { buf = await fsp.readFile(f); } catch { continue; }
    if (looksBinary(buf)) continue;
    const text = buf.toString("utf8");
    if (!buildMatcher(query, caseSensitive, wholeWord, regex).test(text)) continue;
    const lines = text.split(/\r?\n/);
    const fileMatches = [];
    for (let i = 0; i < lines.length; i++) {
      const m = buildMatcher(query, caseSensitive, wholeWord, regex).exec(lines[i]);
      if (m) {
        fileMatches.push({
          line: i + 1, col: m.index,
          before: i > 0 ? clip(lines[i - 1]) : null,
          text: clip(lines[i]),
          after: i < lines.length - 1 ? clip(lines[i + 1]) : null,
        });
        matchCount++;
        if (fileMatches.length >= maxPerFile) break;
        if (matchCount >= maxTotal) { results.push({ path: f, name: path.basename(f), matches: fileMatches }); truncated = true; break outer; }
      }
    }
    if (fileMatches.length) results.push({ path: f, name: path.basename(f), matches: fileMatches });
    if (results.length >= maxFiles) { truncated = true; break; }
  }
  return { results, fileCount: results.length, matchCount, truncated };
}

// Definition patterns for go-to-definition (mirrors the renderer's heuristics).
function defPatterns(word, lang) {
  const W = escapeRe(word);
  if (lang === "py" || lang === "python") return [new RegExp(`\\bdef\\s+${W}\\b`), new RegExp(`\\bclass\\s+${W}\\b`), new RegExp(`^\\s*${W}\\s*=`)];
  return [
    new RegExp(`\\b(?:function|class)\\s+${W}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${W}\\b`),
    new RegExp(`\\b${W}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\(|[\\w$]+\\s*=>)`),
    new RegExp(`\\b${W}\\s*\\([^)]*\\)\\s*\\{`),
  ];
}
// Fast definition lookup: only relevant source files, EARLY-EXIT at the first
// match — so it returns in milliseconds instead of scanning the whole project.
async function findDefinition(opts = {}) {
  const { word, lang, maxFiles = 4000 } = opts;
  const roots = rootsOf(opts);
  if (!word || !roots.length) return null;
  const exts = (lang === "py" || lang === "python") ? new Set([".py"]) : new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
  const pats = defPatterns(word, lang);
  const ctx = ctxFor(opts, false);
  let scanned = 0;
  for await (const { path: f } of walkRoots(roots, ctx)) {
    if (scanned++ > maxFiles) break;
    if (!exts.has(path.extname(f).toLowerCase())) continue;
    let st; try { st = await fsp.stat(f); } catch { continue; }
    if (st.size > 1_500_000) continue;
    let text; try { text = (await fsp.readFile(f)).toString("utf8"); } catch { continue; }
    if (text.indexOf(word) < 0) continue;            // cheap presence check first
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (pats.some((r) => r.test(lines[i]))) return { path: f, line: i + 1, col: Math.max(0, lines[i].indexOf(word)) };
    }
  }
  return null;
}

module.exports = { searchNames, searchContent, findDefinition, validRegex, compileFilter, SKIP_SEARCH };
