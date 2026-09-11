/* Pure unified-diff parsing + word-level (intra-line) diffing for the diff
 * viewer. No DOM — easy to reason about and test. */

// Parse `git diff` unified output into hunks of typed lines, tracking old/new
// line numbers and counting additions/deletions.
//
// The parser is STATEFUL: file headers (`diff --git`, `index`, `---`, `+++`,
// `rename from`…) are only recognised OUTSIDE a hunk, and inside a hunk every
// line is classified by its first byte alone, with the hunk's declared old/new
// counts deciding when the hunk ends. So a source line that happens to start
// with `-- ` (SQL comment), `++ ` (C increment), `index ` or `rename ` is kept
// as content instead of being dropped — the rendered diff has exactly the lines
// git produced.
export function parseUnifiedDiff(text) {
  const out = { hunks: [], adds: 0, dels: 0, binary: false, files: 0 };
  if (!text) return out;
  let hunk = null, oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();               // trailing split artifact
  for (const raw of lines) {
    const inHunk = hunk && (oldLeft > 0 || newLeft > 0);
    if (!inHunk) {
      hunk = null;
      if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) { out.binary = true; continue; }
      if (raw.startsWith("diff --git ")) { out.files++; continue; }
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (hm) {
        oldNo = parseInt(hm[1], 10); newNo = parseInt(hm[3], 10);
        oldLeft = hm[2] == null ? 1 : parseInt(hm[2], 10);
        newLeft = hm[4] == null ? 1 : parseInt(hm[4], 10);
        hunk = { header: `@@ -${hm[1]}${hm[2] != null ? "," + hm[2] : ""} +${hm[3]}${hm[4] != null ? "," + hm[4] : ""} @@${hm[5] ? " " + hm[5].trim() : ""}`, lines: [] };
        out.hunks.push(hunk);
        continue;
      }
      // file-level metadata (index, ---, +++, mode, similarity, rename, copy, new/deleted file…)
      continue;
    }
    const sign = raw[0], content = raw.slice(1);
    if (sign === "+") { hunk.lines.push({ type: "+", oldNo: null, newNo, text: content }); newNo++; newLeft--; out.adds++; }
    else if (sign === "-") { hunk.lines.push({ type: "-", oldNo, newNo: null, text: content }); oldNo++; oldLeft--; out.dels++; }
    else if (sign === "\\") { /* "\ No newline at end of file" — annotation, not a line */ }
    else if (sign === " " || raw === "") { hunk.lines.push({ type: " ", oldNo, newNo, text: content }); oldNo++; newNo++; oldLeft--; newLeft--; }
    else {
      // Not a valid hunk body line (a truncated or hand-edited patch): the hunk is over.
      oldLeft = newLeft = 0; hunk = null;
      if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) out.binary = true;
      else if (raw.startsWith("diff --git ")) out.files++;
    }
  }
  return out;
}

function tokenize(s) { return s.match(/(\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+)/g) || []; }

// Word-level diff between an old and new line → token arrays each flagged with
// `ch` (changed). Used to highlight exactly what changed inside a modified line.
// Very long lines fall back to a cheap common-prefix/suffix split (still exact
// about what is shared at both ends) instead of marking everything changed.
export function wordDiff(oldStr, newStr) {
  const a = tokenize(oldStr), b = tokenize(newStr);
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return { old: a.map((t) => ({ t, ch: true })), new: b.map((t) => ({ t, ch: true })) };
  if (n * m > 60000) {
    let p = 0; while (p < n && p < m && a[p] === b[p]) p++;
    let s = 0; while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
    const mark = (arr, len) => arr.map((t, i) => ({ t, ch: !(i < p || i >= len - s) }));
    return { old: mark(a, n), new: mark(b, m), approximate: true };
  }
  // LCS table (bottom-up) → backtrack to mark non-common tokens as changed.
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const oldOut = [], newOut = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { oldOut.push({ t: a[i], ch: false }); newOut.push({ t: b[j], ch: false }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { oldOut.push({ t: a[i], ch: true }); i++; }
    else { newOut.push({ t: b[j], ch: true }); j++; }
  }
  while (i < n) oldOut.push({ t: a[i++], ch: true });
  while (j < m) newOut.push({ t: b[j++], ch: true });
  return { old: oldOut, new: newOut };
}

// Turn a hunk's lines into render-ready rows for both views in one pass:
//  - unified: original order (deletions then additions), word-diff on paired lines
//  - split:   paired deletions+additions become one "mod" row (side by side)
export function processHunk(lines) {
  const unified = [], split = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.type === " ") {
      unified.push({ kind: "ctx", oldNo: ln.oldNo, newNo: ln.newNo, text: ln.text });
      split.push({ kind: "ctx", old: { no: ln.oldNo, text: ln.text }, new: { no: ln.newNo, text: ln.text } });
      i++; continue;
    }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].type === "-") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "+") adds.push(lines[i++]);
    const pc = Math.min(dels.length, adds.length);
    const wds = [];
    for (let k = 0; k < pc; k++) wds[k] = wordDiff(dels[k].text, adds[k].text);
    dels.forEach((d, k) => unified.push({ kind: "del", oldNo: d.oldNo, parts: k < pc ? wds[k].old : null, text: d.text }));
    adds.forEach((a, k) => unified.push({ kind: "add", newNo: a.newNo, parts: k < pc ? wds[k].new : null, text: a.text }));
    for (let k = 0; k < pc; k++) split.push({ kind: "mod", old: { no: dels[k].oldNo, parts: wds[k].old }, new: { no: adds[k].newNo, parts: wds[k].new } });
    for (let k = pc; k < dels.length; k++) split.push({ kind: "del", old: { no: dels[k].oldNo, text: dels[k].text }, new: null });
    for (let k = pc; k < adds.length; k++) split.push({ kind: "add", old: null, new: { no: adds[k].newNo, text: adds[k].text } });
  }
  return { unified, split };
}
