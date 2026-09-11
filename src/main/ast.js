"use strict";
/* AST-based code analysis for Test Director — replaces the regex heuristics both
 * model consults flagged as fragile (string/comment hits, missed aliases, unsound
 * mutation). Uses the TypeScript parser, LAZY-loaded so a user who never runs
 * Test Director never pays the memory (mirrors the project's lazy-load ethos).
 *
 * Every export returns null/empty on a parse failure so callers can fall back to
 * the old regex path — a malformed or non-JS/TS file must never break a gate.
 */
let ts = null;
function load() { if (!ts) { try { ts = require("typescript"); } catch { ts = false; } } return ts || null; }
function parse(file, source) {
  const T = load(); if (!T) return null;
  try { return T.createSourceFile(file || "f.tsx", String(source || ""), T.ScriptTarget.Latest, true, /\.tsx?$/.test(file || "f.tsx") ? T.ScriptKind.TSX : T.ScriptKind.TSX); } catch { return null; }
}
function walk(node, fn) { fn(node); node.forEachChild((c) => walk(c, fn)); }

// Module specifiers imported/required by a file (for classify + the dep graph).
function imports(source, file) {
  const T = load(); const sf = parse(file, source); if (!T || !sf) return null;
  const out = [];
  walk(sf, (n) => {
    if (T.isImportDeclaration(n) && n.moduleSpecifier && T.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (T.isExportDeclaration(n) && n.moduleSpecifier && T.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (T.isCallExpression(n) && (n.expression.kind === T.SyntaxKind.ImportKeyword || (T.isIdentifier(n.expression) && n.expression.text === "require")) && n.arguments[0] && T.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
  });
  return out;
}

const BROWSER_MOD = /^(?:react|react-dom|preact|vue|svelte|solid-js|@angular\/core|@testing-library\/|lit|@stencil\/)/;
const NODE_MOD = /^(?:fs|path|os|http|https|net|crypto|child_process|stream|express|fastify|koa|@nestjs\/|pg|mysql2?|mongodb|better-sqlite3|node:)/;
const BACKEND_MOD = /^(?:express|fastify|koa|http|https|net|@nestjs\/)/;
// Adapter + domain from the file's REAL imports + DOM/JSX usage (no comment/string hits).
function classify(source, file) {
  const T = load(); const sf = parse(file, source); if (!T || !sf) return null;
  const mods = imports(source, file) || [];
  let browser = mods.some((m) => BROWSER_MOD.test(m));
  let node = mods.some((m) => NODE_MOD.test(m));
  const backend = mods.some((m) => BACKEND_MOD.test(m));
  walk(sf, (n) => {
    if (n.kind >= T.SyntaxKind.JsxElement && n.kind <= T.SyntaxKind.JsxFragment) browser = true;
    if (T.isIdentifier(n) && /^(document|window|HTMLElement|customElements|navigator|localStorage)$/.test(n.text)) browser = true;
  });
  if (browser && !node) return { adapter: "browser", domain: "frontend" };
  if (node && !browser) return { adapter: "node", domain: backend ? "backend" : "library" };
  if (browser && node) return { adapter: "browser", domain: "frontend" };
  return { adapter: "node", domain: "library" };
}

// Assertion strength of a test file: count expect()/assert() calls + snapshots,
// and flag skip/only — used by the append-only integrity guard.
function assertions(source, file) {
  const T = load(); const sf = parse(file, source); if (!T || !sf) return null;
  let count = 0, hasSnapshot = false, hasSkipOnly = false;
  walk(sf, (n) => {
    if (T.isIdentifier(n) && /^(xit|xdescribe|fit|fdescribe|xtest)$/.test(n.text)) hasSkipOnly = true;
    if (T.isCallExpression(n)) {
      const callee = n.expression;
      // Count the HEAD of an assertion chain ONCE — expect(...) / assert(...) /
      // assert.x(...) — so expect(1).toBe(1) counts as a single assertion.
      if (T.isIdentifier(callee) && (callee.text === "expect" || callee.text === "assert")) count++;
      else if (T.isPropertyAccessExpression(callee) && T.isIdentifier(callee.expression) && callee.expression.text === "assert") count++;
      if (T.isPropertyAccessExpression(callee)) {
        const prop = callee.name.text;
        if (prop === "toMatchSnapshot" || prop === "toMatchInlineSnapshot") hasSnapshot = true;
        if ((prop === "skip" || prop === "only") && T.isIdentifier(callee.expression) && /^(it|describe|test|context)$/.test(callee.expression.text)) hasSkipOnly = true;
      }
    }
  });
  return { count, hasSnapshot, hasSkipOnly };
}

// Node-precise operator/boolean mutants — only real expression-operator tokens are
// touched, so strings/comments/regex are never mutated (consult finding #2).
function mutate(source, cap = 5) {
  const T = load(); const sf = parse("m.ts", source); if (!T || !sf) return null;
  const SWAP = {
    [T.SyntaxKind.GreaterThanToken]: "<", [T.SyntaxKind.LessThanToken]: ">",
    [T.SyntaxKind.GreaterThanEqualsToken]: "<=", [T.SyntaxKind.LessThanEqualsToken]: ">=",
    [T.SyntaxKind.EqualsEqualsEqualsToken]: "!==", [T.SyntaxKind.ExclamationEqualsEqualsToken]: "===",
    [T.SyntaxKind.EqualsEqualsToken]: "!=", [T.SyntaxKind.ExclamationEqualsToken]: "==",
    [T.SyntaxKind.PlusToken]: "-", [T.SyntaxKind.MinusToken]: "+",
    [T.SyntaxKind.AsteriskToken]: "/", [T.SyntaxKind.SlashToken]: "*",
    [T.SyntaxKind.AmpersandAmpersandToken]: "||", [T.SyntaxKind.BarBarToken]: "&&",
  };
  const edits = [];
  walk(sf, (n) => {
    if (edits.length >= cap * 3) return;
    if (T.isBinaryExpression(n) && SWAP[n.operatorToken.kind] != null) {
      edits.push({ start: n.operatorToken.getStart(sf), end: n.operatorToken.getEnd(), to: SWAP[n.operatorToken.kind], from: n.operatorToken.getText(sf) });
    } else if (n.kind === T.SyntaxKind.TrueKeyword) edits.push({ start: n.getStart(sf), end: n.getEnd(), to: "false", from: "true" });
    else if (n.kind === T.SyntaxKind.FalseKeyword) edits.push({ start: n.getStart(sf), end: n.getEnd(), to: "true", from: "false" });
  });
  const seen = new Set();
  const out = [];
  for (const e of edits) {
    if (seen.has(e.start)) continue; seen.add(e.start);
    out.push({ code: source.slice(0, e.start) + e.to + source.slice(e.end), op: `${e.from}→${e.to}@${source.slice(0, e.start).split("\n").length}` });
    if (out.length >= cap) break;
  }
  return out;
}

// Resolve a relative import specifier to a file path (for the dependency graph).
function resolveImport(fromFile, spec) {
  if (!spec || !/^\.\.?\//.test(spec)) return null;       // only local imports
  const path = require("path");
  const fs = require("fs");
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, base + ".ts", base + ".tsx", base + ".js", base + ".jsx", base + ".mjs", base + ".cjs",
    path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js")];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* */ } }
  return null;
}

module.exports = { available: () => !!load(), imports, classify, assertions, mutate, resolveImport };
