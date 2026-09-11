"use strict";
/* Git UI component regression suite — DESIRED behaviour for the renderer findings of
 * ATOMNANO_GIT_AUDIT_2026-09-09 (U01..U24 + extras), run against the ORIGINAL renderer
 * modules (gitcenter.js, diff.js, conflicts.js, styles.css and the extracted app.js
 * functions) in a blank headless Chromium document with fixture IPC.
 *
 * Never launches AtomNano, never reads its profile, never touches a real repository.
 * Run:  node scripts/test-git-ui.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ts = require("typescript");
const { chromium } = require("playwright");

const app = fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf8");
const ast = ts.createSourceFile("app.js", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
// Text of a (possibly nested) function declaration by name.
function fn(name) {
  let n = null;
  const visit = (x) => { if (n) return; if (ts.isFunctionDeclaration(x) && x.name && x.name.text === name) { n = x; return; } ts.forEachChild(x, visit); };
  visit(ast);
  if (!n) throw new Error("function not found: " + name);
  return n.getText(ast);
}
// Text between two markers (start inclusive, end exclusive).
function block(startMarker, endMarker) {
  const a = app.indexOf(startMarker); if (a < 0) throw new Error("marker not found: " + startMarker);
  const b = app.indexOf(endMarker, a); if (b < 0) throw new Error("marker not found: " + endMarker);
  return app.slice(a, b);
}
const gc = fs.readFileSync(path.join(ROOT, "src/renderer/gitcenter.js"), "utf8").replace(/^export /mg, "");
const diff = fs.readFileSync(path.join(ROOT, "src/renderer/diff.js"), "utf8").replace(/^export /mg, "");
const conf = fs.readFileSync(path.join(ROOT, "src/renderer/conflicts.js"), "utf8").replace(/^export /mg, "");
const css = fs.readFileSync(path.join(ROOT, "src/renderer/styles.css"), "utf8");
const resolverBlock = block("/* ============================================================\n   MERGE CONFLICT RESOLVER", "\nfunction tabContextMenu(");
const functions = {};
for (const n of ["openCommitProgressModal", "confirmDialog", "promptDialog", "chooseDialog", "closeModal", "openModal", "modalShell", "reloadBranches"]) functions[n] = fn(n);

let pass = 0, failN = 0; const results = [];
function record(id, name, ok, evidence) { results.push({ id, name, ok: !!ok, evidence }); if (ok) pass++; else { failN++; console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 400) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 300000);

async function main() {
  const browser = await chromium.launch({ headless: true });
  async function setup() {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await page.route("**/*", (route) => route.abort());
    await page.setContent('<!doctype html><html><body><button id="outside">Outside</button><div id="modalRoot"></div><div id="toast" class="toast hidden"></div></body></html>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: "window.auditH=(" + fn("h") + ");window.$=(id)=>document.getElementById(id);" });
    await page.addScriptTag({ content: diff + "\nwindow.diffFns={parseUnifiedDiff,processHunk};" });
    await page.addScriptTag({ content: conf + "\nwindow.confFns={parseConflicts,assembleResolved,previewFor,isFullyResolved,normalizeForEdit,restoreFormat};" });
    await page.addScriptTag({ content: "(()=>{const h=window.auditH;let gDiffView='split';" + ["diffCode", "unifiedRow", "splitCell", "splitRow", "renderDiffContent"].map(fn).join("\n") + "\nwindow.realDiff={render:renderDiffContent,set(v){gDiffView=v},get(){return gDiffView}};})();" });
    // dialogs: real closeModal/openModal/modalShell/confirmDialog/promptDialog/chooseDialog from app.js
    await page.addScriptTag({ content: "(()=>{const h=window.auditH,$=window.$,icon=()=>'';" + ["closeModal", "openModal", "modalShell", "confirmDialog", "promptDialog", "chooseDialog"].map((n) => functions[n]).join("\n") + "\nwindow.dialogs={closeModal,openModal,modalShell,confirmDialog,promptDialog,chooseDialog};})();" });
    await page.addScriptTag({ content: gc + "\nwindow.gitc={S,setDeps(d){D=d},openGitCenter,close,selectRepo,refreshAll,refreshRepo,act,forAll,setTab,enterCompare,runCompare,renderMain,doPush,doMerge,per,prompt,offerContinuation,onGitChanged,viewFileAt,changeText};" });
    await page.evaluate(() => {
      window.calls = []; window.notices = []; window.waiters = {};
      window.defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
      window.fixtureInfo = (repo) => ({ marker: repo, current: repo + "-main", headOid: "head-" + repo, unborn: false, detached: false, locals: [{ name: repo + "-main", current: true, upstream: "origin/" + repo + "-main" }, { name: "feature" }], remotes: [{ name: "origin/" + repo + "-main" }], state: { op: "", actions: [], sides: { mine: "ours", incoming: "theirs" } } });
      window.fixtureStatus = (repo) => ({ repo: true, branch: repo + "-main", upstream: "origin/" + repo + "-main", ahead: 1, behind: 0, files: [{ path: "a.txt", label: "Modified", index: "", worktree: "M", x: " ", y: "M", unstaged: true, staged: false }], clean: false });
      const h = window.auditH;
      window.deps = {
        h, icon: (_n, n = 14, cls = "") => '<svg class="icon ' + cls + '" width="' + n + '" height="' + n + '"></svg>',
        projectRoot: () => "project", repoName: (r) => r, baseName: (s) => s.split(/[\\/]/).at(-1),
        fileMeta: () => ({ ic: "file", cls: "" }), esc: (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
        toast: (text, kind) => notices.push({ text, kind }), refreshGit: async () => {}, refreshTree: () => {},
        openConflictResolver: (...a) => calls.push({ op: "openResolver", a }), openInEditor: () => {}, showMenuAt: () => {},
        chooseDialog: async () => (window.chooseAnswer === undefined ? "yes" : window.chooseAnswer),
        promptDialog: () => Promise.resolve(window.promptAnswer === undefined ? null : window.promptAnswer),
        confirmDialog: async () => true,
        getDiffView: () => realDiff.get(), setDiffView: (v) => realDiff.set(v),
        parseUnifiedDiff: diffFns.parseUnifiedDiff, renderDiffContent: realDiff.render,
        diffEmpty: (_ic, title, sub) => h("div", {}, title, sub),
        modalShell: dialogs.modalShell,
        atom: {
          git: {
            repos: async () => ["A", "B"], status: async (r) => window.fixtureStatus(r), branchesDetailed: async (r) => window.fixtureInfo(r),
            watch: async () => true, cancel: async () => true,
            repoState: async () => ({ op: "", actions: [], sides: { mine: "ours", incoming: "theirs" } }),
            resolveRefs: async (_r, names) => Object.fromEntries(names.map((n) => [n, "oid-" + n])),
            diff: async () => ({ text: "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" }),
            fileDiff: async () => ({ text: "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" }),
            fetch: async (r) => { calls.push({ op: "fetch", repo: r }); return { ok: true, state: "success" }; },
            commitPlan: async (r, plan) => { calls.push({ op: "commitPlan", repo: r, plan }); return { ok: true, state: "success", committed: true, reconciled: true, commit: "abc1234" }; },
            commitFiles: async (r, msg, paths) => { calls.push({ op: "commitFiles", repo: r, msg, paths }); return { ok: true, committed: true }; },
            stage: async (r, paths) => { calls.push({ op: "stage", repo: r, paths }); return { ok: true }; },
            pushPlan: async (r, o) => { calls.push({ op: "pushPlan", repo: r, o }); const b = (o && o.branch) || r + "-main"; return { branch: b, remote: "origin", dest: b, url: "file:///fixture/" + r, hasUpstream: true, upstream: "origin/" + b, remotes: ["origin"], localOid: "l", remoteOid: "r", pushDefault: "simple" }; },
            pushBranch: async (r, opts) => { calls.push({ op: "pushBranch", repo: r, opts }); return { ok: true, state: "success", remote: opts.remote, dest: opts.dest }; },
            push: async (r) => { calls.push({ op: "push", repo: r }); return { ok: true, state: "success" }; },
            pull: async (r) => { calls.push({ op: "pull", repo: r }); return { ok: true, state: "success" }; },
            pullFrom: async (r, o) => { calls.push({ op: "pullFrom", repo: r, o }); return { ok: true, state: "success" }; },
            mergeBranches: async (r, s, t, m, o) => { calls.push({ op: "mergeBranches", repo: r, s, t, m, o }); return { ok: true, state: "success" }; },
            rebase: async (r, onto, o) => { calls.push({ op: "rebase", repo: r, onto, o }); return { ok: true, state: "success" }; },
            log: async () => ({ commits: [], hasMore: false }), commitInfo: async () => ({ files: [], parents: [], parent: "", parentIndex: 0 }), commitFileDiff: async () => ({ text: "" }),
            tags: async () => ({ tags: [] }), remotes: async () => ({ remotes: [{ name: "origin", fetch: "file:///fixture", push: "file:///fixture", fetchUrls: ["file:///fixture"], pushUrls: [] }] }),
            stashList: async () => ({ stashes: [] }), stashShow: async () => ({ files: [] }), stashApply: async (r, sel, o) => { calls.push({ op: "stashApply", repo: r, sel, o }); return { ok: true, state: "success" }; }, stashDrop: async (r, sel) => { calls.push({ op: "stashDrop", repo: r, sel }); return { ok: true }; },
            aheadBehind: async () => ({ onlyA: 0, onlyB: 1 }), commitsBetween: async () => ({ commits: [], hasMore: false }), changedBetween: async () => ({ files: [] }),
            fileAt: async () => ({ binary: false, content: "text", truncated: false, nextOffset: null, size: 4 }),
          },
          files: { reveal: async () => {} }, clipboard: { write: () => {} }, shell: { openExternal: async () => {} },
          events: { onGitProgress: (cb) => { window.progressCb = cb; return () => {}; }, onGitChanged: (cb) => { window.changedCb = cb; return () => {}; } },
        },
      };
      gitc.setDeps(deps);
    });
    return page;
  }
  async function check(id, name, run) {
    const page = await setup();
    try { const r = await run(page); record(id, name, r && r.ok, r && r.evidence); }
    catch (e) { record(id, name, false, { harnessError: (e && e.stack) || String(e) }); }
    finally { await page.close(); }
  }
  const open = (p) => p.evaluate(() => gitc.openGitCenter(deps, { repo: "A" }));

  await check("U01", "Late repository read never overwrites the current repository's info", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      waiters.a = defer(); deps.atom.git.branchesDetailed = (r) => r === "A" ? waiters.a.promise : Promise.resolve(fixtureInfo(r));
      const first = gitc.selectRepo("A"); await gitc.selectRepo("B"); waiters.a.resolve({ ...fixtureInfo("A"), marker: "A-late" }); await first;
      return { ok: gitc.S.repo === "B" && gitc.S.info.marker === "B" && gitc.S.infos.A.marker === "A-late", evidence: { repo: gitc.S.repo, infoOwner: gitc.S.info.marker, recordedForA: gitc.S.infos.A.marker } };
    });
  });
  await check("U02", "Commit draft and Amend are per repository", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      const ta = document.querySelector(".gitc-msg"); ta.value = "message for A"; ta.dispatchEvent(new Event("input"));
      const cb = document.querySelector(".gitc-commitbox input[type=checkbox]"); cb.checked = true; cb.dispatchEvent(new Event("change"));
      await gitc.selectRepo("B");
      const bMsg = document.querySelector(".gitc-msg").value, bAmend = document.querySelector(".gitc-commitbox input[type=checkbox]").checked;
      await gitc.selectRepo("A");
      const aMsg = document.querySelector(".gitc-msg").value, aAmend = document.querySelector(".gitc-commitbox input[type=checkbox]").checked;
      return { ok: bMsg === "" && bAmend === false && aMsg === "message for A" && aAmend === true, evidence: { bMsg, bAmend, aMsg, aAmend } };
    });
  });
  await check("U03", "A's pending-push continuation is never offered on repository B", async (p) => {
    await open(p);
    await p.evaluate(async () => { gitc.per("A").continuation = { kind: "push", repo: "A", branch: "A-main", remote: "origin", dest: "A-main" }; await gitc.selectRepo("B"); await gitc.refreshAll(); });
    await p.waitForTimeout(150);
    const popOnB = await p.evaluate(() => !!document.querySelector(".gitc-pop"));
    await p.evaluate(() => { window.op = gitc.selectRepo("A"); });
    await p.waitForSelector(".gitc-pop-msg", { timeout: 5000 });
    const text = await p.locator(".gitc-pop-msg").textContent();
    await p.getByRole("button", { name: "Cancel", exact: true }).click();
    await p.evaluate(() => window.op);
    const cont = await p.evaluate(() => gitc.per("A").continuation);
    return { ok: !popOnB && text.includes("A-main") && text.includes("A") && cont === null, evidence: { popOnB, text, continuationAfterCancel: cont } };
  });
  await check("U04", "Commit & Push stays bound to the repository it started in", async (p) => {
    await open(p);
    await p.evaluate(() => {
      waiters.commit = defer(); deps.atom.git.commitPlan = (r, plan) => { calls.push({ op: "commitPlan", repo: r, plan }); return waiters.commit.promise; };
      document.querySelector('.gitc-tree-file[data-path="a.txt"] input[type=checkbox]').click();   // nothing is pre-selected
      const ta = document.querySelector(".gitc-msg"); ta.value = "commit A"; ta.dispatchEvent(new Event("input"));
      document.querySelector(".commitpushbtn").click();
    });
    await p.waitForFunction(() => calls.some((x) => x.op === "commitPlan"));
    await p.evaluate(async () => { await gitc.selectRepo("B"); waiters.commit.resolve({ ok: true, state: "success", committed: true, reconciled: true, commit: "abc1234" }); });
    await p.waitForSelector(".gitc-pop", { timeout: 5000 });
    const ev = await p.evaluate(() => ({ calls: calls.filter((c) => c.op === "commitPlan" || c.op === "pushPlan"), title: document.querySelector(".gitc-pop-head").textContent, details: document.querySelector(".gitc-pop-details").textContent }));
    await p.getByRole("button", { name: "Cancel", exact: true }).click();
    const plan = ev.calls.find((c) => c.op === "pushPlan");
    return { ok: ev.calls[0].repo === "A" && plan && plan.repo === "A" && ev.title.includes("A-main") && ev.details.includes("A") && !ev.title.includes("B-main"), evidence: ev };
  });
  await check("U05", "Amend commits through one plan for the repository it started in", async (p) => {
    await open(p);
    await p.evaluate(() => {
      waiters.commit = defer(); deps.atom.git.commitPlan = (r, plan) => { calls.push({ op: "commitPlan", repo: r, plan }); return waiters.commit.promise; };
      document.querySelector('.gitc-tree-file[data-path="a.txt"] input[type=checkbox]').click();   // nothing is pre-selected
      const cb = document.querySelector(".gitc-commitbox input[type=checkbox]"); cb.checked = true; cb.dispatchEvent(new Event("change"));
      const ta = document.querySelector(".gitc-msg"); ta.value = "amend A"; ta.dispatchEvent(new Event("input"));
      document.querySelector(".commitbtn").click();
    });
    await p.waitForFunction(() => calls.some((x) => x.op === "commitPlan"));
    await p.evaluate(async () => { await gitc.selectRepo("B"); waiters.commit.resolve({ ok: true, state: "success", committed: true, reconciled: true, commit: "def5678" }); });
    await p.waitForTimeout(100);
    return p.evaluate(() => { const c = calls.find((x) => x.op === "commitPlan"); return { ok: c.repo === "A" && c.plan.amend === true && c.plan.paths.length === 1 && c.plan.paths[0].path === "a.txt" && c.plan.expectHead === "head-A" && !calls.some((x) => x.op === "stage" || x.op === "commitOpts"), evidence: calls }; });
  });
  await check("U06", "Pull-all reports a conflict result as needing attention, never as done", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      await gitc.forAll("Pull", async () => ({ ok: false, state: "conflict", conflict: true }));
      const last = notices.at(-1);
      return { ok: last.kind === "alert" && /need attention/.test(last.text) && !notices.some((x) => x.kind === "checkCircle" && /Pull done/.test(x.text)) && gitc.S.tab === "changes", evidence: notices };
    });
  });
  await check("U07", "A failed comparison keeps Create Merge and Rebase disabled", async (p) => {
    await open(p);
    await p.evaluate(() => {
      const bad = async () => { throw Error("fixture comparison failed"); };
      deps.atom.git.aheadBehind = deps.atom.git.commitsBetween = deps.atom.git.changedBetween = bad;
      gitc.S.source = "feature"; gitc.S.target = "A-main"; gitc.enterCompare(); gitc.runCompare();
    });
    await p.waitForFunction(() => /Incomplete/.test(document.querySelector(".gitc-cmp-summary").textContent));
    return p.evaluate(() => ({ ok: gitc.S.cmp.ready === false && gitc.S.cmp.compared === true && document.querySelector(".gitc-cmpbar .mergebtn").disabled && document.querySelector(".gitc-cmpbar .rebasebtn").disabled && gitc.S.cmp.ids === null, evidence: { ready: gitc.S.cmp.ready, mergeDisabled: document.querySelector(".mergebtn").disabled, error: gitc.S.cmp.error } }));
  });
  await check("U08", "An obsolete history search result is dropped", async (p) => {
    await open(p);
    await p.evaluate(() => { deps.atom.git.log = async (_r, o) => { if (!o.search) return { commits: [], hasMore: false }; waiters[o.search] = defer(); return waiters[o.search].promise; }; gitc.setTab("history"); });
    const input = p.getByPlaceholder("Search subjects & messages…");
    await input.fill("old"); await p.waitForFunction(() => !!waiters.old);
    await input.fill("new"); await p.waitForFunction(() => !!waiters.new);
    await p.evaluate(() => waiters.new.resolve({ commits: [{ hash: "new", full: "new", subject: "new" }], hasMore: false }));
    await p.waitForFunction(() => gitc.S.hist.commits.length === 1);
    await p.evaluate(() => waiters.old.resolve({ commits: [{ hash: "old", full: "old", subject: "old" }], hasMore: false }));
    await p.waitForTimeout(120);
    return p.evaluate(() => ({ ok: gitc.S.hist.search === "new" && gitc.S.hist.commits.length === 1 && gitc.S.hist.commits[0].full === "new", evidence: { search: gitc.S.hist.search, commits: gitc.S.hist.commits.map((c) => c.full) } }));
  });
  await check("U09", "Refresh keeps the focused commit textarea, its text and focus", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      const old = document.querySelector(".gitc-msg"); old.focus(); old.value = "draft"; old.dispatchEvent(new Event("input")); old.setSelectionRange(2, 2);
      await gitc.refreshAll();
      const now = document.querySelector(".gitc-msg");
      return { ok: old.isConnected && now === old && document.activeElement === old && old.value === "draft" && old.selectionStart === 2, evidence: { sameElement: now === old, connected: old.isConnected, active: document.activeElement.tagName, value: now.value, caret: old.selectionStart } };
    });
  });
  await check("U10", "Closing during discovery settles the open call without an error", async (p) => {
    return p.evaluate(async () => {
      waiters.repos = defer(); deps.atom.git.repos = () => waiters.repos.promise;
      const op = gitc.openGitCenter(deps).then(() => "settled", (e) => "rejected: " + e.message);
      gitc.close(); waiters.repos.resolve(["A"]);
      const r = await op;
      return { ok: r === "settled" && !document.querySelector(".gitc-overlay"), evidence: { result: r, overlay: !!document.querySelector(".gitc-overlay") } };
    });
  });
  await check("U11", "A busy repository disables its mutation buttons; Enter cannot start a second Fetch", async (p) => {
    await open(p);
    await p.evaluate(() => { waiters.fetch = defer(); deps.atom.git.fetch = (r) => { calls.push({ op: "fetch", repo: r }); return waiters.fetch.promise; }; });
    const button = p.getByRole("button", { name: "Fetch", exact: true });
    await button.click();
    await p.waitForFunction(() => calls.length === 1);
    const st = await p.evaluate(() => { const b = [...document.querySelectorAll(".gitc-bar .gitc-act")].find((x) => x.textContent.trim() === "Fetch"); b.focus(); return { disabled: b.disabled, ariaBusy: document.querySelector(".gitc-panel").getAttribute("aria-busy"), pushDisabled: document.querySelector(".pushbtn").disabled }; });
    await p.keyboard.press("Enter");
    await p.evaluate(() => { const b = [...document.querySelectorAll(".gitc-bar .gitc-act")].find((x) => x.textContent.trim() === "Fetch"); b.click(); });
    await p.waitForTimeout(80);
    const ev = await p.evaluate(() => ({ calls: calls.length, inflight: [...gitc.S.inflight.keys()] }));
    await p.evaluate(() => waiters.fetch.resolve({ ok: true }));
    return { ok: st.disabled && st.pushDisabled && st.ariaBusy === "true" && ev.calls === 1, evidence: { ...st, ...ev } };
  });
  // ---- resolver (original resolver block, fixture IPC) ----
  const resolverSetup = (extra) => `
    const h=auditH,icon=()=>"",$=window.$,esc=(s)=>String(s),repoName=(s)=>s,baseName=(s)=>s.split("/").at(-1),openInEditor=()=>{},gitBranchOf=()=>"main",gitMergeAbort=()=>{},refreshGit=async()=>{},refreshTree=()=>{},confirmDialog=async()=>true;
    const parseConflicts=confFns.parseConflicts,assembleResolved=confFns.assembleResolved,previewFor=confFns.previewFor,isFullyResolved=confFns.isFullyResolved,normalizeForEdit=confFns.normalizeForEdit,restoreFormat=confFns.restoreFormat;
    const msgs=[];const toast=(text,kind)=>msgs.push({text,kind});const state={git:{statuses:{}}};
    ${extra}
    ${resolverBlock}
    window.resolver={_merge,msgs,loadConflictFile,markFileResolved,renderConflictCard,resolveConflict,bulkResolve,completeMerge,openConflictResolver,closeMerge,ensureMergeOverlay,renderMergeFile,mapChoice,navMergeFile,loadOpState};`;
  await check("U12", "A slower read of file A never becomes file B's content or save", async (p) => {
    await p.evaluate((src) => { eval(src); }, resolverSetup(`
      const pending={},writes=[];
      const atom={files:{read:(f)=>{pending[f]=defer();return pending[f].promise;},writeChecked:async(p,c,exp)=>{writes.push({path:p,content:c,expected:exp});return{ok:true};}},
        git:{stage:async()=>({ok:true}),status:async()=>({files:[]}),conflictStages:async()=>({base:{},ours:{},theirs:{},binary:false,modifyDelete:false}),repoState:async()=>({op:"merge",sides:{mine:"ours",incoming:"theirs"}})}};
      window.pending=pending;window.writes=writes;`));
    return p.evaluate(async () => {
      const r = resolver; r._merge.repo = "A"; r._merge.files = ["a.txt", "b.txt"]; r._merge.index = 0;
      const first = r.loadConflictFile(); r._merge.index = 1; const second = r.loadConflictFile();
      pending["A/b.txt"].resolve({ content: "<<<<<<< HEAD\nB ours\n=======\nB theirs\n>>>>>>> incoming\n" }); await second;
      pending["A/a.txt"].resolve({ content: "<<<<<<< HEAD\nA ours\n=======\nA theirs\n>>>>>>> incoming\n" }); await first;
      const shown = document.querySelector(".mgh-name").textContent;
      r._merge.choices[0] = "ours"; await r.markFileResolved();
      return { ok: shown === "b.txt" && writes.length === 1 && writes[0].path === "A/b.txt" && writes[0].content === "B ours\n" && writes[0].expected.startsWith("<<<<<<< HEAD\nB ours"), evidence: { shown, writes } };
    });
  });
  await check("U13", "During a rebase, Keep mine (button, key 1, bulk) keeps the user's commit", async (p) => {
    await p.evaluate((src) => { eval(src); }, resolverSetup(`const atom={files:{},git:{}};`));
    return p.evaluate(() => {
      const r = resolver; r._merge.sides = { mine: "theirs", incoming: "ours" }; r._merge.op = "rebase";
      const parsed = confFns.parseConflicts("<<<<<<< HEAD\nupstream\n=======\nmy commit\n>>>>>>> feature\n");
      r._merge.parsed = parsed; r._merge.choices = {}; r._merge.custom = {}; r._merge.fileInfo = { kind: "text" };
      const card = r.renderConflictCard(parsed.segments.find((s) => s.type === "conflict")); document.body.append(card);
      const minePane = card.querySelector(".mgc-side.current pre").textContent;
      [...card.querySelectorAll("button")].find((b) => b.textContent === "Keep mine").click();
      const viaButton = confFns.assembleResolved(parsed, r._merge.choices);
      r._merge.choices = {}; r.bulkResolve("mine"); const viaBulk = confFns.assembleResolved(parsed, r._merge.choices);
      r._merge.choices = {}; r.resolveConflict(0, "incoming"); const incoming = confFns.assembleResolved(parsed, r._merge.choices);
      r._merge.choices = {}; r.resolveConflict(0, "both"); const both = confFns.assembleResolved(parsed, r._merge.choices);
      return { ok: minePane === "my commit" && viaButton === "my commit\n" && viaBulk === "my commit\n" && incoming === "upstream\n" && both === "my commit\nupstream\n", evidence: { minePane, viaButton, viaBulk, incoming, both } };
    });
  });
  await check("U14", "Complete keeps the resolver open when the sequence stops at the next conflict", async (p) => {
    await p.evaluate((src) => { eval(src); }, resolverSetup(`
      let statusCalls=0;
      const atom={files:{read:async()=>({content:"<<<<<<< HEAD\\nx\\n=======\\ny\\n>>>>>>> c\\n"})},git:{status:async()=>{statusCalls++;return statusCalls<=1?{files:[]}:{files:[{path:"next.txt",conflict:true}]};},
        mergeContinue:async()=>({ok:false,conflict:true,state:"conflict",op:"rebase",branch:"HEAD",stillInProgress:true}),repoState:async()=>({op:"rebase",detail:"feat onto abc",sides:{mine:"theirs",incoming:"ours"}}),conflictStages:async()=>({base:{},ours:{},theirs:{}})}};`));
    return p.evaluate(async () => {
      const r = resolver; r._merge.repo = "A"; r._merge.files = []; r.ensureMergeOverlay();
      await r.completeMerge();
      await new Promise((res) => setTimeout(res, 50));
      const open = !!document.querySelector(".merge-overlay");
      return { ok: open && !r.msgs.some((m) => m.kind === "checkCircle") && r.msgs.some((m) => /continues/.test(m.text)) && r._merge.files.length === 1 && r._merge.files[0] === "next.txt" && r._merge.op === "rebase", evidence: { open, msgs: r.msgs, files: r._merge.files, op: r._merge.op } };
    });
  });
  await check("U15", "A conflict save preserves CRLF, BOM and the final newline", async (p) => {
    await p.evaluate((src) => { eval(src); }, resolverSetup(`
      const writes=[];
      const atom={files:{read:async()=>({content:"\\uFEFF<<<<<<< HEAD\\r\\nours\\r\\n=======\\r\\ntheirs\\r\\n>>>>>>> incoming\\r\\n"}),writeChecked:async(p,c,exp)=>{writes.push({p,c,exp});return{ok:true};}},
        git:{stage:async()=>({ok:true}),status:async()=>({files:[]}),conflictStages:async()=>({base:{},ours:{},theirs:{}}),repoState:async()=>({op:"merge",sides:{mine:"ours",incoming:"theirs"}})}};
      window.writes=writes;`));
    return p.evaluate(async () => {
      const r = resolver; r._merge.repo = "A"; r._merge.files = ["a.txt"]; r._merge.index = 0;
      await r.loadConflictFile(); r._merge.choices[0] = "ours"; await r.markFileResolved();
      return { ok: writes.length === 1 && writes[0].c === "﻿ours\r\n" && writes[0].exp.startsWith("﻿<<<<<<< HEAD\r\n"), evidence: { output: JSON.stringify(writes[0] && writes[0].c) } };
    });
  });
  await check("U15b", "A file changed on disk is not overwritten and not staged", async (p) => {
    await p.evaluate((src) => { eval(src); }, resolverSetup(`
      const stages=[];
      const atom={files:{read:async()=>({content:"<<<<<<< HEAD\\nours\\n=======\\ntheirs\\n>>>>>>> incoming\\n"}),writeChecked:async()=>({ok:false,conflict:true})},
        git:{stage:async(r,f)=>{stages.push(f);return{ok:true};},status:async()=>({files:[]}),conflictStages:async()=>({base:{},ours:{},theirs:{}}),repoState:async()=>({op:"merge",sides:{mine:"ours",incoming:"theirs"}})}};
      window.stages=stages;`));
    return p.evaluate(async () => {
      const r = resolver; r._merge.repo = "A"; r._merge.files = ["a.txt"]; r._merge.index = 0;
      await r.loadConflictFile(); r._merge.choices[0] = "ours"; await r.markFileResolved();
      return { ok: stages.length === 0 && r.msgs.some((m) => /changed on disk/.test(m.text)), evidence: { stages, msgs: r.msgs } };
    });
  });
  await check("U15c", "Choosing the deleted side of a modify/delete conflict resolves the whole file", async (p) => {
    await p.evaluate((src) => { eval(src); }, resolverSetup(`
      const resolves=[];
      const atom={files:{read:async()=>({content:"kept content\\n"})},git:{status:async()=>({files:[]}),conflictStages:async()=>({base:{oid:"b"},ours:{oid:"o"},theirs:null,binary:false,modifyDelete:true}),repoState:async()=>({op:"merge",sides:{mine:"ours",incoming:"theirs"}}),resolveWith:async(r,f,side)=>{resolves.push({f,side});return{ok:true,results:[{path:f[0],ok:true,action:"deleted"}]};}}};
      window.resolves=resolves;`));
    return p.evaluate(async () => {
      const r = resolver; r._merge.repo = "A"; r._merge.files = ["gone.txt"]; r._merge.index = 0;
      await r.loadConflictFile();
      const kind = r._merge.fileInfo.kind; const label = [...document.querySelectorAll(".mgc-act")].map((b) => b.textContent);
      [...document.querySelectorAll(".mgc-act")].find((b) => /Accept incoming/.test(b.textContent)).click();
      await new Promise((res) => setTimeout(res, 50));
      return { ok: kind === "modifyDelete" && label.some((l) => /Accept incoming \(deletes the file\)/.test(l)) && resolves.length === 1 && resolves[0].side === "theirs" && resolves[0].f[0] === "gone.txt", evidence: { kind, label, resolves } };
    });
  });
  await check("U16", "The diff parser keeps changed lines that look like file headers", async (p) => p.evaluate(() => {
    const parsed = diffFns.parseUnifiedDiff("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n--- old comment\n+++ new comment\n");
    return { ok: parsed.adds === 1 && parsed.dels === 1 && parsed.hunks[0].lines[0].text === "-- old comment" && parsed.hunks[0].lines[1].text === "++ new comment", evidence: parsed };
  }));
  await check("U17", "An unterminated conflict round-trips every input line", async (p) => p.evaluate(() => {
    const input = "before\n<<<<<<< ours\none\n||||||| base\nbase text\n=======\nincoming text\n";
    const parsed = confFns.parseConflicts(input), output = confFns.assembleResolved(parsed);
    return { ok: output === input && parsed.malformed.length === 1 && parsed.count === 0 && !confFns.isFullyResolved(parsed, {}), evidence: { output, malformed: parsed.malformed, count: parsed.count } };
  }));
  await check("U18", "Retry after a failed push re-pushes the recorded commit without committing again", async (p) => {
    await p.evaluate((src) => { eval(src); }, `
      const h=auditH,icon=()=>"",esc=(s)=>s,repoName=(s)=>s,state={git:{statuses:{A:{branch:"main"}}}},closeModal=dialogs.closeModal,modalShell=dialogs.modalShell,refreshGit=async()=>{},refreshTree=()=>{},toast=()=>{};
      let commits=0,pushes=0;
      const atom={git:{commitFiles:async()=>{commits++;if(commits>1)throw Error("nothing to commit");return{ok:true,committed:true,commit:"abc1234def",branch:"main",state:"success"};},branch:async()=>"main",
        push:async()=>{pushes++;if(pushes===1)throw Error("fixture rejected");return{ok:true,state:"success",remote:"origin",dest:"main"};}}};
      ${functions.openCommitProgressModal}
      window.progressTest={open:openCommitProgressModal,counts:()=>({commits,pushes})};`);
    await p.evaluate(() => progressTest.open([{ repo: "A", files: ["a.txt"] }], "message", true));
    await p.waitForFunction(() => /committed but not pushed/.test(document.querySelector(".cp-headline").textContent));
    const mid = await p.evaluate(() => ({ head: document.querySelector(".cp-headline").textContent, row: document.querySelector(".cp-row-phase").textContent }));
    await p.getByRole("button", { name: /Retry/ }).click();
    await p.waitForFunction(() => progressTest.counts().pushes === 2);
    await p.waitForTimeout(80);
    return p.evaluate((mid) => ({ ok: progressTest.counts().commits === 1 && progressTest.counts().pushes === 2 && /abc1234/.test(mid.row) && /pushed/.test(document.querySelector(".cp-row-phase").textContent), evidence: { ...progressTest.counts(), mid, final: document.querySelector(".commit-progress").textContent } }), mid);
  });
  await check("U19", "Git overlay, panel and progress strip do not animate under reduced motion", async (p) => {
    await open(p);
    return p.evaluate(() => {
      document.querySelector(".gitc-progress").classList.add("on");
      const ev = { reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, overlay: getComputedStyle(document.querySelector(".gitc-overlay")).animationName, panel: getComputedStyle(document.querySelector(".gitc-panel")).animationName, progress: getComputedStyle(document.querySelector(".gitc-progress"), "::before").animationName };
      return { ok: ev.reduced && ev.overlay === "none" && ev.panel === "none" && ev.progress === "none", evidence: ev };
    });
  });
  await check("U20", "5,000 changed files: nothing is pre-selected, select-all ticks every file, only the viewport's rows are mounted", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      const s = gitc.S.statuses.A; s.files = Array.from({ length: 5000 }, (_, i) => ({ path: "file-" + i + ".txt", label: "Modified", index: "", worktree: "M", unstaged: true, staged: false }));
      const t0 = performance.now(); await gitc.renderMain(); const ms = Math.round(performance.now() - t0);
      const rows = document.querySelectorAll(".gitc-tree-file").length, vl = document.querySelector(".gitc-vlist");
      const height = vl ? parseInt(vl.style.height, 10) : 0;
      const before = { selected: gitc.per("A").chg.sel.size, label: document.querySelector(".selinfo").textContent };
      document.querySelector('.gitc-sec[data-id="versioned"] .gitc-sec-acts input[type=checkbox]').click();   // the section's select-all
      const label = document.querySelector(".selinfo").textContent;
      return { ok: rows > 0 && rows < 200 && height === 5000 * 26 && before.selected === 0 && /Select files to commit/.test(before.label) && gitc.per("A").chg.sel.size === 5000 && /5000 files selected/.test(label), evidence: { rows, height, before, selected: gitc.per("A").chg.sel.size, label, ms } };
    });
  });
  await check("U21", "The Git panel is a modal dialog with keyboard-operable rows and tabs", async (p) => {
    await open(p);
    return p.evaluate(() => {
      const panel = document.querySelector(".gitc-panel"), row = document.querySelector(".gitc-tree-file"), tab = document.querySelector(".gitc-tab"), div = document.querySelector(".gitc-divider");
      let activated = false; row.addEventListener("click", () => { activated = true; });
      row.focus(); row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return { ok: panel.getAttribute("role") === "dialog" && panel.getAttribute("aria-modal") === "true" && row.tabIndex === 0 && row.getAttribute("role") === "button" && activated && tab.getAttribute("role") === "tab" && div.getAttribute("role") === "separator" && div.tabIndex === 0, evidence: { role: panel.getAttribute("role"), ariaModal: panel.getAttribute("aria-modal"), rowTabIndex: row.tabIndex, activated, tabRole: tab.getAttribute("role"), dividerRole: div.getAttribute("role") } };
    });
  });
  await check("U22", "A status failure is shown as an error state, never as a clean tree", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      deps.atom.git.status = async () => { throw Object.assign(Error("fixture git status timeout"), { type: "timeout" }); };
      await gitc.refreshAll();
      const state = document.querySelector(".gitc-state"), content = document.querySelector(".gitc-content").textContent;
      return { ok: !state.classList.contains("hidden") && /timeout/.test(state.textContent) && !/Working tree clean/.test(content) && gitc.S.statuses.A.state === "error" && gitc.S.statuses.A.stale === true && document.querySelector(".pushbtn").disabled && document.querySelector(".commitbtn").disabled && /last known/.test(state.textContent), evidence: { stateText: state.textContent, status: gitc.S.statuses.A.state, stale: gitc.S.statuses.A.stale, pushDisabled: document.querySelector(".pushbtn").disabled } };
    });
  });
  await check("U23", "The legacy Merge tab lists branches from the real IPC shape; targets are local only", async (p) => p.evaluate((src) => {
    const h = auditH, atom = { git: { branches: async () => ({ current: "main", locals: ["main", "feature"], remotes: ["origin/main"] }) } }, state = { git: { statuses: { A: { branch: "main" } } } };
    const sourceSel = h("select"), targetSel = h("select"), summaryBar = h("div"), compareBody = h("div"), initialMsg = h("div"), mergeBtn = h("button"), createMrBtn = h("button"), mergeStatsChip = h("div"), updateCompareReadiness = () => {};
    return (async () => { eval(src + "\nwindow.reloadLegacy=reloadBranches;"); await reloadLegacy("A"); return { ok: sourceSel.options.length === 3 && targetSel.options.length === 2 && [...targetSel.options].every((o) => !o.value.startsWith("origin/")) && sourceSel.value === "main", evidence: { source: [...sourceSel.options].map((o) => o.value), target: [...targetSel.options].map((o) => o.value) } }; })();
  }, functions.reloadBranches));
  await check("U24", "confirm/prompt/choose dialogs return Promises that settle on every close path", async (p) => p.evaluate(async () => {
    const d = dialogs;
    const p1 = d.confirmDialog({ title: "Merge", message: "m", confirmLabel: "Merge" }); [...document.querySelectorAll("button")].find((b) => b.textContent === "Merge").click(); const confirmed = await p1;
    const p2 = d.confirmDialog({ title: "Merge", message: "m", confirmLabel: "Merge" }); [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click(); const cancelled = await p2;
    const p3 = d.promptDialog({ title: "Name" }); document.querySelector(".mh-close").click(); const promptClosed = await p3;
    const p4 = d.chooseDialog({ title: "c", choices: [{ label: "A", value: "a" }] }); const back = document.querySelector(".modal-backdrop"); back.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); const chooseBackdrop = await p4;
    const p5 = d.promptDialog({ title: "Name", value: "v" }); [...document.querySelectorAll("button")].find((b) => b.textContent === "OK").click(); const promptOk = await p5;
    return { ok: confirmed === true && cancelled === false && promptClosed === null && chooseBackdrop === null && promptOk === "v" && !document.querySelector(".modal-backdrop"), evidence: { confirmed, cancelled, promptClosed, chooseBackdrop, promptOk } };
  }));
  // ---- extras: target identity, push plan, stash identity, typed file view, merge parent ----
  await check("X01", "A remote-tracking ref cannot become a merge target", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      await gitc.doMerge("feature", "origin/A-main", null, "A");
      return { ok: !calls.some((c) => c.op === "mergeBranches") && notices.some((n) => n.kind === "alert" && /remote-tracking/.test(n.text)), evidence: { calls, notices } };
    });
  });
  await check("X02", "Push shows and executes the RESOLVED remote and destination, never a hard-coded origin", async (p) => {
    await open(p);
    await p.evaluate(() => { deps.atom.git.pushPlan = async (r, o) => { calls.push({ op: "pushPlan", repo: r, o }); return { branch: "A-main", remote: "upstream", dest: "review", url: "ssh://fixture/up", hasUpstream: true, upstream: "upstream/review", remotes: ["origin", "upstream"], localOid: "l", remoteOid: "r", pushDefault: "upstream" }; }; gitc.doPush({ repo: "A" }); });
    await p.waitForSelector(".gitc-pop");
    const details = await p.evaluate(() => document.querySelector(".gitc-pop-details").textContent);
    await p.getByRole("button", { name: "Push", exact: true }).click();
    await p.waitForFunction(() => calls.some((c) => c.op === "pushBranch"));
    return p.evaluate((details) => { const c = calls.find((x) => x.op === "pushBranch"); return { ok: /upstream → refs\/heads\/review/.test(details) && c.repo === "A" && c.opts.remote === "upstream" && c.opts.dest === "review" && c.opts.branch === "A-main" && !c.opts.setUpstream && !c.opts.force, evidence: { details, call: c } }; }, details);
  });
  await check("X03", "Stash actions are sent by object id, not by position", async (p) => {
    await open(p);
    await p.evaluate(() => { deps.atom.git.stashList = async () => ({ stashes: [{ index: 0, hash: "0123456789abcdef0123456789abcdef01234567", ref: "stash@{0}", message: "first", rel: "now", branch: "A-main" }] }); gitc.setTab("stashes"); });
    await p.waitForSelector(".gitc-stashrow");
    await p.getByRole("button", { name: "Apply", exact: true }).click();
    await p.waitForFunction(() => calls.some((c) => c.op === "stashApply"));
    return p.evaluate(() => { const c = calls.find((x) => x.op === "stashApply"); return { ok: c.repo === "A" && c.sel && c.sel.hash === "0123456789abcdef0123456789abcdef01234567" && c.o.pop === false, evidence: c }; });
  });
  await check("X04", "A binary historical file is never rendered as decoded text", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      deps.atom.git.fileAt = async () => ({ binary: true, size: 5000, encoding: "binary", content: "", base64: "AAECAwQ=", truncated: false, nextOffset: null });
      await gitc.viewFileAt("HEAD", "blob.bin", "A");
      const modal = document.querySelector(".modal"); const text = modal.textContent;
      return { ok: /Binary file/.test(text) && /Download exact bytes/.test(text) && !modal.querySelector(".gitc-fileview"), evidence: { text } };
    });
  });
  await check("X05", "A merge commit is inspected against an explicit parent that the user can switch", async (p) => {
    await open(p);
    await p.evaluate(() => {
      deps.atom.git.log = async () => ({ commits: [{ full: "m1", hash: "m1", subject: "merge", parents: ["p1", "p2"], refs: [], author: "a" }], hasMore: false });
      deps.atom.git.commitInfo = async (_r, _h, o) => { calls.push({ op: "commitInfo", o }); const pi = o && o.parent ? +o.parent : 1; return { full: "m1", hash: "m1", parents: ["p1", "p2"], parent: pi === 1 ? "p1" : "p2", parentIndex: pi, isMerge: true, isRoot: false, files: pi === 1 ? [{ path: "f1.txt", code: "M" }] : [{ path: "f2.txt", code: "A" }], adds: 1, dels: 0, author: "a", email: "e", date: "", rel: "", refs: [], subject: "merge", body: "" }; };
      gitc.setTab("history");
    });
    await p.waitForSelector(".gitc-detail .gitc-ref-name");
    const first = await p.evaluate(() => ({ label: document.querySelector(".gitc-detail .gitc-ref-name").textContent, files: [...document.querySelectorAll(".gitc-detail .gitc-file-name")].map((e) => e.textContent) }));
    await p.click(".gitc-detail .gitc-ref");
    await p.waitForSelector(".gitc-pick-item");
    await p.click(".gitc-pick-item:nth-child(2)");
    await p.waitForFunction(() => document.querySelectorAll(".gitc-detail .gitc-file-name").length && document.querySelector(".gitc-detail .gitc-file-name").textContent === "f2.txt");
    return p.evaluate((first) => ({ ok: /vs parent 1/.test(first.label) && first.files[0] === "f1.txt" && /vs parent 2/.test(document.querySelector(".gitc-detail .gitc-ref-name").textContent) && calls.some((c) => c.op === "commitInfo" && c.o && c.o.parent === 2), evidence: { first, now: document.querySelector(".gitc-detail .gitc-ref-name").textContent } }), first);
  });
  await check("X06", "An external repository change refreshes only that repository, without touching the draft", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      const ta = document.querySelector(".gitc-msg"); ta.focus(); ta.value = "typing"; ta.dispatchEvent(new Event("input"));
      let statusCalls = []; deps.atom.git.status = async (r) => { statusCalls.push(r); return { ...fixtureStatus(r), files: [{ path: "external.txt", label: "Modified", index: "M", worktree: "", staged: true, unstaged: false }] }; };
      window.changedCb({ repo: "A" });
      await new Promise((res) => setTimeout(res, 600));
      const names = [...document.querySelectorAll(".gitc-tree-name")].map((e) => e.textContent);
      return { ok: statusCalls.length === 1 && statusCalls[0] === "A" && names.includes("external.txt") && ta.value === "typing" && document.activeElement === ta, evidence: { statusCalls, names, value: ta.value } };
    });
  });
  await check("X07", "A live git operation shows its last output line and a Cancel that targets that operation", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      window.progressCb({ kind: "start", opId: "op-1", label: "Push", cwd: "A" });
      window.progressCb({ kind: "output", opId: "op-1", stream: "stderr", text: "Counting objects: 3\rCounting objects: 5, done.\n" });
      const strip = document.querySelector(".gitc-oplog"); const text = strip.textContent;
      const cancelCalls = []; deps.atom.git.cancel = async (id) => { cancelCalls.push(id); return true; };
      strip.querySelector(".gitc-oplog-cancel").click(); await new Promise((r) => setTimeout(r, 20));
      window.progressCb({ kind: "end", opId: "op-1", ok: false });
      const hiddenAfterEnd = document.querySelector(".gitc-oplog").classList.contains("hidden");
      return { ok: /Push/.test(text) && /Counting objects: 5, done\./.test(text) && cancelCalls[0] === "op-1" && hiddenAfterEnd, evidence: { text, cancelCalls, hiddenAfterEnd } };
    });
  });
  await check("X08", "Unborn repositories disable push, amend and rebase and explain the first commit", async (p) => {
    await open(p);
    return p.evaluate(async () => {
      deps.atom.git.branchesDetailed = async (r) => ({ ...fixtureInfo(r), unborn: true, headOid: "", locals: [] });
      deps.atom.git.status = async (r) => ({ ...fixtureStatus(r), unborn: true, oid: "", upstream: "", ahead: 0, files: [{ path: "a.txt", label: "Untracked", untracked: true, unstaged: true, staged: false, index: "", worktree: "?" }] });
      await gitc.refreshAll();
      const cur = document.querySelector(".gitc-cur").textContent;
      return { ok: document.querySelector(".pushbtn").disabled && document.querySelector(".gitc-commitbox input[type=checkbox]").disabled && /no commits yet/.test(cur), evidence: { cur, pushDisabled: document.querySelector(".pushbtn").disabled } };
    });
  });
  // ---- Changes tab (2026-09-10): unversioned section, no default selection / preview; merge view; toasts; row layout ----
  await check("X09", "A file that was unversioned lists under Unversioned with Track again; nothing is selected or previewed by default", async (p) => {
    await p.evaluate(() => { window.fixtureStatus = (repo) => ({ repo: true, branch: repo + "-main", upstream: "origin/" + repo + "-main", ahead: 0, behind: 0, clean: false, files: [
      { path: "src/a.txt", label: "Modified", index: "", worktree: "M", unstaged: true, staged: false },
      { path: "vite.config.js", label: "Unversioned", index: "D", worktree: "", untracked: true, stagedDelete: true, keptOnDisk: true, staged: true, unstaged: false },
      { path: "new.txt", label: "Untracked", index: "", worktree: "?", untracked: true, unstaged: true, staged: false }] }); });
    await open(p);
    return p.evaluate(() => {
      const names = (id) => [...document.querySelectorAll(`.gitc-sec[data-id="${id}"] .gitc-tree-file`)].map((e) => e.dataset.path);
      const v = names("versioned"), u = names("unversioned");
      const heads = [...document.querySelectorAll(".gitc-sec-head")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
      const trackAgain = !!document.querySelector('.gitc-sec[data-id="unversioned"] .gitc-tree-file[data-path="vite.config.js"] [title="Track again (undo unversion)"]');
      const ph = document.querySelector(".gitc-diff-ph"); const label = document.querySelector(".selinfo").textContent;
      return { ok: v.join() === "src/a.txt" && u.includes("vite.config.js") && u.includes("new.txt") && trackAgain && gitc.per("A").chg.sel.size === 0 && /Select files to commit/.test(label) && !!ph && /Click a file/.test(ph.textContent) && !document.querySelector(".gitc-tree-file.active"), evidence: { v, u, heads, trackAgain, selected: gitc.per("A").chg.sel.size, label, placeholder: ph && ph.textContent } };
    });
  });
  await check("X10", "Clicking a file shows its diff; Unversion moves it to Unversioned and drops it from the selection and the preview", async (p) => {
    await open(p);
    await p.evaluate(() => {
      deps.atom.git.untrack = async (r, paths) => { calls.push({ op: "untrack", repo: r, paths }); deps.atom.git.status = async (rr) => ({ ...fixtureStatus(rr), files: [{ path: "a.txt", label: "Unversioned", index: "D", worktree: "", untracked: true, stagedDelete: true, keptOnDisk: true, staged: true, unstaged: false }] }); return { ok: true, state: "success" }; };
    });
    const idle = await p.evaluate(() => ({ placeholder: !!document.querySelector(".gitc-diff-ph"), diffKey: gitc.per("A").chg.diffKey }));
    await p.click('.gitc-tree-file[data-path="a.txt"]');
    await p.waitForFunction(() => !document.querySelector(".gitc-diff-ph") && gitc.per("A").chg.diffKey === "a.txt");
    const shown = await p.evaluate(() => ({ diffKey: gitc.per("A").chg.diffKey, active: !!document.querySelector('.gitc-tree-file.active[data-path="a.txt"]') }));
    await p.click('.gitc-tree-file[data-path="a.txt"] input[type=checkbox]');
    const selectedBefore = await p.evaluate(() => [...gitc.per("A").chg.sel]);
    await p.getByRole("button", { name: "Unversion", exact: true }).click();
    await p.waitForFunction(() => calls.some((c) => c.op === "untrack") && !!document.querySelector('.gitc-sec[data-id="unversioned"] .gitc-tree-file[data-path="a.txt"]'));
    return p.evaluate(({ idle, shown, selectedBefore }) => {
      const C = gitc.per("A").chg; const untrack = calls.find((c) => c.op === "untrack"); const ph = document.querySelector(".gitc-diff-ph");
      const inVersioned = !!document.querySelector('.gitc-sec[data-id="versioned"] .gitc-tree-file[data-path="a.txt"]');
      return { ok: idle.placeholder && idle.diffKey === null && shown.diffKey === "a.txt" && shown.active && selectedBefore.join() === "a.txt" && untrack.paths.join() === "a.txt" && C.sel.size === 0 && C.diffKey === null && !!ph && !inVersioned && /Select files to commit/.test(document.querySelector(".selinfo").textContent), evidence: { idle, shown, selectedBefore, untrack, sel: [...C.sel], diffKey: C.diffKey, placeholder: ph && ph.textContent, inVersioned } };
    }, { idle, shown, selectedBefore });
  });
  await check("X11", "Compare and Merge: the top button opens the merge view; Compare refreshes and reviews; Create Merge arms only when the review shows differences", async (p) => {
    await open(p);
    const before = await p.evaluate(() => ({ label: document.querySelector(".comparebtn").textContent.trim(), topMerge: !!document.querySelector(".gitc-bar .mergebtn"), mode: gitc.S.mode }));
    await p.click(".comparebtn");
    const opened = await p.evaluate(() => {
      window.statusReads = 0; const orig = deps.atom.git.status; deps.atom.git.status = async (r) => { statusReads++; return orig(r); };
      const m = document.querySelector(".gitc-cmpbar .mergebtn"), tgt = document.querySelector(".gitc-cmpbar .gitc-ref.target");
      return { mode: gitc.S.mode, source: gitc.S.source, target: gitc.S.target, mergeDisabled: m.disabled, mergeLabel: m.textContent.trim(), compareAfterTarget: !!tgt.nextElementSibling && tgt.nextElementSibling.classList.contains("cmp-run"), prompt: document.querySelector(".gitc-content").textContent, compared: gitc.S.cmp.compared };
    });
    await p.click(".gitc-cmpbar .cmp-run");
    await p.waitForFunction(() => gitc.S.cmp.ready === true && gitc.S.cmp.compared === true);
    const armed = await p.evaluate(() => ({ statusReads, mergeDisabled: document.querySelector(".gitc-cmpbar .mergebtn").disabled, rebaseDisabled: document.querySelector(".gitc-cmpbar .rebasebtn").disabled, summary: document.querySelector(".gitc-cmp-summary").textContent }));
    await p.evaluate(() => { deps.atom.git.aheadBehind = async () => ({ onlyA: 2, onlyB: 0 }); });
    await p.click(".gitc-cmpbar .cmp-run");
    await p.waitForFunction(() => gitc.S.cmp.ready === true && gitc.S.cmp.ab && gitc.S.cmp.ab.onlyB === 0);
    const noDiff = await p.evaluate(() => ({ mergeDisabled: document.querySelector(".gitc-cmpbar .mergebtn").disabled, title: document.querySelector(".gitc-cmpbar .mergebtn").title }));
    await p.click(".gitc-cmpbar .gitc-swap");
    const swapped = await p.evaluate(() => ({ compared: gitc.S.cmp.compared, mergeDisabled: document.querySelector(".gitc-cmpbar .mergebtn").disabled, prompt: document.querySelector(".gitc-content").textContent }));
    return { ok: before.label === "Compare and Merge" && !before.topMerge && before.mode === "tabs" && opened.mode === "compare" && opened.mergeDisabled && opened.mergeLabel === "Create Merge" && opened.compareAfterTarget && /Ready to compare/.test(opened.prompt) && !opened.compared && armed.statusReads >= 1 && !armed.mergeDisabled && !armed.rebaseDisabled && /1 commit to merge/.test(armed.summary) && noDiff.mergeDisabled && /Nothing to merge/.test(noDiff.title) && !swapped.compared && swapped.mergeDisabled && /Ready to compare/.test(swapped.prompt), evidence: { before, opened, armed, noDiff, swapped } };
  });
  await check("X12", "Pull and push toasts report what moved (files · +/− · commits) and render above the Git overlay", async (p) => {
    await open(p);
    await p.evaluate(() => {
      deps.atom.git.pullFrom = async (r, o) => { calls.push({ op: "pullFrom", repo: r, o }); return { ok: true, state: "success", branch: "A-main", from: "origin/A-main", upToDate: false, summary: { files: 12, insertions: 340, deletions: 22, commits: 3 } }; };
      deps.atom.git.pushBranch = async (r, opts) => { calls.push({ op: "pushBranch", repo: r, opts }); return { ok: true, state: "success", remote: opts.remote, dest: opts.dest, upToDate: false, summary: { files: 4, insertions: 10, deletions: 2, commits: 2 } }; };
    });
    await p.click('.gitc-bar button[title^="Pull"]');
    await p.waitForSelector(".gitc-pick-item");
    await p.click(".gitc-pick-item");   // "Pull from upstream (origin/A-main)"
    await p.waitForFunction(() => notices.some((n) => /Pulled/.test(n.text)));
    await p.evaluate(() => gitc.doPush({ repo: "A", skipConfirm: true }));
    await p.waitForFunction(() => notices.some((n) => /Pushed/.test(n.text)));
    return p.evaluate(() => {
      const pull = notices.find((n) => /Pulled/.test(n.text)), push = notices.find((n) => /Pushed/.test(n.text));
      const z = { toast: parseInt(getComputedStyle(document.getElementById("toast")).zIndex, 10), overlay: parseInt(getComputedStyle(document.querySelector(".gitc-overlay")).zIndex, 10) };
      return { ok: pull.kind === "checkCircle" && /Pulled origin\/A-main into A-main/.test(pull.text) && /12 files updated · \+340 −22 · 3 commits/.test(pull.text) && push.kind === "checkCircle" && /Pushed A-main → origin\/A-main/.test(push.text) && /2 commits · 4 files changed · \+10 −2/.test(push.text) && z.toast > z.overlay && calls.some((c) => c.op === "pullFrom"), evidence: { pull, push, z } };
    });
  });
  await check("X13", "Status chips and folder counts sit flush right of their rows however wide the pane is; hover actions overlay instead of reserving space", async (p) => {
    await p.evaluate(() => { window.fixtureStatus = (repo) => ({ repo: true, branch: repo + "-main", upstream: "origin/" + repo + "-main", ahead: 0, behind: 0, clean: false, files: [{ path: "src/deep/a.txt", label: "Modified", index: "", worktree: "M", unstaged: true, staged: false }, { path: "b.txt", label: "Modified", index: "", worktree: "M", unstaged: true, staged: false }] }); });
    await open(p);
    return p.evaluate(() => {
      document.querySelector(".gitc-chg-left").style.width = "900px";   // the user drags the divider wide
      const row = document.querySelector('.gitc-tree-file[data-path="b.txt"]'), chip = row.querySelector(".gitc-code"), acts = row.querySelector(".gitc-file-acts");
      const dir = document.querySelector(".gitc-tree-dir"), cnt = dir.querySelector(".gitc-col-count");
      const gapFile = row.getBoundingClientRect().right - chip.getBoundingClientRect().right, gapDir = dir.getBoundingClientRect().right - cnt.getBoundingClientRect().right;
      const ev = { gapFile, gapDir, rowWidth: row.getBoundingClientRect().width, actsPos: getComputedStyle(acts).position, actsOpacity: getComputedStyle(acts).opacity, chipVisible: getComputedStyle(chip).visibility };
      return { ok: gapFile < 16 && gapDir < 16 && ev.rowWidth > 800 && ev.actsPos === "absolute" && ev.actsOpacity === "0" && ev.chipVisible === "visible", evidence: ev };
    });
  });

  await browser.close();
  clearTimeout(watchdog);
  const out = { when: new Date().toISOString(), browser: "Playwright Chromium, headless; original renderer modules with fixture IPC; AtomNano never started", pass, fail: failN, results };
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "test-results", "git-ui.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${pass} passed, ${failN} failed  (test-results/git-ui.json)`);
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
