"use strict";
/* Generic Language Server Protocol client (main process).
 *
 * Gives non-JS/TS languages the same semantic features the TypeScript service
 * gives JS/TS — diagnostics, hover, completion, signature help, definition and
 * formatting — by launching a real language server per language per project and
 * speaking LSP over stdio. Python ships out of the box (bundled pyright); other
 * servers (gopls, rust-analyzer, clangd, intelephense, …) are used when found on
 * PATH. Positions are mapped between LSP line/character and our character offsets.
 */
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const { pathToFileURL, fileURLToPath } = require("url");
const rpc = require("vscode-jsonrpc/node");

// ---- server registry: find a launch command for a language, if available ----
function onPath(cmd) {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const e of exts) { try { const p = path.join(dir, cmd + e); if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  }
  return null;
}
const SERVERS = {
  python: {
    exts: ["py", "pyw", "pyi"], languageId: "python",
    make() { try { const ls = require.resolve("pyright/langserver.index.js"); return { command: process.execPath, args: [ls, "--stdio"], env: { ELECTRON_RUN_AS_NODE: "1" } }; } catch { const p = onPath("pyright-langserver"); return p ? { command: p, args: ["--stdio"] } : null; } },
  },
  go: { exts: ["go"], languageId: "go", make() { const p = onPath("gopls"); return p ? { command: p, args: [] } : null; } },
  rust: { exts: ["rs"], languageId: "rust", make() { const p = onPath("rust-analyzer"); return p ? { command: p, args: [] } : null; } },
  cpp: { exts: ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], languageId: "cpp", make() { const p = onPath("clangd"); return p ? { command: p, args: ["--background-index"] } : null; } },
  php: { exts: ["php", "phtml"], languageId: "php", make() { const p = onPath("intelephense"); return p ? { command: p, args: ["--stdio"] } : null; } },
};
const EXT_SERVER = {};
for (const [id, s] of Object.entries(SERVERS)) for (const e of s.exts) EXT_SERVER[e] = id;

// exts that currently have a server available (pyright bundled → python always)
function availableExts() {
  const out = [];
  for (const [id, s] of Object.entries(SERVERS)) { try { if (s.make()) out.push(...s.exts); } catch { /* ignore */ } }
  return out;
}

// ---- position mapping (offset ↔ {line, character}) ----
function offsetToPos(text, off) {
  let line = 0, lineStart = 0;
  const n = Math.min(off, text.length);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  return { line, character: off - lineStart };
}
function posToOffset(text, pos) {
  let i = 0, line = 0;
  while (line < pos.line && i < text.length) { if (text.charCodeAt(i) === 10) line++; i++; }
  return Math.min(i + (pos.character || 0), text.length);
}
const rangeToOffsets = (text, r) => ({ from: posToOffset(text, r.start), to: posToOffset(text, r.end) });
const normPath = (p) => (p || "").replace(/\\/g, "/").toLowerCase();

const SEV = { 1: "error", 2: "warning", 3: "info", 4: "info" };
const CK = { 2: "method", 3: "function", 4: "function", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace", 10: "property", 13: "enum", 14: "keyword", 20: "enum", 22: "class", 25: "type" };
// LSP SymbolKind → short label (for the outline / go-to-symbol).
const LSP_SYMBOL_KIND = { 1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object", 20: "key", 22: "enum-member", 23: "struct", 26: "type-parameter" };
function mdString(c) {
  if (!c) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(mdString).join("\n\n");
  if (c.value != null) return c.value;
  return "";
}

// ---- connections: one server per (root, serverId) ----
const conns = new Map();
let onDiagnostics = null;   // (filePath) => void, set by main to push to the renderer

function key(root, serverId) { return serverId + "\0" + root; }

function connFor(root, serverId) {
  const k = key(root, serverId);
  let c = conns.get(k);
  if (c) return c.ready.then(() => c);
  const spec = SERVERS[serverId] && SERVERS[serverId].make();
  if (!spec) return Promise.resolve(null);
  c = { conn: null, child: null, opened: new Map(), diags: new Map(), broken: false };
  conns.set(k, c);
  c.ready = (async () => {
    try {
      const child = cp.spawn(spec.command, spec.args, { cwd: root, env: { ...process.env, ...(spec.env || {}) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.on("error", () => { c.broken = true; });
      child.on("exit", () => { c.broken = true; conns.delete(k); });
      const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
      conn.onNotification("textDocument/publishDiagnostics", (p) => {
        let fp; try { fp = fileURLToPath(p.uri); } catch { fp = p.uri; }
        c.diags.set(normPath(fp), p.diagnostics || []);   // key by normalised path (avoids URI drive-case mismatch)
        if (onDiagnostics) { try { onDiagnostics(fp); } catch { /* ignore */ } }
      });
      conn.onError(() => {});
      conn.listen();
      c.conn = conn; c.child = child;
      await conn.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).toString(),
        workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } } },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
            definition: { linkSupport: true },
            publishDiagnostics: {},
            formatting: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            inlayHint: { dynamicRegistration: false }, references: {},
          },
          workspace: { workspaceFolders: true, configuration: true },
        },
        initializationOptions: {},
      });
      conn.sendNotification("initialized", {});
    } catch { c.broken = true; }
  })();
  return c.ready.then(() => (c.broken ? null : c));
}

