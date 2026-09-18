"use strict";
/* Codex → Claude-style tool cards: pure helpers (unit-tested) used by claude.js.
 *
 *  unwrapCmd(cmd)          strip Codex's shell wrapper (powershell -Command '…', bash -lc '…')
 *  parseDiff(unified)      one file's unified diff → { oldText, newText, added, removed }
 *  classifyCmd(cmd, absp)  recognise reads / searches / listings / writes in a bare
 *                          command → { toolName, toolInput } (Read/Grep/Glob/Write) or null
 * Codex itself only classifies bash-shaped commands; on Windows (PowerShell) nearly
 * everything arrives as "unknown", so this fills the gap and the cards match what
 * Claude would show for the same action. */

const unq = (s) => String(s || "").trim().replace(/^["'`]|["'`]$/g, "");

function unwrapCmd(cmd) {
  let s = String(cmd || "").trim();
  const m = /^"?(?:[A-Za-z]:\\[^"]*?\\)?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+(?:\s+\w+)?\s+)*?-Command\s+([\s\S]+)$/i.exec(s)
    || /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(s);
  if (!m) return s;
  s = m[1].trim(); const q = s[0];
  if ((q === "'" || q === '"') && s.length > 1 && s.endsWith(q)) s = s.slice(1, -1);
  return s;
}

function parseDiff(diff) {
  const oldL = [], newL = []; let added = 0, removed = 0;
  for (const line of String(diff || "").split("\n")) {
    if (/^(diff |index |\+\+\+ |--- |@@ )/.test(line) || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+")) { newL.push(line.slice(1)); added++; }
    else if (line.startsWith("-")) { oldL.push(line.slice(1)); removed++; }
    else { const t = line.startsWith(" ") ? line.slice(1) : line; oldL.push(t); newL.push(t); }
  }
  return { oldText: oldL.join("\n"), newText: newL.join("\n"), added, removed };
}

// Tokenise respecting quotes.
const toks = (s) => String(s || "").match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) || [];

