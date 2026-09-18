"use strict";
/* File-tree + file utilities for the left navigation pane. */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { shell } = require("electron");
const { Worker } = require("worker_threads");
const { SKIP_SEARCH } = require("./search-core");

const SKIP_DIR = new Set([".git", "node_modules", ".DS_Store", "$RECYCLE.BIN"]);

// How many worker cores to use for search/go-to-definition, per the user's policy:
// 24 cores → 14, 12 → 9, 8 → 5, 4 → 2 (capped at 14; ≥1).
function searchConcurrency() {
  const cores = (os.cpus() || []).length || 4;
  let n;
  if (cores >= 24) n = 14;
  else if (cores >= 12) n = 9;
  else if (cores >= 8) n = 5;
  else if (cores >= 4) n = 2;
  else n = Math.max(1, cores - 1);
  return Math.min(14, Math.max(1, n));
}

async function listDir(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const name = e.name;
    let isDir = e.isDirectory();
    let isSymlink = e.isSymbolicLink();
    const full = path.join(dirPath, name);
    if (isSymlink) {
      try { isDir = (await fsp.stat(full)).isDirectory(); } catch { /* dangling */ }
    }
    out.push({
      name,
      path: full,
      isDir,
      hidden: name.startsWith("."),
      ext: isDir ? "" : path.extname(name).slice(1).toLowerCase(),
      skip: isDir && SKIP_DIR.has(name),
    });
  }
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { path: dirPath, parent: path.dirname(dirPath), name: path.basename(dirPath) || dirPath, entries: out };
}

/* ---- create / rename / move / delete -------------------------------------
 * The tree could read and reveal but never CREATE, RENAME or DELETE — every
 * such operation had to go through the agent or an external tool. Each of these
 * refuses to clobber an existing path, so a rename can never silently destroy a
 * sibling, and each returns the resulting path so the caller can re-select it. */
async function createFile(filePath, content) {
  if (fs.existsSync(filePath)) throw new Error(path.basename(filePath) + " already exists");
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, String(content ?? ""), "utf8");
  return { path: filePath, isDir: false };
}

async function createFolder(dirPath) {
  if (fs.existsSync(dirPath)) throw new Error(path.basename(dirPath) + " already exists");
  await fsp.mkdir(dirPath, { recursive: true });
  return { path: dirPath, isDir: true };
}

/* Rename in place (same parent). `to` is a bare name, not a path — the caller
 * is renaming, not moving, and accepting a full path here invites accidental
 * moves out of the tree. */
async function renamePath(oldPath, newName) {
  const name = String(newName || "").trim();
  if (!name || /[\\/]/.test(name)) throw new Error("a name cannot contain a path separator");
  const target = path.join(path.dirname(oldPath), name);
  if (path.resolve(target) === path.resolve(oldPath)) return { path: oldPath, unchanged: true };
  // Case-only renames on Windows/macOS: the case-insensitive FS reports the
  // target as existing (it's the same file), so let those through.
  const caseOnly = path.resolve(target).toLowerCase() === path.resolve(oldPath).toLowerCase();
  if (!caseOnly && fs.existsSync(target)) throw new Error(name + " already exists");
  await fsp.rename(oldPath, target);
  let isDir = false; try { isDir = (await fsp.stat(target)).isDirectory(); } catch { /* raced */ }
  return { path: target, from: oldPath, isDir };
}

// Move a file or folder to a different parent (drag-drop, "move to…").
async function movePath(fromPath, toPath) {
  if (fs.existsSync(toPath)) throw new Error(path.basename(toPath) + " already exists");
  await fsp.mkdir(path.dirname(toPath), { recursive: true });
  await fsp.rename(fromPath, toPath);
  return { path: toPath, from: fromPath };
}

const TEXT_MAX = 80 * 1024 * 1024; // 80 MB — supports very large files (~1M+ lines)

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

async function readFile(filePath) {
  const st = await fsp.stat(filePath);
  if (st.isDirectory()) return { error: "Path is a directory" };
  if (st.size > TEXT_MAX) {
    return { tooLarge: true, size: st.size, content: "", name: path.basename(filePath), path: filePath };
  }
  const buf = await fsp.readFile(filePath);
  if (looksBinary(buf)) {
    return { isBinary: true, size: st.size, content: "", name: path.basename(filePath), path: filePath };
  }
  return {
    content: buf.toString("utf8"),
    size: st.size,
    name: path.basename(filePath),
    path: filePath,
    ext: path.extname(filePath).slice(1).toLowerCase(),
  };
}

