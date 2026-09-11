/*
 * Compact, dependency-free Markdown -> HTML renderer tuned for Claude output.
 * Escapes all HTML first, so assistant text can never inject markup.
 */

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Recognised source/config extensions for clickable file references.
const FP_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|markdown|css|scss|sass|less|html?|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|swift|sh|bash|zsh|yml|yaml|toml|sql|txt|xml|vue|svelte|env|ini|cfg|conf|gradle|rb|php|lua|ipynb|proto|astro|tf|bat|cmd|ps1|dockerfile|makefile)$/i;
function looksLikeFilePath(s) {
  if (!s || s.length < 3 || s.length > 240) return false;
  if (/[\s`<>]/.test(s)) return false;
  if (/^https?:/i.test(s)) return false;
  const hasSep = /[\/\\]/.test(s);
  const hasExt = FP_EXT.test(s);
  return hasSep && hasExt;
}

/* A file reference a chat link may point at: an absolute path (drive letter, UNC
 * or POSIX) or a relative path, with an optional :line[:col] suffix. Anything with
 * a URL scheme other than file: is NOT a file link (so `javascript:` can never
 * sneak through as one). Returns { path, line, col } or null. */
const FILE_LINK_RE = /^(?:file:\/\/\/?)?((?:[a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[^\s:<>"|?*]+[\\/])[^<>"|?*\n]*?)(?::(\d+)(?::(\d+))?)?$/;
function parseFileLink(s) {
  const t = String(s || "").trim();
  if (!t || t.length > 1024) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^file:/i.test(t) && !/^[a-zA-Z]:[\\/]/.test(t)) return null;
  const m = FILE_LINK_RE.exec(t.replace(/^file:\/\/\/?/i, (x) => x));
  if (!m) return null;
  let p = m[1].replace(/^file:\/\/\/?/i, "");
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  if (!/[\\/]/.test(p) && !FP_EXT.test(p)) return null;
  return { path: p, line: m[2] ? +m[2] : 0, col: m[3] ? +m[3] : 0 };
}

/* Which link targets are safe to make clickable.
 * Chat output comes from a model, so it gets http(s) links and — when the host
 * opts in with `fileLinks` — local FILE references that the app opens in its own
 * editor (never handed to a shell). A `javascript:` or `data:` target dressed up
 * as a link is the one thing this renderer must not produce. A local preview
 * additionally gets relative paths and #anchors, which are meaningful there
 * because there IS a file the document sits next to. */
function safeUrl(u, opts) {
  const s = String(u || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (opts && opts.fileLinks && parseFileLink(s)) return s;
  if (!opts || !opts.localLinks) return null;
  if (/^(mailto:|#)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;   // any other scheme — refuse
  return s;                                          // relative path
}

// GitHub-style heading slug, so #anchor links inside a document resolve.
function slug(s) {
  return String(s).replace(/<[^>]*>/g, "").toLowerCase().trim()
    .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
}

function inline(text, opts) {
  let t = text;
  // inline code first (protect its contents from later transforms).
  // Sentinel is a long, random-ish token that won't appear in escaped HTML.
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `MDCODE${codes.length - 1}`;
  });
  // images ![alt](src) — before links, since an image contains a link's shape.
  // Off by default: an <img> in model output is a request to a remote server,
  // which the conversation has no reason to make on the user's behalf.
  if (opts && opts.images) {
    t = t.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, alt, src, title) => {
      const u = safeUrl(src, opts);
      if (!u) return m;
      const ttl = title ? ` title="${title}"` : "";
      // A relative source can't resolve against the app's own URL — the preview
      // rewrites data-rel into a real src once it knows the document's folder.
      const attr = /^https?:\/\//i.test(u) ? `src="${u}"` : `data-rel="${u}"`;
      return `<img class="md-img" ${attr} alt="${alt}"${ttl} loading="lazy">`;
    });
  }
  // links [text](url). A file-shaped target (when the host allows file links)
  // becomes an in-app file link with its path and line, so the click handler
  // can open the editor at that exact location instead of treating it as a URL.
  t = t.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (m, label, url) => {
    const u = safeUrl(url, opts);
    if (!u) return m;
    const fl = opts && opts.fileLinks && !/^https?:\/\//i.test(u) ? parseFileLink(u) : null;
    if (fl) {
      const p = fl.path.replace(/"/g, "&quot;");
      return `<a href="#" class="md-link md-file" data-path="${p}" data-line="${fl.line || ""}" data-col="${fl.col || ""}" title="Open ${p}${fl.line ? ":" + fl.line : ""}">${label}</a>`;
    }
    return `<a href="${u}" class="md-link" data-href="${u}">${label}</a>`;
  });
  // bold, italic, strikethrough
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // restore inline code — promote path-shaped tokens to clickable file links.
  t = t.replace(/MDCODE(\d+)/g, (_m, i) => {
    const c = codes[+i];
    if (looksLikeFilePath(c)) {
      const safe = c.replace(/"/g, "&quot;");
      return `<code class="md-code md-fp" data-fp="${safe}" title="Open ${safe}">${c}</code>`;
    }
    return `<code class="md-code">${c}</code>`;
  });
  return t;
}

// A markdown table separator row: | --- | :--: | ---: | (at least one column)
function isTableSep(line) {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}
// Split a table row into trimmed cells, honouring escaped \| and dropping the
// empty cells produced by optional leading/trailing pipes.
function splitRow(line) {
  let t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let k = 0; k < t.length; k++) {
    if (t[k] === "\\" && t[k + 1] === "|") { cur += "|"; k++; continue; }
    if (t[k] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += t[k];
  }
  cells.push(cur.trim());
  return cells;
}

/* One list item's text, with `- [ ]` / `- [x]` promoted to a checkbox. Rendered
 * as a styled span, not an <input>: nothing here is clickable, and a real
 * checkbox would promise an interaction the preview doesn't offer. */
function itemBody(text, opts) {
  const m = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!m) return inline(text, opts);
  const done = m[1].toLowerCase() === "x";
  return `<span class="md-task${done ? " done" : ""}"><span class="md-box">${done ? "✓" : ""}</span>${inline(m[2], opts)}</span>`;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/* Collect a whole list — every consecutive item plus the blank lines between
 * them — recording each one's indent depth. Reading the list in one pass is what
 * makes nesting possible; item-at-a-time flattened every sub-list into a
 * sibling, which is how most real documents render wrongly. */
function collectList(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) {
      // A blank line stays inside the list only if another item follows it.
      if (lines[i].trim() === "" && i + 1 < lines.length && LIST_RE.test(lines[i + 1])) { i++; continue; }
      break;
    }
    const indent = m[1].replace(/\t/g, "  ").length;
    const marker = m[2];
    items.push({ depth: indent >> 1, ordered: /\d/.test(marker), start: parseInt(marker, 10), text: m[3] });
    i++;
  }
  // Normalise to a zero base so a list that happens to start indented still
  // nests from its own outermost level rather than dropping items.
  const base = items.reduce((n, it) => Math.min(n, it.depth), Infinity);
  if (base > 0 && base < Infinity) for (const it of items) it.depth -= base;
  return { items, next: i };
}

// Turn the flat depth-tagged items into nested <ul>/<ol>.
function buildList(items, cur, depth, opts) {
  const ordered = items[cur.i].ordered;
  const first = items[cur.i].start;
  const parts = [];
  while (cur.i < items.length) {
    const it = items[cur.i];
    if (it.depth < depth) break;
    if (it.depth > depth) {
      // Deeper item — nest it inside the item just emitted (or start a list of
      // its own if the document opened at an indent).
      if (!parts.length) parts.push("");
      parts[parts.length - 1] += buildList(items, cur, it.depth, opts);
      continue;
    }
    if (it.ordered !== ordered) break;
    cur.i++;
    parts.push(itemBody(it.text, opts));
  }
  const tag = ordered ? "ol" : "ul";
  const attr = ordered && first > 1 ? ` start="${first}"` : "";
  return `<${tag}${attr}>` + parts.map((p) => `<li>${p}</li>`).join("") + `</${tag}>`;
}

export function renderMarkdown(src, opts) {
  if (!src) return "";
  const escaped = escapeHtml(String(src));
  const parts = escaped.split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // fenced code block
      const block = parts[i];
      const nl = block.indexOf("\n");
      let lang = "", code = block;
      if (nl !== -1) {
        const first = block.slice(0, nl).trim();
        if (/^[a-z0-9_+-]*$/i.test(first)) { lang = first; code = block.slice(nl + 1); }
      }
      code = code.replace(/\n$/, "");
      html += `<div class="codeblock"><div class="codeblock-bar"><span class="codeblock-lang">${lang || "code"}</span><button class="codeblock-copy" type="button">Copy</button></div><pre><code>${code}</code></pre></div>`;
    } else {
      html += renderBlocks(parts[i], opts);
    }
  }
  return html;
}

function renderBlocks(segment, opts) {
  const lines = segment.split("\n");
  let out = "";
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out += `<p>${inline(para.join(" ").trim(), opts)}</p>`;
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") { flushPara(); i++; continue; }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); out += "<hr/>"; i++; continue; }

    // headings. Ids are preview-only: they exist so a document's own #anchor
    // links land, and duplicating them across chat messages would be pointless.
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      const id = opts && opts.localLinks ? ` id="${slug(h[2])}"` : "";
      out += `<h${lvl} class="md-h"${id}>${inline(h[2], opts)}</h${lvl}>`;
      i++; continue;
    }

    // Setext heading — a line underlined with === or ---. Only when it starts a
    // paragraph; otherwise a --- after prose is the horizontal rule it looks like.
    if (para.length === 0 && !LIST_RE.test(line) && i + 1 < lines.length && /^(=+|-+)$/.test((lines[i + 1] || "").trim())) {
      const lvl = lines[i + 1].trim()[0] === "=" ? 1 : 2;
      const id = opts && opts.localLinks ? ` id="${slug(trimmed)}"` : "";
      out += `<h${lvl} class="md-h"${id}>${inline(trimmed, opts)}</h${lvl}>`;
      i += 2; continue;
    }

    // GFM table: a header row followed by a |---|---| separator
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const header = splitRow(trimmed);
      const aligns = splitRow(lines[i + 1].trim()).map((c) => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      const al = (n) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : "");
      let tbl = '<table class="md-table"><thead><tr>';
      header.forEach((c, n) => { tbl += `<th${al(n)}>${inline(c, opts)}</th>`; });
      tbl += "</tr></thead><tbody>";
      for (const r of rows) {
        tbl += "<tr>";
        for (let n = 0; n < header.length; n++) tbl += `<td${al(n)}>${inline(r[n] || "", opts)}</td>`;
        tbl += "</tr>";
      }
      tbl += "</tbody></table>";
      out += tbl;
      continue;
    }

    // blockquote. The source was HTML-escaped before parsing, so the marker to
    // match here is `&gt;`, not `>` — matching the raw character never fired.
    if (/^&gt;\s?/.test(trimmed)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^&gt;\s?/, "")); i++; }
      out += `<blockquote>${inline(buf.join(" "), opts)}</blockquote>`;
      continue;
    }

    // lists — ordered and unordered, at any depth, read as one block
    if (LIST_RE.test(line)) {
      flushPara();
      const { items, next } = collectList(lines, i);
      // Loop rather than one call: switching marker style (`-` then `1.`) with no
      // blank line between starts a second list, and every item must be consumed.
      const cur = { i: 0 };
      while (cur.i < items.length) out += buildList(items, cur, items[cur.i].depth, opts);
      i = next;
      continue;
    }

    para.push(trimmed);
    i++;
  }
  flushPara();
  return out;
}

export { escapeHtml, parseFileLink, looksLikeFilePath };
