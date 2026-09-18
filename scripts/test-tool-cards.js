"use strict";
/* Tool-card regression suite — the live cards the chat shows for BOTH harnesses:
 *   · Claude Agent SDK: a tool_use block is announced ("preparing") before its JSON
 *     arguments finish streaming; fields fill in as they arrive (src/main/tool-args.js).
 *   · Codex app-server: thread items are mapped to the same card shapes (Read/Grep/Glob/
 *     Write/Edit/Delete/Bash/mcp:server/tool) by claude.js + src/main/codex-cards.js.
 * Desired behaviour asserted: no "undefined" in any summary, file links appear (and are
 * upgraded IN PLACE once the path streams in), Grep/Glob paths link to the folder search
 * or the file, MCP names from both harnesses split into server tag + tool, renames rebuild.
 * Runs against the ORIGINAL renderer functions extracted from app.js in headless Chromium
 * with stubbed app services. Never launches the app.  Run: node scripts/test-tool-cards.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ts = require("typescript");
const { chromium } = require("playwright");
const cards = require("../src/main/providers/codex-cards");
const { partialToolInput } = require("../src/main/session/tool-args");

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 500) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 180000);

/* ------------------------------ Node: streaming arguments (Claude) ------------------------------ */
{
  const p = partialToolInput;
  check("A01", "complete fields are extracted while a later string is still streaming", JSON.stringify(p('{"file_path": "C:\\\\proj\\\\src\\\\a.js", "old_string": "abc')) === JSON.stringify({ file_path: "C:\\proj\\src\\a.js" }), p('{"file_path": "C:\\\\proj\\\\src\\\\a.js", "old_string": "abc'));
  check("A02", "an unterminated string is never guessed", JSON.stringify(p('{"command": "echo \\"hi\\" && ls')) === "{}");
  check("A03", "nested objects' fields do not leak to the top level", JSON.stringify(p('{"file_path":"f.py","edits":[{"old_string":"a","new_string":"b"}],"x":"y')) === JSON.stringify({ file_path: "f.py" }));
  check("A04", "numbers / booleans are skipped, later strings still read", JSON.stringify(p('{"offset": 10, "limit": 40, "file_path": "p.txt", "raw": true, "pattern": "x')) === JSON.stringify({ file_path: "p.txt" }));
  check("A05", "escapes decode like JSON", p('{"command": "echo \\"a\\tb\\"", "description": "run"').command === 'echo "a\tb"' && p('{"command": "echo \\"a\\tb\\"", "description": "run"').description === "run");
  check("A06", "a fully parsed object yields every top-level string", JSON.stringify(p('{"pattern":"TODO","path":"C:\\\\p","glob":"*.js"}')) === JSON.stringify({ pattern: "TODO", path: "C:\\p", glob: "*.js" }));
  check("A07", "empty / garbage input is safe", JSON.stringify(p("")) === "{}" && JSON.stringify(p("{")) === "{}" && JSON.stringify(p('{"a"')) === "{}");
  const big = '{"file_path":"w.txt","content":"' + "x".repeat(200000);
  const t0 = Date.now(); const r = p(big); const ms = Date.now() - t0;
  check("A08", "a 200 KB streaming body scans quickly and yields the finished field", r.file_path === "w.txt" && !("content" in r) && ms < 200, { ms });
}
/* ------------------------------ Node: Codex command → card mapping ------------------------------ */
{
  const absp = (x) => (x && !/^[A-Za-z]:|^\//.test(x) ? "C:\\proj\\" + x : x);
  const c1 = cards.classifyCmd("cat src/a.js", absp);
  check("C01", "cat → Read with an absolute file path", c1 && c1.toolName === "Read" && c1.toolInput.file_path === "C:\\proj\\src/a.js", c1);
  const c2 = cards.classifyCmd("rg -n TODO src", absp);
  check("C02", "rg → Grep with pattern + path", c2 && c2.toolName === "Grep" && c2.toolInput.pattern === "TODO" && c2.toolInput.path === "C:\\proj\\src", c2);
  const c3 = cards.classifyCmd("sed -n '10,40p' src/b.js", absp);
  check("C03", "sed -n range → Read with offset/limit", c3 && c3.toolName === "Read" && c3.toolInput.offset === 10 && c3.toolInput.limit === 31, c3);
  check("C04", "compound commands stay Bash (null → caller uses Bash)", cards.classifyCmd("cat a.txt && cat b.txt", absp) === null && cards.classifyCmd("ls; rm -rf x", absp) === null);
  const c5 = cards.classifyCmd('echo hi > out.txt', absp);
  check("C05", "shell redirect → Write to the target file", c5 && c5.toolName === "Write" && c5.toolInput.file_path === "C:\\proj\\out.txt", c5);
  const c6 = cards.classifyCmd('findstr /s /i "needle" src\\*.js', absp);
  check("C06", "findstr → Grep", c6 && c6.toolName === "Grep" && c6.toolInput.pattern === "needle", c6);
  check("C07", "PowerShell / bash wrappers are unwrapped", cards.unwrapCmd("powershell -NoProfile -Command 'Get-Content a.txt'") === "Get-Content a.txt" && cards.unwrapCmd("bash -lc 'ls -la'") === "ls -la" && cards.unwrapCmd("npm test") === "npm test");
  const d = cards.parseDiff("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n other");
  check("C08", "unified diff → before/after text with counts", d.oldText === "keep\nold line\nother" && d.newText === "keep\nnew line\nother" && d.added === 1 && d.removed === 1, d);
}

/* ------------------------------ Chromium: the cards themselves ------------------------------ */
const R = require("./lib/renderer-src");   // the ORIGINAL renderer modules (src/renderer/app.js + feature folders)
const fn = R.fn, constLine = R.constLine, css = R.css();
// … plus the workflow job card (chat/messages.js: a `role: "job"` message the planner's chat shows for a
// delegated Coder / Reviewer / Tester job, patched in place through session:message-update / workflow:job).
const extracted = ["h", "relPath", "baseName", "fmtElapsed", "fmtCompactTok", "toolStateHtml", "patchToolCard", "revealToolDetail", "splitToolName", "toolCard", "mcpResultSize", "toolSummaryEl", "editStats", "openPathTarget", "toolSummary", "toolDetail", "toolIcon", "isAgentTool", "agentHue", "agentBadge", "agentInfoBtn", "agentProgressEl",
  "fmtSpan", "roleMeta", "jobStatusOf", "jobRoleOf", "jobStartMs", "jobElapsedMs", "jobStatusHtml", "jobMetaEl", "jobResultEl", "jobFilesEl", "jobActsEl", "jobCard", "patchJobCard", "startJobTicker", "stopJobTicker"].map(fn).join("\n")
  + "\n" + ["FILE_TOOLS", "PATH_TOOLS", "PROVIDER_NAME", "ROLE_META", "ACCESS_LABEL", "JOB_TERMINAL", "JOB_PREVIEW_CHARS"].map((n) => constLine(n)).join("\n");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<!doctype html><html><body><div id="chatMessages"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: `(() => {
    window.calls = []; window.dirs = new Set();
    const icon = (n, s) => '<svg class="icon" data-icon="' + n + '" width="' + (s || 14) + '"></svg>';
    const openInEditor = (p) => calls.push({ op: "openInEditor", p });
    const openEditAtChange = (p, m) => calls.push({ op: "openEditAtChange", p, tool: m.toolName });
    const fileContextMenu = (ev, e) => calls.push({ op: "menu", e });
    const openSearch = (o) => calls.push({ op: "openSearch", o });
    // job-card collaborators: markdown + model naming stubbed, the tab opener / stop call recorded
    const renderMarkdown = (t) => "<p>" + String(t || "").replace(/</g, "&lt;") + "</p>";
    const modelName = (p, id) => id || "";
    const openSessionTab = (id) => calls.push({ op: "openSessionTab", id });
    const toast = (msg, ic) => calls.push({ op: "toast", msg, ic });
    let _jobTicker = null;
    const atom = { files: { list: async (p) => { if (window.dirs.has(p)) return []; throw new Error("ENOTDIR"); } }, workflow: { stop: async (id) => { calls.push({ op: "stopJob", id }); return { ok: true }; } } };
    ${extracted}
    window.T = { h, toolCard, patchToolCard, revealToolDetail, toolSummary, toolSummaryEl, toolDetail, splitToolName, toolIcon, openPathTarget, jobCard, patchJobCard, stopJobTicker };
  })();` });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

  const r = await page.evaluate(async () => {
    const out = {};
    const ts = { meta: { cwd: "C:\\proj" } };
    const wrap = (m) => { const node = T.h("div", { class: "msg flow", dataset: { mid: m.id } }, T.toolCard(m, ts)); document.getElementById("chatMessages").append(node); return node; };
    const txt = (node) => node.querySelector(".tool-summary").textContent;
    const sumEl = (node) => node.querySelector(".tool-summary");
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // U1: a preparing Edit (Claude: tool_use announced, arguments still streaming)
    const e1 = { id: "e1", role: "tool", toolName: "Edit", toolInput: {}, status: "preparing" };
    const n1 = wrap(e1);
    out.U1 = { text: txt(n1), undef: /undefined|null/.test(n1.textContent), icon: n1.querySelector(".tool-ico svg").dataset.icon };
    // U2: the path streams in (partial fields) → the same DOM node gets a clickable link
    const card1 = n1.querySelector(".tool-card");
    Object.assign(e1, { toolInput: { file_path: "C:\\proj\\taxy\\consults\\OWNER_DECISIONS.md" }, partialInput: '{"file_path": "C:\\\\proj\\\\taxy\\\\consults\\\\OWNER_DECISIONS.md", "old_string": "## §15' });
    const patched1 = T.patchToolCard(n1, e1, ts);
    // collapsed while streaming → the detail is left stale (no rebuild per fragment); expanding rebuilds it
    const lazyBefore = n1.querySelector(".tool-detail").textContent.includes("Arguments (streaming)"), stale = card1.dataset.detailStale;
    card1.classList.add("open"); const revealed = T.revealToolDetail(card1, e1);
    out.U2 = { patched: patched1, sameCard: n1.querySelector(".tool-card") === card1, isLink: sumEl(n1).classList.contains("file-link"), text: txt(n1), lazyBefore, stale, revealed, detail: n1.querySelector(".tool-detail").textContent.includes("Arguments (streaming)") };
    card1.classList.remove("open");
    // U3: the complete call arrives (status running) → still a link, detail shows Before/After; done keeps it
    Object.assign(e1, { toolInput: { file_path: "C:\\proj\\taxy\\consults\\OWNER_DECISIONS.md", old_string: "## §15 old", new_string: "## §15 new" }, status: "running", partialInput: undefined });
    const patched2 = T.patchToolCard(n1, e1, ts);
    Object.assign(e1, { status: "done", result: "The file has been updated." });
    const patched3 = T.patchToolCard(n1, e1, ts);
    out.U3 = { patched: patched2 && patched3, isLink: sumEl(n1).classList.contains("file-link"), text: txt(n1), before: n1.querySelector(".det-old") && n1.querySelector(".det-old").textContent, after: n1.querySelector(".det-new") && n1.querySelector(".det-new").textContent, state: n1.querySelector(".tool-state").className };
    sumEl(n1).click(); await tick();
    out.U3.click = calls.at(-1);
    // U4: Read card — preparing, then the path, then the link opens the editor
    const r1 = { id: "r1", role: "tool", toolName: "Read", toolInput: {}, status: "preparing" };
    const n2 = wrap(r1);
    const before = txt(n2);
    Object.assign(r1, { toolInput: { file_path: "C:\\proj\\src\\app.js" } });
    T.patchToolCard(n2, r1, ts);
    sumEl(n2).click(); await tick();
    out.U4 = { before, isLink: sumEl(n2).classList.contains("file-link"), text: txt(n2), click: calls.at(-1) };
    // U5: Grep — pattern + folder path → folder link opens the search panel scoped + prefilled; a file path opens the editor
    window.dirs.add("C:\\proj\\src");
    const g1 = { id: "g1", role: "tool", toolName: "Grep", toolInput: { pattern: "TODO", path: "C:\\proj\\src" }, status: "running" };
    const n3 = wrap(g1);
    n3.querySelector(".path-link").click(); await tick(); await tick();
    const grepClick = calls.at(-1);
    const g2 = { id: "g2", role: "tool", toolName: "Grep", toolInput: { pattern: "TODO", path: "C:\\proj\\src\\a.js" }, status: "done" };
    const n4 = wrap(g2);
    n4.querySelector(".path-link").click(); await tick(); await tick();
    out.U5 = { text: txt(n3), linkText: n3.querySelector(".path-link").textContent, grepClick, fileClick: calls.at(-1) };
    // U6: Grep preparing (no fields) → no "undefined"; pattern-only Grep has no link but text
    const g3 = { id: "g3", role: "tool", toolName: "Grep", toolInput: {}, status: "preparing" };
    const n5 = wrap(g3);
    Object.assign(g3, { toolInput: { pattern: "needle" } }); const p5 = T.patchToolCard(n5, g3, ts);
    out.U6 = { prep: /undefined/.test(n5.textContent), text: txt(n5), patched: p5 };
    // U7: every tool name with EMPTY input renders without "undefined"/"null"
    const names = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Delete", "Bash", "Grep", "Glob", "Task", "WebFetch", "WebSearch", "TodoWrite", "mcp__memory__search", "mcp:github/list_issues", "CustomTool"];
    out.U7 = names.map((tn) => { const n = wrap({ id: "x-" + tn, role: "tool", toolName: tn, toolInput: {}, status: "preparing" }); return { tn, bad: /undefined|null/.test(n.textContent), text: txt(n) }; });
    // U8: MCP names from both harnesses → server tag + tool name; patch stays in place
    const m1 = { id: "m1", role: "tool", toolName: "mcp__memory__search", toolInput: { query: "cats" }, status: "running" };
    const n6 = wrap(m1); const p6 = T.patchToolCard(n6, { ...m1, status: "done", result: "3 hits" }, ts);
    const m2 = { id: "m2", role: "tool", toolName: "mcp:github/list_issues", toolInput: { repo: "a/b" }, status: "running" };
    const n7 = wrap(m2); const p7 = T.patchToolCard(n7, { ...m2, status: "done", result: "[]" }, ts);
    out.U8 = { claude: { tag: n6.querySelector(".tool-mcp-tag") && n6.querySelector(".tool-mcp-tag").textContent, name: n6.querySelector(".tool-name").textContent, inPlace: p6 }, codex: { tag: n7.querySelector(".tool-mcp-tag") && n7.querySelector(".tool-mcp-tag").textContent, name: n7.querySelector(".tool-name").textContent, inPlace: p7 } };
    // U9: Bash preparing → command patched in place; Codex rename Bash → Read at completion → rebuild (patch refuses)
    const b1 = { id: "b1", role: "tool", toolName: "Bash", toolInput: {}, status: "preparing" };
    const n8 = wrap(b1); const t8a = txt(n8);
    Object.assign(b1, { toolInput: { command: "npm test" }, status: "running" }); const p8 = T.patchToolCard(n8, b1, ts);
    const renamed = { ...b1, toolName: "Read", toolInput: { file_path: "C:\\proj\\README.md", command: "cat README.md" }, status: "done", result: "# hi" };
    const p8b = T.patchToolCard(n8, renamed, ts);
    const rebuilt = T.toolCard(renamed, ts);
    out.U9 = { prep: t8a, text: txt(n8), patched: p8, renameRefused: p8b === false, rebuiltLink: rebuilt.querySelector(".tool-summary").classList.contains("file-link"), rebuiltText: rebuilt.querySelector(".tool-summary").textContent };
    // U10: Codex Delete card
    const d1 = { id: "d1", role: "tool", toolName: "Delete", toolInput: { file_path: "C:\\proj\\old.txt" }, status: "done", result: "Deleted old.txt" };
    const n9 = wrap(d1);
    out.U10 = { text: txt(n9), icon: n9.querySelector(".tool-ico svg").dataset.icon, detail: n9.querySelector(".tool-detail").textContent.includes("Deleted file") };
    // U11: Write with streamed path becomes a link — the path alone (the action is the card's tool name, 2026-09-17)
    const w1 = { id: "w1", role: "tool", toolName: "Write", toolInput: {}, status: "preparing" };
    const n10 = wrap(w1); Object.assign(w1, { toolInput: { file_path: "C:\\proj\\new.md" } }); T.patchToolCard(n10, w1, ts);
    out.U11 = { text: txt(n10), isLink: sumEl(n10).classList.contains("file-link") };
    // U13: a COLLAPSED card streaming a big Write keeps its detail node across hundreds of updates
    // (no rebuild per fragment); an OPEN card rebuilds; the streaming label shows the byte count
    const w2 = { id: "w2", role: "tool", toolName: "Write", toolInput: { file_path: "C:\\proj\\big.txt" }, status: "preparing", partialInput: "" };
    const n11 = wrap(w2); const card11 = n11.querySelector(".tool-card"); const det0 = card11.querySelector(".tool-detail");
    const t0 = performance.now();
    for (let k = 1; k <= 300; k++) { w2.partialInput = '{"file_path":"C:\\\\proj\\\\big.txt","content":"' + "x".repeat(k * 20); w2.partialBytes = w2.partialInput.length; T.patchToolCard(n11, w2, ts); }
    const collapsedMs = Math.round(performance.now() - t0);
    const sameDetail = card11.querySelector(".tool-detail") === det0, staleFlag = card11.dataset.detailStale;
    card11.classList.add("open"); T.revealToolDetail(card11, w2);
    const openLabel = card11.querySelector(".det-label").textContent;
    T.patchToolCard(n11, w2, ts); const rebuiltWhenOpen = card11.querySelector(".tool-detail") !== det0;
    out.U13 = { sameDetail, staleFlag, collapsedMs, openLabel, rebuiltWhenOpen };
    // U14: the spinner element SURVIVES heartbeats (no animation restart); queued → running → done swap the icon
    const b2 = { id: "b2", role: "tool", toolName: "Bash", toolInput: { command: "npm test" }, status: "running" };
    const n12 = wrap(b2); const spin0 = n12.querySelector(".tool-state .spinner");
    for (let s = 1; s <= 5; s++) { b2.elapsedSeconds = s; T.patchToolCard(n12, b2, ts); }
    const sameSpinner = n12.querySelector(".tool-state .spinner") === spin0, elapsed = n12.querySelector(".tool-elapsed") && n12.querySelector(".tool-elapsed").textContent;
    const q1 = { id: "q1", role: "tool", toolName: "Write", toolInput: { file_path: "C:\\proj\\out.txt", content: "x" }, status: "queued" };
    const n13 = wrap(q1); const qState = n13.querySelector(".tool-state");
    const queued = { cls: qState.className, dot: !!qState.querySelector(".queued-dot"), spinner: !!qState.querySelector(".spinner"), title: qState.title, cardCls: n13.querySelector(".tool-card").className, text: txt(n13) };
    Object.assign(q1, { status: "running" }); T.patchToolCard(n13, q1, ts);
    const running = { state: n13.querySelector(".tool-state").dataset.state, spinner: !!n13.querySelector(".tool-state .spinner") };
    Object.assign(q1, { status: "done", result: "written" }); T.patchToolCard(n13, q1, ts);
    const done = { state: n13.querySelector(".tool-state").dataset.state, check: !!n13.querySelector(".tool-state svg") };
    out.U14 = { sameSpinner, elapsed, queued, running, done };
    // U15: a workflow job card — running (role badge, task, descriptor line, turning ring, Stop) → patched IN PLACE
    // to done (status class, recorded elapsed, result preview + "Show all", file chips, Stop hidden)
    const j1 = { id: "j1", role: "job", jobId: "job-1", jobRole: "coder", text: "Implement the login form\nwith validation and tests", ts: new Date(Date.now() - 65000).toISOString(), meta: { provider: "anthropic", model: "claude-opus-4-1", effort: "high", access: "bypassPermissions", agents: 3, sessionId: "child-1", status: "running" } };
    const n15 = T.h("div", { class: "msg flow", dataset: { mid: j1.id } }, T.jobCard(j1, ts)); document.getElementById("chatMessages").append(n15);
    const c15 = n15.querySelector(".job-card");
    const vis = (sel) => { const e = c15.querySelector(sel); return !!e && getComputedStyle(e).display !== "none"; };
    const jrun = { cls: c15.className, job: c15.dataset.job, role: c15.querySelector(".job-role").textContent, roleIcon: c15.querySelector(".job-role svg").dataset.icon, task: c15.querySelector(".job-task").textContent, meta: c15.querySelector(".job-meta").textContent, elapsed: c15.querySelector(".job-elapsed").textContent, ring: !!c15.querySelector(".job-status.running .job-ring"), stopVisible: vis(".job-stop"), result: !!c15.querySelector(".job-result"), bad: /undefined|null|NaN/.test(c15.textContent) };
    c15.querySelector(".job-open").click(); const openCall = calls.at(-1);
    c15.querySelector(".job-stop").click(); await tick(); const stopCall = calls.find((c) => c.op === "stopJob");
    const ring0 = c15.querySelector(".job-ring");
    Object.assign(j1.meta, { agentsLive: { running: 2, total: 3 } }); T.patchJobCard(n15, j1, ts);   // a heartbeat-style patch: same status → the ring element survives
    const sameRing = c15.querySelector(".job-ring") === ring0, liveAgents = c15.querySelector(".job-meta").textContent;
    Object.assign(j1.meta, { status: "done", durationMs: 65000, result: "Done. " + "x".repeat(700), editedFiles: [{ path: "C:\\proj\\src\\login.js", count: 2, added: 40, removed: 3 }, { path: "C:\\proj\\src\\login.css", count: 1, added: 12, removed: 0 }] });
    const p15 = T.patchJobCard(n15, j1, ts);
    const jdone = { patched: p15, sameCard: n15.querySelector(".job-card") === c15, cls: c15.className, state: c15.querySelector(".job-status").dataset.state, elapsed: c15.querySelector(".job-elapsed").textContent, preview: c15.querySelector(".job-result-body").textContent, more: c15.querySelector(".job-result-more") && c15.querySelector(".job-result-more").textContent, files: [...c15.querySelectorAll(".job-file .jf-name")].map((e) => e.textContent), stats: [...c15.querySelectorAll(".job-file .jf-stat")].map((e) => e.textContent), metaFiles: c15.querySelector(".job-meta").textContent, stopVisible: vis(".job-stop") };
    c15.querySelector(".job-file").click(); jdone.fileClick = calls.at(-1);
    out.U15 = { jrun, openCall, stopCall, sameRing, liveAgents, jdone };
    // U16: "Show all" expands the result; a same-text patch keeps that node open; an error patch shows the error line
    c15.querySelector(".job-result-more").click();
    const expanded = c15.querySelector(".job-result-body").textContent.length, moreLbl = c15.querySelector(".job-result-more").textContent;
    const resNode = c15.querySelector(".job-result"); T.patchJobCard(n15, j1, ts);
    const keptResult = c15.querySelector(".job-result") === resNode && resNode.classList.contains("open");
    Object.assign(j1.meta, { status: "error", error: "Tests failed: 2 of 10", result: "" });
    T.patchJobCard(n15, j1, ts);
    out.U16 = { expanded, moreLbl, keptResult, cls: c15.className, state: c15.querySelector(".job-status").dataset.state, err: c15.querySelector(".job-error") && c15.querySelector(".job-error").textContent, body: !!c15.querySelector(".job-result-body"), stopVisible: vis(".job-stop") };
    T.stopJobTicker();
    return out;
  });

  check("U1", "preparing Edit shows 'preparing…' (never undefined) with the pencil icon", r.U1.text === "preparing…" && !r.U1.undef && r.U1.icon === "pencil", r.U1);
  check("U2", "streamed path upgrades the summary to a file link IN PLACE (same card node); the collapsed detail is left stale and rebuilt on expand", r.U2.patched && r.U2.sameCard && r.U2.isLink && r.U2.text === "taxy/consults/OWNER_DECISIONS.md" && !r.U2.lazyBefore && r.U2.stale === "1" && r.U2.revealed && r.U2.detail, r.U2);
  check("U3", "complete call keeps the link and gains the line counts (+1 −1 — added in green, removed in red, 2026-09-17); detail shows before/after; done state; click jumps to the change", r.U3.patched && r.U3.isLink && r.U3.text === "taxy/consults/OWNER_DECISIONS.md+1−1" && r.U3.before === "## §15 old" && r.U3.after === "## §15 new" && /done/.test(r.U3.state) && r.U3.click && r.U3.click.op === "openEditAtChange" && /OWNER_DECISIONS/.test(r.U3.click.p), r.U3);
  check("U4", "Read card: preparing → link → click opens the editor", r.U4.before === "preparing…" && r.U4.isLink && r.U4.text === "src/app.js" && r.U4.click && r.U4.click.op === "openInEditor" && /app\.js$/.test(r.U4.click.p), r.U4);
  check("U5", "Grep: 'pattern in <path>' — folder → search panel (scoped, prefilled), file → editor", r.U5.text === "TODO in src" && r.U5.linkText === "src" && r.U5.grepClick && r.U5.grepClick.op === "openSearch" && r.U5.grepClick.o.root === "C:\\proj\\src" && r.U5.grepClick.o.query === "TODO" && r.U5.fileClick && r.U5.fileClick.op === "openInEditor" && /a\.js$/.test(r.U5.fileClick.p), r.U5);
  check("U6", "Grep without fields yet has no 'undefined'; pattern-only Grep patches in place", !r.U6.prep && r.U6.text === "needle" && r.U6.patched, r.U6);
  check("U7", "every tool with empty input renders without undefined/null", r.U7.every((x) => !x.bad), r.U7.filter((x) => x.bad));
  check("U8", "MCP names: Claude mcp__srv__tool and Codex mcp:srv/tool both show tag + tool and patch in place", r.U8.claude.tag === "memory" && r.U8.claude.name === "search" && r.U8.claude.inPlace && r.U8.codex.tag === "github" && r.U8.codex.name === "list_issues" && r.U8.codex.inPlace, r.U8);
  check("U9", "Bash fills in in place; a Codex rename to Read is a rebuild that carries a file link", r.U9.prep === "preparing…" && r.U9.text === "npm test" && r.U9.patched && r.U9.renameRefused && r.U9.rebuiltLink && r.U9.rebuiltText === "README.md", r.U9);
  check("U10", "Codex Delete card: the path alone (the action is the tool name — no ' · delete' repeat), trash icon, detail label", r.U10.text === "old.txt" && r.U10.icon === "trash" && r.U10.detail, r.U10);
  check("U11", "Write: streamed path → a link with the path alone (no ' · write' repeat of the tool name)", r.U11.text === "new.md" && r.U11.isLink, r.U11);
  check("U13", "a collapsed streaming card keeps its detail node across 300 updates; an open card rebuilds; the label shows the streamed size", r.U13.sameDetail && r.U13.staleFlag === "1" && r.U13.collapsedMs < 1500 && /Arguments \(streaming\) · .*chars so far/.test(r.U13.openLabel) && r.U13.rebuiltWhenOpen, r.U13);
  check("U14", "the spinner element survives five heartbeat patches (smooth animation); a queued card shows a waiting dot, then swaps to spinner and check as it runs and finishes", r.U14.sameSpinner && r.U14.elapsed === "5s" && /queued/.test(r.U14.queued.cls) && r.U14.queued.dot && !r.U14.queued.spinner && /Waiting/.test(r.U14.queued.title) && /tool-card queued/.test(r.U14.queued.cardCls) && r.U14.queued.text === "out.txt+1−0" && r.U14.running.state === "running" && r.U14.running.spinner && r.U14.done.state === "done" && r.U14.done.check, r.U14);
  check("U15", "job card: running shows the Coder badge, the task, 'Claude · model · high effort · Full access · 3 agents', a turning ring and Stop; Open tab / Stop call through; a same-status patch keeps the ring; done is patched IN PLACE with the recorded elapsed, a 600-char preview + Show all, file chips (click opens) and no Stop",
    r.U15.jrun.cls === "job-card st-running role-coder" && r.U15.jrun.job === "job-1" && r.U15.jrun.role === "Coder" && r.U15.jrun.roleIcon === "fileCode" && /Implement the login form/.test(r.U15.jrun.task) && r.U15.jrun.meta === "Claude·claude-opus-4-1·high effort·Full access·3 agents" && r.U15.jrun.elapsed === "1m 05s" && r.U15.jrun.ring && r.U15.jrun.stopVisible && !r.U15.jrun.result && !r.U15.jrun.bad
    && r.U15.openCall && r.U15.openCall.op === "openSessionTab" && r.U15.openCall.id === "child-1" && r.U15.stopCall && r.U15.stopCall.id === "job-1" && r.U15.sameRing && /2 of 3 agents running/.test(r.U15.liveAgents)
    && r.U15.jdone.patched && r.U15.jdone.sameCard && r.U15.jdone.cls === "job-card st-done role-coder" && r.U15.jdone.state === "done" && r.U15.jdone.elapsed === "1m 05s" && r.U15.jdone.preview.startsWith("Done. ") && r.U15.jdone.preview.length < 700 && /Show all/.test(r.U15.jdone.more || "") && r.U15.jdone.files.join(",") === "src/login.js,src/login.css" && r.U15.jdone.stats[0] === "+40 −3" && /2 files edited/.test(r.U15.jdone.metaFiles) && !r.U15.jdone.stopVisible && r.U15.jdone.fileClick && r.U15.jdone.fileClick.op === "openInEditor" && /login\.js$/.test(r.U15.jdone.fileClick.p), r.U15);
  check("U16", "job card: Show all expands to the full result and a same-text patch keeps it open; an error patch flips the class/glyph and shows the error line without Stop",
    r.U16.expanded > 700 && r.U16.moreLbl === "Show less" && r.U16.keptResult && r.U16.cls === "job-card st-error role-coder" && r.U16.state === "error" && r.U16.err === "Tests failed: 2 of 10" && !r.U16.body && !r.U16.stopVisible, r.U16);
  check("U12", "no renderer errors while rendering/patching", errors.length === 0, errors);

  await browser.close();
  clearTimeout(watchdog);
  console.log(`\nTool cards: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(failures.map((f) => " - " + f).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