function syncDoc(c, uri, languageId, text) {
  const known = c.opened.get(uri);
  if (!known) {
    c.opened.set(uri, { v: 1, text });
    c.conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
  } else if (known.text !== text) {   // only notify on real changes → avoids a publish→relint→sync loop
    known.v++; known.text = text;
    c.conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: known.v }, contentChanges: [{ text }] });
  }
}

async function ctx(root, ext, file, text) {
  const serverId = EXT_SERVER[(ext || "").toLowerCase()];
  if (!serverId) return null;
  const c = await connFor(root, serverId);
  if (!c || c.broken) return null;
  c.lastUsed = Date.now();
  const uri = pathToFileURL(file).toString();
  syncDoc(c, uri, SERVERS[serverId].languageId, text || "");
  return { c, uri };
}

// Shut down language servers (a real subprocess each — pyright/gopls/… can hold
// hundreds of MB) that haven't been used for a while, e.g. after the last file
// of that language is closed. They respawn transparently on the next request.
const LSP_IDLE_MS = 5 * 60 * 1000;
const lspReaper = setInterval(() => {
  const now = Date.now();
  for (const [k, c] of conns) {
    if (c.lastUsed && now - c.lastUsed > LSP_IDLE_MS) { try { c.child && c.child.kill(); } catch { /* ignore */ } conns.delete(k); }
  }
}, 60 * 1000);
if (lspReaper.unref) lspReaper.unref();

// ---- public API (mirrors tsserver where shapes overlap) ----
async function diagnose(root, ext, file, text) {
  const x = await ctx(root, ext, file, text);
  if (!x) return [];
  const raw = x.c.diags.get(normPath(file)) || [];
  return raw.slice(0, 400).map((d) => {
    const { from, to } = rangeToOffsets(text, d.range);
    return { from, to: Math.max(to, from + 1), severity: SEV[d.severity] || "info", message: typeof d.message === "string" ? d.message : String(d.message || ""), code: d.code };
  });
}