function reveal(p) {
  try { shell.showItemInFolder(path.normalize(p)); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

async function openPath(p) {
  const err = await shell.openPath(path.normalize(p));
  return err ? { ok: false, error: err } : { ok: true };
}

async function trash(p) {
  await shell.trashItem(path.normalize(p)); // moves to Recycle Bin (recoverable)
  return { ok: true };
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function fileSize(p) { try { return fs.statSync(p).size; } catch { return -1; } }  // -1 if missing

async function writeFile(filePath, content) {
  await fsp.writeFile(filePath, content, "utf8");
  const st = await fsp.stat(filePath);
  return { ok: true, size: st.size };
}
/* Checked write for resolutions: the file is only replaced if its CURRENT bytes still
 * equal `expected` (the text the resolver loaded). A file that changed underneath
 * (git checkout, another editor, the agent) is reported as { ok:false, conflict:true }
 * with nothing written. The write is temp + rename, so a crash never leaves a
 * half-written source file. `expected === null` skips the check (new file). */
async function writeFileChecked(filePath, content, expected) {
  let current = null;
  try { current = await fsp.readFile(filePath, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (expected != null && current != null && current !== expected) return { ok: false, conflict: true, size: Buffer.byteLength(current) };
  if (expected != null && current == null) return { ok: false, conflict: true, missing: true };
  const tmp = `${filePath}.atomnano-${process.pid}-${Date.now()}.tmp`;
  let mode = null; try { mode = (await fsp.stat(filePath)).mode; } catch { /* new file */ }
  await fsp.writeFile(tmp, content, "utf8");
  if (mode != null) { try { await fsp.chmod(tmp, mode); } catch { /* best effort */ } }
  try { await fsp.rename(tmp, filePath); } catch (e) { try { await fsp.unlink(tmp); } catch { /* */ } throw e; }
  const st = await fsp.stat(filePath);
  return { ok: true, size: st.size };
}
/* Watch a repository's Git METADATA (the tree watcher skips `.git` on purpose):
 * HEAD / ORIG_HEAD / MERGE_HEAD / rebase & sequencer dirs / index / refs / packed-refs.
 * Object writes and *.lock churn are ignored. Handles `.git` FILES (worktrees,
 * submodules → "gitdir: …"). Returns { close() } or null. */
function watchGitMeta(repoRoot, onChange) {
  if (!repoRoot) return null;
  const gitPath = path.join(repoRoot, ".git");
  let dir = gitPath;
  try {
    const st = fs.statSync(gitPath);
    if (st.isFile()) { const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, "utf8")); if (!m) return null; dir = path.resolve(repoRoot, m[1].trim()); }
  } catch { return null; }
  const relevant = (name) => {
    const n = String(name || "").replace(/\\/g, "/");
    if (!n) return true;
    if (/\.lock$/.test(n) || /(^|\/)tmp_/.test(n) || /^atomnano-index/.test(n)) return false;
    if (/^(objects|hooks|info|lfs|modules|worktrees\/[^/]+\/objects)\//.test(n)) return false;
    return true;
  };
  let timer = null, watcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_ev, filename) => {
      if (!relevant(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(() => { try { onChange(); } catch { /* */ } }, 300);
    });
  } catch { return null; }
  watcher.on("error", () => { /* transient watch error must not crash the app */ });
  return { close() { clearTimeout(timer); try { watcher.close(); } catch { /* */ } } };
}

// Recursively watch a folder for external changes (other apps/editors, the AI
// agent's tool edits, git operations). Coalescing/debouncing is the caller's job.
// Events inside noise dirs (.git, node_modules, …) are dropped so routine churn
// doesn't spam the UI. Returns an fs.FSWatcher (has .close()) or null.
function watchTree(root, onChange) {
  if (!root) return null;
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (filename) {
        const norm = filename.toString().replace(/\\/g, "/");
        if (norm.split("/").some((seg) => SKIP_DIR.has(seg))) return;
      }
      onChange();
    });
  } catch { return null; }
  watcher.on("error", () => { /* a transient watch error must not crash the app */ });
  return watcher;
}

// One search worker (separate core). Returns { worker, promise } so the pool
// can terminate it early (e.g. once another worker found the definition).
function spawnSearchWorker(payload) {
  let worker;
  const promise = new Promise((resolve, reject) => {
    try { worker = new Worker(path.join(__dirname, "search-worker.js"), { workerData: payload }); }
    catch (e) { return reject(e); }
    let settled = false;
    worker.once("message", (msg) => { settled = true; worker.terminate(); if (msg && msg.ok) resolve(msg.data); else reject(new Error((msg && msg.error) || "search failed")); });
    worker.once("error", (e) => { if (!settled) { settled = true; reject(e); } });
    worker.once("exit", (code) => { if (!settled) reject(new Error("search worker exited " + code)); });
  });
  return { get worker() { return worker; }, promise };
}
function runSearchWorker(payload) { return spawnSearchWorker(payload).promise; }