function classifyCmd(cmd, absp = (p) => p) {
  const c = String(cmd || "").trim();
  if (!c || /(\|\||&&|;)\s*\S/.test(c.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ""))) return null;   // compound commands stay Bash
  let m;
  // ---- reads
  if ((m = /^(?:cat|type|bat|less|more)\s+(?:-{1,2}[\w-]+(?:\s+\d+)?\s+)*([^|;&<>]+?)\s*$/.exec(c)) && !/\s/.test(unq(m[1]))) return { toolName: "Read", toolInput: { file_path: absp(unq(m[1])) } };
  if ((m = /^(?:Get-Content|gc)\b([\s\S]*)$/i.exec(c))) {
    const fp = /-(?:LiteralPath|Path)\s+(["']?)([^"'\s]+)\1/i.exec(m[1]) || /(?:^|\s)(["']?)([^-\s"'][^"'\s]*)\1(?=\s|$)/.exec(m[1]);
    if (fp) return { toolName: "Read", toolInput: { file_path: absp(fp[2]) } };
  }
  if ((m = /^sed\s+-n\s+["']?(\d+),(\d+)p["']?\s+(\S+)\s*$/.exec(c))) return { toolName: "Read", toolInput: { file_path: absp(unq(m[3])), offset: +m[1], limit: +m[2] - +m[1] + 1 } };
  if ((m = /^(?:head|tail)\s+(?:-n\s*\d+\s+|-\d+\s+|-c\s*\d+\s+)*([^\s|;&-][^\s|;&]*)\s*$/.exec(c))) return { toolName: "Read", toolInput: { file_path: absp(unq(m[1])) } };
  // ---- searches
  if ((m = /^(?:rg|grep|egrep|ag|ack)\s+([\s\S]+)$/.exec(c))) {
    const t = toks(m[1]);
    const valueFlags = /^-(?:e|g|t|T|A|B|C|m|-glob|-type|-max-count|-context|-regexp)$/;
    const pos = t.filter((tk, k) => !/^-/.test(tk) && !(k > 0 && valueFlags.test(t[k - 1])));
    const eIdx = t.findIndex((tk) => tk === "-e" || tk === "--regexp");
    const pattern = eIdx >= 0 ? t[eIdx + 1] : pos[0];
    const pathTok = pos.length > (eIdx >= 0 ? 0 : 1) ? pos[pos.length - 1] : null;
    return { toolName: "Grep", toolInput: { pattern: unq(pattern || m[1]), ...(pathTok && pathTok !== pattern ? { path: absp(unq(pathTok)) } : {}) } };
  }
  if ((m = /^(?:Select-String|sls)\b([\s\S]*)$/i.exec(c))) {
    const pat = /-Pattern\s+(["'])(.*?)\1/i.exec(m[1]) || /(["'])(.*?)\1/.exec(m[1]);
    const pth = /-Path\s+(["']?)([^"'\s]+)\1/i.exec(m[1]);
    return { toolName: "Grep", toolInput: { pattern: pat ? pat[2] : m[1].trim(), ...(pth ? { path: absp(pth[2]) } : {}) } };
  }
  if ((m = /^findstr\s+(?:\/\w+\s+)*(["']?)(.+?)\1(?:\s+(\S+))?\s*$/i.exec(c))) return { toolName: "Grep", toolInput: { pattern: m[2], ...(m[3] ? { path: absp(unq(m[3])) } : {}) } };
  // ---- listings
  if ((m = /^(?:ls|dir|tree|Get-ChildItem|gci|fd|find)\b\s*([\s\S]*)$/i.exec(c))) {
    const p0 = toks(m[1]).filter((tk) => !/^-/.test(tk))[0];
    const p = p0 ? unq(p0) : "";
    return { toolName: "Glob", toolInput: { pattern: (p ? p.replace(/[\\/]+$/, "") + "/" : "") + "*", ...(p ? { path: absp(p) } : {}) } };
  }
  // ---- writes
  if ((m = /^(?:Set-Content|Out-File|Add-Content|New-Item|sc|ni)\b([\s\S]*)$/i.exec(c))) {
    const fp = /-(?:LiteralPath|Path|FilePath)\s+(["']?)([^"'\s]+)\1/i.exec(m[1]) || /(?:^|\s)(["']?)([^-\s"'][^"'\s]*\.[A-Za-z0-9]{1,8})\1/.exec(m[1]);
    if (fp) return { toolName: "Write", toolInput: { file_path: absp(fp[2]) } };
  }
  if ((m = /\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText)\(\s*(["'])([^"']+)\1/i.exec(c))) return { toolName: "Write", toolInput: { file_path: absp(m[2]) } };
  if ((m = /(?:writeFileSync|writeFile|appendFileSync)\(\s*(["'`])([^"'`]+)\1/.exec(c))) return { toolName: "Write", toolInput: { file_path: absp(m[2]) } };
  if ((m = /(?:^|[^2&])>{1,2}\s*(["']?)([^\s"'|;&<>]+)\1\s*$/.exec(c)) && !/^\s*(?:rg|grep|git|npm)\b/.test(c)) return { toolName: "Write", toolInput: { file_path: absp(m[2]) } };
  if ((m = /\|\s*(?:tee|Out-File|Set-Content|Add-Content)\b([\s\S]*)$/i.exec(c))) {   // … | Out-File -FilePath x -Encoding utf8  /  … | tee -a x
    const fp = /-(?:LiteralPath|Path|FilePath)\s+(["']?)([^"'\s]+)\1/i.exec(m[1]) || /(?:^|\s)(["']?)([^-\s"'][^"'\s]*)\1(?=\s|$)/.exec(m[1]);
    if (fp) return { toolName: "Write", toolInput: { file_path: absp(fp[2]) } };
  }
  return null;
}

module.exports = { unwrapCmd, parseDiff, classifyCmd };