async function request(kind, root, ext, file, payload) {
  payload = payload || {};
  const text = payload.text || "";
  const x = await ctx(root, ext, file, text);
  if (!x) return null;
  const { c, uri } = x;
  const td = { uri };
  try {
    if (kind === "hover") {
      const r = await c.conn.sendRequest("textDocument/hover", { textDocument: td, position: offsetToPos(text, payload.pos) });
      if (!r || !r.contents) return null;
      const md = mdString(r.contents);
      const clean = md.replace(/```[^\n]*\n?/g, "").trim();   // strip code fences → real signature line
      const range = r.range ? rangeToOffsets(text, r.range) : {};
      const firstLine = clean.split("\n").find((l) => l.trim()) || clean;
      return { from: range.from, to: range.to, display: firstLine.trim(), doc: clean };
    }
    if (kind === "completions") {
      const r = await c.conn.sendRequest("textDocument/completion", { textDocument: td, position: offsetToPos(text, payload.pos) });
      const items = (r && (Array.isArray(r) ? r : r.items)) || [];
      return { entries: items.slice(0, 300).map((it) => ({ name: it.label, kind: CK[it.kind] || "variable", sortText: it.sortText, insertText: typeof it.insertText === "string" ? it.insertText : null, source: null, hasAction: !!(it.additionalTextEdits && it.additionalTextEdits.length), data: it, replace: null })), isMember: false, optionalReplace: null };
    }
    if (kind === "completionDetails") {
      let it = payload.data;
      try { if (it) it = await c.conn.sendRequest("completionItem/resolve", it); } catch { /* server may not support resolve */ }
      const doc = it ? mdString(it.documentation) : "";
      const importEdits = ((it && it.additionalTextEdits) || []).map((e) => ({ ...rangeToOffsets(text, e.range), text: e.newText }));
      return { display: (it && it.detail) || payload.name || "", doc, importEdits };
    }
    if (kind === "signature") {
      const r = await c.conn.sendRequest("textDocument/signatureHelp", { textDocument: td, position: offsetToPos(text, payload.pos) });
      if (!r || !r.signatures || !r.signatures.length) return null;
      const sig = r.signatures[r.activeSignature || 0] || r.signatures[0];
      const params = (sig.parameters || []).map((p) => (typeof p.label === "string" ? p.label : sig.label.slice(p.label[0], p.label[1])));
      return { label: sig.label, params, activeParam: r.activeParameter || 0, doc: mdString(sig.documentation) };
    }
    if (kind === "definition") {
      const r = await c.conn.sendRequest("textDocument/definition", { textDocument: td, position: offsetToPos(text, payload.pos) });
      const loc = Array.isArray(r) ? r[0] : r;
      if (!loc) return null;
      const tUri = loc.uri || loc.targetUri;
      const rng = loc.range || loc.targetSelectionRange || loc.targetRange;
      return { file: fileURLToPath(tUri), line: rng.start.line + 1, col: rng.start.character + 1 };
    }
    if (kind === "format") {
      const r = await c.conn.sendRequest("textDocument/formatting", { textDocument: td, options: { tabSize: 2, insertSpaces: true } });
      return (r || []).map((e) => ({ ...rangeToOffsets(text, e.range), text: e.newText }));
    }
    if (kind === "inlayHints") {
      const r = await c.conn.sendRequest("textDocument/inlayHint", { textDocument: td, range: { start: offsetToPos(text, payload.start || 0), end: offsetToPos(text, payload.end || text.length) } });
      return (r || []).slice(0, 600).map((h) => ({
        pos: posToOffset(text, h.position),
        text: typeof h.label === "string" ? h.label : (h.label || []).map((p) => p.value).join(""),
        paddingLeft: !!h.paddingLeft, paddingRight: !!h.paddingRight,
      }));
    }
    if (kind === "documentSymbols") {
      const r = await c.conn.sendRequest("textDocument/documentSymbol", { textDocument: td });
      // Flatten the (possibly hierarchical) symbols into {name, kind, from, to, depth}.
      const out = [];
      const walk = (arr, depth) => {
        for (const sym of (arr || [])) {
          const rng = sym.range || (sym.location && sym.location.range);
          if (!rng) continue;
          const { from, to } = rangeToOffsets(text, rng);
          out.push({ name: sym.name, kind: LSP_SYMBOL_KIND[sym.kind] || "symbol", from, to, depth });
          if (sym.children) walk(sym.children, depth + 1);
        }
      };
      walk(Array.isArray(r) ? r : [], 0);
      return out;
    }
    if (kind === "references") {
      const r = await c.conn.sendRequest("textDocument/references", { textDocument: td, position: offsetToPos(text, payload.pos), context: { includeDeclaration: true } });
      return (r || []).slice(0, 1000).map((loc) => {
        let fp; try { fp = fileURLToPath(loc.uri); } catch { fp = loc.uri; }
        return { file: fp, line: loc.range.start.line + 1, col: loc.range.start.character + 1 };
      });
    }
  } catch { return null; }
  return null;
}

function setDiagnosticsListener(fn) { onDiagnostics = fn; }
function shutdownAll() { for (const c of conns.values()) { try { c.child && c.child.kill(); } catch { /* ignore */ } } conns.clear(); }

module.exports = { availableExts, diagnose, request, setDiagnosticsListener, shutdownAll };