// Split a project's top-level entries into `n` shards (round-robin over the
// directories; top-level files go to shard 0) so workers cover disjoint trees.
async function shardRoots(root, n) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return [[root]]; }
  const dirs = [], files = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP_SEARCH.has(e.name)) dirs.push(full); }
    else files.push(full);
  }
  if (!dirs.length) return [[root]];                       // nothing to parallelise
  const k = Math.max(1, Math.min(n, dirs.length));
  const buckets = Array.from({ length: k }, () => []);
  dirs.forEach((d, i) => buckets[i % k].push(d));
  if (files.length) buckets[0].push(...files);
  return buckets;
}

function mergeContent(parts) {
  const results = []; let matchCount = 0, truncated = false;
  for (const p of parts) { if (!p) continue; results.push(...(p.results || [])); matchCount += p.matchCount || 0; truncated = truncated || !!p.truncated; }
  return { results, fileCount: results.length, matchCount, truncated };
}
function mergeNames(parts) {
  const files = []; let truncated = false;
  for (const p of parts) { if (!p) continue; files.push(...(p.files || [])); truncated = truncated || !!p.truncated; }
  return { files, truncated };
}

// Fan a search across a pool of worker threads (multi-core). For "definition"
// it early-exits the moment any worker reports a hit (terminating the rest).
async function runPooledSearch(type, opts) {
  const root = opts && opts.root;
  const n = searchConcurrency();
  if (!root || n <= 1) return runSearchWorker({ type, opts });
  const buckets = await shardRoots(root, n);
  if (buckets.length <= 1) return runSearchWorker({ type, opts });

  if (type === "definition") {
    return new Promise((resolve) => {
      let pending = buckets.length, done = false;
      const handles = buckets.map((roots) => spawnSearchWorker({ type, opts: { ...opts, root: undefined, roots, base: opts.base || root } }));
      const finish = (val) => { if (done) return; done = true; for (const h of handles) { try { h.worker && h.worker.terminate(); } catch { /* ignore */ } } resolve(val); };
      for (const h of handles) {
        h.promise.then((res) => { if (res) finish(res); else if (--pending === 0) finish(null); })
          .catch(() => { if (--pending === 0) finish(null); });
      }
    });
  }
  const parts = await Promise.all(buckets.map((roots) => runSearchWorker({ type, opts: { ...opts, root: undefined, roots, base: opts.base || root } }).catch(() => null)));
  return type === "names" ? mergeNames(parts) : mergeContent(parts);
}

function searchNames(opts) { return runPooledSearch("names", opts || {}); }
function searchContent(opts) { return runPooledSearch("content", opts || {}); }
function findDefinition(opts) { return runPooledSearch("definition", opts || {}); }

/* Replace across every file the same search would have matched.
 *
 * Runs the search first so the file set is EXACTLY what the panel showed — the
 * user replaces what they were looking at, not a re-scan that may have drifted.
 * `only` (a list of paths) narrows it to the rows they left checked. Files are
 * rewritten one at a time and a failure on one is reported rather than aborting
 * the rest, so a single read-only file can't roll back the whole operation. */
async function replaceInFiles(opts = {}) {
  const { query, replace = "", root, base, include, exclude, regex = false, caseSensitive = false, wholeWord = false, only } = opts;
  if (!query) return { files: 0, matches: 0, errors: [] };
  const found = await searchContent({ query, root, base, include, exclude, regex, caseSensitive, wholeWord, maxFiles: 5000, maxPerFile: 10000, maxTotal: 200000 });
  const keep = only && only.length ? new Set(only.map((p) => String(p).toLowerCase())) : null;
  const body = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = "g" + (caseSensitive ? "" : "i");
  let re;
  try { re = new RegExp(wholeWord ? `\\b(?:${body})\\b` : body, flags); }
  catch (e) { throw new Error("invalid regular expression: " + e.message); }

  let files = 0, matches = 0;
  const errors = [];
  for (const f of (found.results || [])) {
    const p = f.path || f.file;
    if (!p) continue;
    if (keep && !keep.has(String(p).toLowerCase())) continue;
    try {
      const text = await fsp.readFile(p, "utf8");
      let n = 0;
      const next = text.replace(re, (...args) => {
        n++;
        // `replace` may reference capture groups ($1) when regex is on; let the
        // engine expand them by handing back the pattern rather than a literal.
        return regex ? String(replace).replace(/\$(\d+)/g, (_, d) => args[+d] ?? "") : replace;
      });
      if (!n || next === text) continue;
      await fsp.writeFile(p, next, "utf8");
      files++; matches += n;
    } catch (e) { errors.push({ path: p, error: e.message }); }
  }
  return { files, matches, errors, scanned: (found.results || []).length };
}

module.exports = { listDir, readFile, writeFile, writeFileChecked, watchTree, watchGitMeta, reveal, openPath, trash, exists, fileSize, searchNames, searchContent, findDefinition, createFile, createFolder, renamePath, movePath, replaceInFiles };
