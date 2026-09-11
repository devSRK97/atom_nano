/* Commit-view right-click menus (stage / unstage / discard-rollback) and the
 * Compare-branches overlay (review-then-merge) — driven through the app against
 * a real repo, asserting real git state + the rendered menus/overlay. */
"use strict";
const { _electron: electron } = require("playwright");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("PASS:", m); };
function git(cwd, args) { try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } }

(async () => {
  // --- repo: committed a.txt/keep.txt on main; a `feature` branch ahead; then
  //     local working changes on main (modified a.txt + untracked u.txt). ---
  const REPO = path.join(os.tmpdir(), "atomnano-ctx-compare");
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, ["init", "-b", "main"]); git(REPO, ["config", "user.email", "t@t.co"]); git(REPO, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(REPO, "a.txt"), "hello\n");
  fs.writeFileSync(path.join(REPO, "keep.txt"), "keep\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "base"]);
  // feature branch: one new file + a change to keep.txt (→ 2 files differ from main)
  git(REPO, ["checkout", "-b", "feature"]);
  fs.writeFileSync(path.join(REPO, "feat.txt"), "feature work\n");
  fs.writeFileSync(path.join(REPO, "keep.txt"), "keep + feature\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "feature commit"]);
  git(REPO, ["checkout", "main"]);
  // give main its own divergent commit (doesn't touch a.txt) so a 3-way merge
  // (not a fast-forward) happens, and a.txt's HEAD stays "hello\n" for discard
  fs.writeFileSync(path.join(REPO, "main-only.txt"), "main side\n");
  git(REPO, ["add", "-A"]); git(REPO, ["commit", "-m", "main commit"]);
  git(REPO, ["checkout", "feature"]);   // end on feature → default compare = feature → main
  // local working changes on feature
  fs.writeFileSync(path.join(REPO, "a.txt"), "hello world\n");   // modified (unstaged)
  fs.writeFileSync(path.join(REPO, "u.txt"), "untracked\n");     // untracked

  const app = await electron.launch({ args: [ROOT], env: { ...process.env, ATOMNANO_TEST: "1" } });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  await win.waitForFunction(() => !!window.atomnano && typeof window.__openCompare === "function" && typeof window.__gitFileMenu === "function", null, { timeout: 15000 });
  await win.evaluate(() => window.__setFsSync && window.__setFsSync(false));

  await win.evaluate((p) => window.__setProject(p), REPO.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  const repo = (await win.evaluate(() => window.__gitRepos()))[0];
  ok(!!repo, `project repo discovered (${repo})`);

  const fileOf = (st, p) => st.files.find((f) => f.path === p);

  /* ---------- 1) per-file context menu: items + Stage ---------- */
  let st = await win.evaluate((r) => window.atomnano.git.status(r), repo);
  let items = await win.evaluate(({ r, f }) => { window.__gitFileMenu(r, f); return window.__ctxItems(); }, { r: repo, f: fileOf(st, "a.txt") });
  ok(items.includes("View diff"), `file menu has View diff (${JSON.stringify(items)})`);
  ok(items.includes("Stage"), "file menu offers Stage for an unstaged file");
  ok(items.includes("Discard changes"), "file menu offers Discard changes (rollback) for a tracked file");
  ok(items.includes("Copy path") && items.includes("Reveal in Explorer"), "file menu has Copy path + Reveal in Explorer");
  ok(items.some((t) => /Select for commit/.test(t)), "file menu offers Select for commit");

  await win.evaluate(({ r, f }) => { window.__gitFileMenu(r, f); window.__ctxClick("Stage"); }, { r: repo, f: fileOf(st, "a.txt") });
  await win.waitForTimeout(500);
  st = await win.evaluate((r) => window.atomnano.git.status(r), repo);
  ok(fileOf(st, "a.txt").staged === true, "clicking Stage in the file menu stages a.txt");

  /* ---------- 2) per-file context menu: Unstage ---------- */
  items = await win.evaluate(({ r, f }) => { window.__gitFileMenu(r, f); return window.__ctxItems(); }, { r: repo, f: fileOf(st, "a.txt") });
  ok(items.includes("Unstage"), "file menu offers Unstage for a staged file");
  await win.evaluate(({ r, f }) => { window.__gitFileMenu(r, f); window.__ctxClick("Unstage"); }, { r: repo, f: fileOf(st, "a.txt") });
  await win.waitForTimeout(500);
  st = await win.evaluate((r) => window.atomnano.git.status(r), repo);
  ok(fileOf(st, "a.txt").staged === false, "clicking Unstage in the file menu unstages a.txt");

  /* ---------- 3) Discard changes (rollback) → confirm → file reverts ---------- */
  await win.evaluate(({ r, f }) => { window.__gitFileMenu(r, f); window.__ctxClick("Discard changes"); }, { r: repo, f: fileOf(st, "a.txt") });
  await win.waitForTimeout(250);
  const hadConfirm = await win.evaluate(() => !!document.querySelector("#modalRoot .modal-foot .btn-danger"));
  ok(hadConfirm, "Discard changes opens a destructive confirmation dialog");
  await win.evaluate(() => { const b = document.querySelector("#modalRoot .modal-foot .btn-danger"); if (b) b.click(); });
  // discard runs git checkout asynchronously after the confirm — poll for the revert
  const aTxt = () => fs.readFileSync(path.join(REPO, "a.txt"), "utf8").replace(/\r\n/g, "\n");
  let reverted = false;
  for (let i = 0; i < 20 && !reverted; i++) { await win.waitForTimeout(150); reverted = aTxt() === "hello\n"; }
  ok(reverted, `confirming Discard rolls a.txt back to HEAD (content=${JSON.stringify(aTxt())})`);

  /* ---------- 4) repo (project group) context menu ---------- */
  st = await win.evaluate((r) => window.atomnano.git.status(r), repo);
  const tracked = st.files.filter((f) => f.label !== "Untracked");
  const repoItems = await win.evaluate(({ r, tr }) => { window.__gitRepoMenu(r, tr); return window.__ctxItems(); }, { r: repo, tr: tracked });
  ok(repoItems.includes("Stage all changes"), `repo menu has Stage all changes (${JSON.stringify(repoItems)})`);
  ok(repoItems.includes("Branches…"), "repo menu has Branches…");
  ok(repoItems.includes("Compare & merge…"), "repo menu has Compare & merge…");
  ok(!repoItems.some((t) => /^Merge a branch/.test(t)), "no standalone 'Merge a branch…' option (merging is in compare now)");
  ok(repoItems.includes("Pull"), "repo menu has Pull");
  ok(repoItems.includes("Discard all changes"), "repo menu has Discard all changes (rollback)");

  /* ---------- 5) Compare overlay defaults: source = current (feature), target = main ---------- */
  await win.evaluate((r) => window.__openCompare(r), repo);   // no refs → use defaults
  await win.waitForTimeout(800);
  const cmp = await win.evaluate(() => {
    const back = document.querySelector(".compare-overlay");
    if (!back) return { open: false };
    return {
      open: true,
      files: back.querySelectorAll(".cmp-file").length,
      count: (back.querySelector(".cmp-count") || {}).textContent || "",
      source: (back.querySelector(".cmp-ref.source .cmp-ref-name") || {}).textContent || "",
      target: (back.querySelector(".cmp-ref.target .cmp-ref-name") || {}).textContent || "",
      mergeLabel: (back.querySelector(".cmp-merge") || {}).textContent || "",
      mergeDisabled: !!(back.querySelector(".cmp-merge") || {}).disabled,
    };
  });
  ok(cmp.open, "compare overlay opens");
  ok(cmp.source === "feature" && cmp.target === "main", `defaults: source = current branch (feature), target = main (source=${cmp.source}, target=${cmp.target})`);
  ok(cmp.files >= 2, `compare lists what source adds over target (${cmp.files} files, "${cmp.count}")`);
  ok(/Merge\s+feature\s*→\s*main/.test(cmp.mergeLabel) && !cmp.mergeDisabled, `merge button reads "Merge feature → main" and is enabled (label="${cmp.mergeLabel}")`);

  // overlay is vertically centered (not pinned to the top)
  const centered = await win.evaluate(() => getComputedStyle(document.querySelector(".compare-overlay")).alignItems);
  ok(centered === "center", `compare overlay is center-aligned (align-items=${centered})`);

  // click the first changed file → its diff renders in the right pane
  const diffShown = await win.evaluate(async () => {
    const f = document.querySelector(".compare-overlay .cmp-file");
    if (!f) return false;
    f.click();
    await new Promise((r) => setTimeout(r, 600));
    const back = document.querySelector(".compare-overlay");
    return !!back.querySelector(".cmp-diff-scroll .diff-content") || !!back.querySelector(".cmp-diff .diff-empty");
  });
  ok(diffShown, "selecting a file in compare renders its diff in the right pane");

  /* ---------- 6) source / target dropdowns open ON TOP of the overlay ---------- */
  const srcMenu = await win.evaluate(() => {
    document.querySelector(".compare-overlay .cmp-ref.source").click();   // open the source picker
    const menu = document.getElementById("ctxMenu");
    const items = [...menu.querySelectorAll(".ctx-item")].map((e) => e.textContent.trim());
    const r = menu.getBoundingClientRect();
    const mid = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { hidden: menu.classList.contains("hidden"), items, onTop: menu.contains(mid) || mid === menu, z: getComputedStyle(menu).zIndex };
  });
  ok(!srcMenu.hidden, "clicking the source-branch picker opens its dropdown");
  ok(srcMenu.items.some((t) => /main/.test(t)) && srcMenu.items.some((t) => /feature/.test(t)), `source dropdown lists the branch options (${JSON.stringify(srcMenu.items)})`);
  ok(srcMenu.onTop, `source dropdown renders ON TOP of the compare overlay — not hidden behind it (z=${srcMenu.z})`);

  // pick "main" as the source
  await win.evaluate(() => { const el = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => /^main/.test(e.textContent.trim())); if (el) el.click(); });
  await win.waitForTimeout(500);
  const src2 = await win.evaluate(() => (document.querySelector(".compare-overlay .cmp-ref.source .cmp-ref-name") || {}).textContent || "");
  ok(src2 === "main", `choosing an option updates the source ref (source=${src2})`);

  // the target picker also opens with options on top
  const tgtMenu = await win.evaluate(() => {
    document.querySelector(".compare-overlay .cmp-ref.target").click();
    const menu = document.getElementById("ctxMenu");
    const r = menu.getBoundingClientRect();
    const mid = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { hidden: menu.classList.contains("hidden"), items: [...menu.querySelectorAll(".ctx-item")].map((e) => e.textContent.trim()), onTop: menu.contains(mid) || mid === menu };
  });
  ok(!tgtMenu.hidden && tgtMenu.items.length >= 2 && tgtMenu.onTop, `target-branch dropdown opens with options on top (${JSON.stringify(tgtMenu.items)})`);
  await win.evaluate(() => { const el = [...document.querySelectorAll("#ctxMenu .ctx-item")].find((e) => /^feature/.test(e.textContent.trim())); if (el) el.click(); });
  await win.waitForTimeout(600);
  const reloaded = await win.evaluate(() => ({ target: (document.querySelector(".compare-overlay .cmp-ref.target .cmp-ref-name") || {}).textContent || "", files: document.querySelectorAll(".compare-overlay .cmp-file").length }));
  ok(reloaded.target === "feature" && reloaded.files >= 1, `choosing a target reloads the comparison (target=${reloaded.target}, ${reloaded.files} file)`);

  /* ---------- 7) the Merge button merges the SELECTED source → target, with a message ---------- */
  await win.evaluate((r) => window.__openCompare(r, "feature", "main"), repo);   // source=feature, target=main
  await win.waitForTimeout(700);
  const mlabel = await win.evaluate(() => (document.querySelector(".compare-overlay .cmp-merge") || {}).textContent || "");
  ok(/Merge\s+feature\s*→\s*main/.test(mlabel), `merge button targets the selected branches (label="${mlabel}")`);
  await win.evaluate(() => document.querySelector(".compare-overlay .cmp-merge").click());   // opens the merge dialog
  await win.waitForTimeout(300);
  const mdlg = await win.evaluate(() => {
    const inp = document.querySelector("#modalRoot .prompt-input");
    return { hasInput: !!inp, value: inp ? inp.value : "", hasConfirm: !!document.querySelector("#modalRoot .modal-foot .btn-primary") };
  });
  ok(mdlg.hasInput, "the merge dialog has a commit-message input");
  ok(/Merge branch 'feature' into main/.test(mdlg.value), `merge message is pre-filled (value="${mdlg.value}")`);
  // the dialog must layer ON TOP of the still-open compare overlay
  const dlgOnTop = await win.evaluate(() => {
    const modal = document.querySelector("#modalRoot .modal-backdrop");
    const overlay = document.querySelector(".compare-overlay");
    if (!modal || !overlay) return { ok: false, modal: !!modal, overlay: !!overlay };
    const box = modal.querySelector(".modal").getBoundingClientRect();
    const mid = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
    return { ok: modal.contains(mid), inOverlay: overlay.contains(mid), z: getComputedStyle(modal).zIndex };
  });
  ok(dlgOnTop.ok, `merge dialog renders ABOVE the compare overlay (z=${dlgOnTop.z}, hit-test inside dialog=${dlgOnTop.ok})`);
  // edit the message, then confirm
  const MSG = "Merge feature headline into main (PR #7)";
  await win.evaluate((m) => { const inp = document.querySelector("#modalRoot .prompt-input"); inp.value = m; inp.dispatchEvent(new Event("input", { bubbles: true })); }, MSG);
  await win.evaluate(() => { const b = document.querySelector("#modalRoot .modal-foot .btn-primary"); if (b) b.click(); });
  // merge runs async (checkout target + merge source) — poll for the result
  let merged = false, head = "";
  for (let i = 0; i < 40 && !merged; i++) {
    await win.waitForTimeout(200);
    head = git(REPO, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    merged = head === "main" && fs.existsSync(path.join(REPO, "feat.txt"));
  }
  ok(merged, `Merge checked out the target (main) and merged the source (feature) into it (HEAD=${head}, feat.txt present=${fs.existsSync(path.join(REPO, "feat.txt"))})`);
  ok(/feature commit/.test(git(REPO, ["log", "--oneline"])), "the source branch's commit is now in the target's history");
  ok(git(REPO, ["log", "-1", "--pretty=%s"]).trim() === MSG, `the custom merge message is used for the merge commit (subject="${git(REPO, ["log", "-1", "--pretty=%s"]).trim()}")`);
  ok(await win.evaluate(() => !document.querySelector(".compare-overlay")), "compare overlay closes after merging");

  /* ---------- 8) "Merge a branch…" is gone from the branch menu; compare is the merge path ---------- */
  const bm = await win.evaluate(async (r) => {
    await window.__openBranchMenu(r);
    await new Promise((res) => setTimeout(res, 80));
    const items = [...document.querySelectorAll("#ctxMenu .ctx-item")].map((e) => e.textContent.trim());
    window.__hideCtx();
    return items;
  }, repo);
  ok(!bm.some((t) => /^Merge a branch/.test(t)), `branch menu no longer has "Merge a branch…" (${JSON.stringify(bm)})`);
  ok(bm.some((t) => /^Compare & merge/.test(t)), "branch menu offers Compare & merge… (the merge path)");

  /* ---------- 9) a CONFLICTING merge is handled gracefully (guided resolver opens) ---------- */
  const REPO2 = path.join(os.tmpdir(), "atomnano-ctx-conflict");
  fs.rmSync(REPO2, { recursive: true, force: true }); fs.mkdirSync(REPO2, { recursive: true });
  git(REPO2, ["init", "-b", "main"]); git(REPO2, ["config", "user.email", "t@t.co"]); git(REPO2, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(REPO2, "x.txt"), "base line\n");
  git(REPO2, ["add", "-A"]); git(REPO2, ["commit", "-m", "base"]);
  git(REPO2, ["checkout", "-b", "dev"]);
  fs.writeFileSync(path.join(REPO2, "x.txt"), "dev change\n");
  git(REPO2, ["add", "-A"]); git(REPO2, ["commit", "-m", "dev"]);
  git(REPO2, ["checkout", "main"]);
  fs.writeFileSync(path.join(REPO2, "x.txt"), "main change\n");   // diverges on the same line → conflict
  git(REPO2, ["add", "-A"]); git(REPO2, ["commit", "-m", "main"]);
  git(REPO2, ["checkout", "dev"]);
  await win.evaluate((p) => window.__setProject(p), REPO2.replace(/\\/g, "/"));
  await win.waitForTimeout(300);
  await win.evaluate((r) => window.__openCompare(r, "dev", "main"), REPO2.replace(/\\/g, "/"));
  await win.waitForTimeout(600);
  await win.evaluate(() => document.querySelector(".compare-overlay .cmp-merge").click());
  await win.waitForTimeout(250);
  await win.evaluate(() => { const b = document.querySelector("#modalRoot .modal-foot .btn-primary"); if (b) b.click(); });
  // poll for: repo left in a merging state + the guided resolver overlay opened
  let conflictHandled = false, mergingState = false, resolverOpen = false, bannerShown = false;
  for (let i = 0; i < 40 && !conflictHandled; i++) {
    await win.waitForTimeout(200);
    mergingState = fs.existsSync(path.join(REPO2, ".git", "MERGE_HEAD"));
    resolverOpen = await win.evaluate(() => !!document.querySelector(".merge-overlay"));
    bannerShown = await win.evaluate(() => !!document.querySelector(".gv-merge-banner"));
    conflictHandled = mergingState && resolverOpen;
  }
  ok(git(REPO2, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() === "main", "conflicting merge left the repo on the target branch (main)");
  ok(mergingState, "conflicting merge leaves the repo in a clean merging state (MERGE_HEAD)");
  ok(resolverOpen, "a conflicting merge opens the guided conflict resolver automatically");
  ok(bannerShown, "the commit view shows a merge-in-progress banner during the conflict");
  // abort to clean up
  await win.evaluate((r) => window.__gitMergeAbort(r), REPO2.replace(/\\/g, "/"));
  await win.waitForTimeout(300);

  ok(errors.length === 0, "no page errors during context-menu / compare flow" + (errors.length ? " — " + errors.join(" | ") : ""));

  await app.close();
  console.log(process.exitCode ? "\nSOME CONTEXT-MENU / COMPARE TESTS FAILED" : "\nALL CONTEXT-MENU / COMPARE TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
