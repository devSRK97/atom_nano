"use strict";
/* Git backend regression suite — DESIRED behaviour for the audit findings
 * (ATOMNANO_GIT_AUDIT_2026-09-09, GIT-001..GIT-040), against the real `git`.
 *
 * Every test builds a fresh repository under a temp folder with ISOLATED Git
 * configuration (GIT_CONFIG_GLOBAL → temp file, GIT_CONFIG_NOSYSTEM=1) and LOCAL
 * bare remotes only. The user's repositories, credentials and profile are never
 * touched. Run:  node scripts/test-git.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-git-test-"));
const GCFG = path.join(ROOT, "gitconfig");
fs.writeFileSync(GCFG, "[user]\n\tname = Test User\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = GCFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.HOME = ROOT; process.env.USERPROFILE = ROOT;
delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE; delete process.env.GIT_INDEX_FILE;

const git = require("../src/main/git");

let pass = 0, failN = 0; const failures = [];
function check(name, cond, extra) { if (cond) { pass++; } else { failN++; failures.push(name + (extra ? " — " + extra : "")); console.log("  FAIL " + name + (extra ? "  (" + extra + ")" : "")); } }
async function throws(name, fn, re) {
  try { await fn(); check(name, false, "did not throw"); return null; }
  catch (e) { const ok = !re || re.test(e.message) || re.test(e.type || ""); check(name, ok, ok ? "" : `threw: ${e.message} [${e.type}]`); return e; }
}
function sh(cwd, args, opts = {}) { return execFileSync("git", args, { cwd, encoding: opts.buffer ? undefined : "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }); }
let n = 0;
function fresh(name) {
  const dir = path.join(ROOT, `${name}-${++n}`);
  fs.mkdirSync(dir);
  sh(dir, ["init", "-q", "-b", "main"]);
  return dir;
}
function w(dir, rel, content) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; }
function commitAll(dir, msg) { sh(dir, ["add", "-A"]); sh(dir, ["commit", "-q", "-m", msg]); return sh(dir, ["rev-parse", "HEAD"]).trim(); }
function bare(name) { const d = path.join(ROOT, `${name}-${++n}.git`); sh(ROOT, ["init", "-q", "--bare", d]); return d; }
function seeded(name) { const d = fresh(name); w(d, "a.txt", "a\n"); w(d, "b.txt", "b\n"); w(d, "dir/c.txt", "c\n"); commitAll(d, "init"); return d; }

// A hang (e.g. a lock waiting on itself) must FAIL loudly — never let the event loop
// drain and exit 0 with half the suite unrun.
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT — a test never settled (deadlock?)"); process.exit(3); }, 240000);

async function main() {
  console.log("git:", sh(ROOT, ["--version"]).trim(), " fixtures:", ROOT);

  // ---------- G01 literal paths: a[1].txt never also matches a1.txt ----------
  {
    const d = seeded("literal");
    w(d, "a[1].txt", "one\n"); w(d, "a1.txt", "other\n");
    const r = await git.stage(d, ["a[1].txt"]);
    check("G01 stage returns success", r.ok && r.state === "success");
    const st = await git.status(d);
    const s1 = st.files.find((f) => f.path === "a[1].txt"), s2 = st.files.find((f) => f.path === "a1.txt");
    check("G01 a[1].txt staged", s1 && s1.staged && s1.index === "A");
    check("G01 a1.txt still untracked", s2 && s2.untracked && !s2.staged);
    // unstage literal too
    await git.unstage(d, ["a[1].txt"]);
    const st2 = await git.status(d);
    check("G01 unstage literal", st2.files.find((f) => f.path === "a[1].txt").untracked);
    // very many paths (argument-length) go through stdin
    const many = []; for (let i = 0; i < 3000; i++) { const p = `bulk/very-long-directory-name-to-blow-the-command-line/${i}-${"x".repeat(60)}.txt`; w(d, p, String(i)); many.push(p); }
    const rb = await git.stage(d, many);
    check("G01 3000 paths staged via stdin", rb.ok);
    const st3 = await git.status(d);
    check("G01 all 3000 staged", st3.files.filter((f) => f.path.startsWith("bulk/") && f.staged).length === 3000);
  }

  // ---------- G02 porcelain v2: quoted names, unborn, detached, renames, unversioned ----------
  {
    const d = fresh("status");
    const st0 = await git.status(d);
    check("G02 unborn reported", st0.repo && st0.unborn === true && st0.branch === "main" && st0.oid === "");
    w(d, "sp ace.txt", "1\n"); w(d, "ünï.txt", "2\n"); w(d, "q'uote#hash.txt", "3\n");   // (`"` is not a legal NTFS name)
    const st1 = await git.status(d);
    check("G02 space name literal", st1.files.some((f) => f.path === "sp ace.txt"));
    check("G02 unicode name literal", st1.files.some((f) => f.path === "ünï.txt"));
    check("G02 quote/hash name literal", st1.files.some((f) => f.path === "q'uote#hash.txt"));
    check("G02 clean=false with untracked", st1.clean === false);
    commitAll(d, "one");
    // rename
    sh(d, ["mv", "sp ace.txt", "moved.txt"]);
    const st2 = await git.status(d);
    const rn = st2.files.find((f) => f.path === "moved.txt");
    check("G02 rename record with orig", rn && rn.index === "R" && rn.orig === "sp ace.txt");
    check("G02 rename is ONE record (no phantom delete)", !st2.files.some((f) => f.path === "sp ace.txt"));
    // unversion: rm --cached
    sh(d, ["rm", "--cached", "-q", "ünï.txt"]);
    const st3 = await git.status(d);
    const uv = st3.files.filter((f) => f.path === "ünï.txt");
    check("G02 unversioned is ONE record", uv.length === 1 && uv[0].stagedDelete && uv[0].keptOnDisk && uv[0].label === "Unversioned");
    // detached
    sh(d, ["reset", "-q", "--hard"]); sh(d, ["checkout", "-q", "--detach"]);
    const st4 = await git.status(d);
    check("G02 detached reported", st4.detached === true && st4.branch === "");
    // index vs worktree separate
    sh(d, ["checkout", "-q", "main"]);
    w(d, "ünï.txt", "changed\n"); sh(d, ["add", "ünï.txt"]); w(d, "ünï.txt", "changed again\n");
    const st5 = await git.status(d);
    const mm = st5.files.find((f) => f.path === "ünï.txt");
    check("G02 MM shows index+worktree", mm && mm.index === "M" && mm.worktree === "M" && mm.staged && mm.unstaged);
  }

  // ---------- G03 CommitPlan: only the selected paths, unrelated staged work untouched, hooks run ----------
  {
    const d = seeded("plan");
    w(d, "a.txt", "a2\n"); w(d, "b.txt", "b2\n"); w(d, "new.txt", "n\n");
    sh(d, ["add", "b.txt"]);                    // unrelated staged work
    // a hook that records it ran + sees only the planned content
    const hooks = path.join(d, ".git", "hooks"); fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\ngit diff --cached --name-only > .git/hook-saw.txt\nexit 0\n");   // hooks run from the worktree root
    const before = sh(d, ["rev-parse", "HEAD"]).trim();
    const r = await git.commitPlan(d, { message: "only a + new", paths: ["a.txt", "new.txt"], expectHead: before });
    check("G03 plan commit ok", r.ok && r.state === "success" && r.committed && r.reconciled, JSON.stringify(r));
    const files = sh(d, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n").sort();
    check("G03 commit contains exactly a.txt,new.txt", files.join(",") === "a.txt,new.txt", files.join(","));
    const st = await git.status(d);
    const b = st.files.find((f) => f.path === "b.txt");
    check("G03 b.txt still staged (untouched)", b && b.staged && b.index === "M");
    check("G03 a.txt clean after commit", !st.files.some((f) => f.path === "a.txt"));
    const saw = fs.existsSync(path.join(d, ".git", "hook-saw.txt")) ? fs.readFileSync(path.join(d, ".git", "hook-saw.txt"), "utf8").trim().split("\n").sort().join(",") : "(hook did not run)";
    check("G03 pre-commit hook ran against the plan", saw === "a.txt,new.txt", saw);
    check("G03 no temp index left", !fs.readdirSync(path.join(d, ".git")).some((f) => f.startsWith("atomnano-index")));
    // stale review → refused
    await throws("G03 expectHead mismatch refused", () => git.commitPlan(d, { message: "x", paths: ["b.txt"], expectHead: before }), /moved since/);
    // rename pair + untrack intent
    sh(d, ["mv", "dir/c.txt", "dir/d.txt"]); w(d, "b.txt", "b3\n");
    const r2 = await git.commitPlan(d, { message: "rename + untrack", paths: [{ path: "dir/d.txt", orig: "dir/c.txt" }, { path: "b.txt", untrack: true }] });
    check("G03 rename+untrack commit ok", r2.ok, JSON.stringify(r2));
    const ns = sh(d, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "HEAD"]).trim();
    check("G03 rename recorded as rename", /R\d+\tdir\/c\.txt\tdir\/d\.txt/.test(ns), ns);
    check("G03 untrack recorded as delete", /^D\tb\.txt/m.test(ns), ns);
    check("G03 untracked file kept on disk", fs.existsSync(path.join(d, "b.txt")));
    const st2 = await git.status(d);
    check("G03 b.txt now untracked in status", st2.files.some((f) => f.path === "b.txt" && f.untracked));
    // amend: message only keeps tree; amend with paths adds them
    const treeBefore = sh(d, ["rev-parse", "HEAD^{tree}"]).trim();
    const r3 = await git.commitPlan(d, { message: "reworded", paths: [], amend: true });
    check("G03 message-only amend keeps tree", r3.ok && sh(d, ["rev-parse", "HEAD^{tree}"]).trim() === treeBefore && sh(d, ["log", "-1", "--pretty=%s"]).trim() === "reworded");
    w(d, "a.txt", "a3\n"); w(d, "zz.txt", "z\n"); sh(d, ["add", "zz.txt"]);
    const r4 = await git.commitPlan(d, { message: "amend a", paths: ["a.txt"], amend: true });
    const files4 = sh(d, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n").sort().join(",");
    check("G03 amend adds only a.txt (zz stays staged)", r4.ok && files4 === "a.txt,b.txt,dir/c.txt,dir/d.txt" && (await git.status(d)).files.some((f) => f.path === "zz.txt" && f.staged), files4);
    // nothing selected differs → explicit error
    await throws("G03 nothing-to-commit explicit", () => git.commitPlan(d, { message: "x", paths: ["a.txt"] }), /Nothing to commit/);
  }

  // ---------- G04 ref validation: option-looking names and revisions rejected before git runs ----------
  {
    const d = seeded("refs");
    for (const bad of ["-D", "--hard", "-", "a..b", "x y", "feat/", "/x", "x.lock", "a@{1}", "~x"]) await throws(`G04 reject branch name ${JSON.stringify(bad)}`, () => git.branchCreate(d, bad), /not a valid|invalid/);
    await throws("G04 reset refuses option-like ref", () => git.reset(d, "--hard", "soft"), /not a valid revision|invalid/);
    await throws("G04 reset refuses bad mode", () => git.reset(d, "HEAD", "--hard"), /mode must be/);
    await throws("G04 checkout of unknown ref", () => git.checkout(d, "nope"), /not a branch|notFound/);
    await throws("G04 tag rejects option", () => git.tagCreate(d, "-f"), /not a valid|invalid/);
    await throws("G04 log rejects option ref", () => git.log(d, { ref: "--output=/tmp/x" }), /Invalid ref|invalid/);
    const ok = await git.branchCreate(d, "feature/ok");
    check("G04 valid name accepted", ok.ok && sh(d, ["branch", "--list", "feature/ok"]).trim() !== "");
    // a file with the same name as a branch does not confuse switch
    w(d, "topic", "file\n"); sh(d, ["add", "topic"]); sh(d, ["commit", "-q", "-m", "f"]); sh(d, ["branch", "topic"]);
    const co = await git.checkout(d, "topic");
    check("G04 switch to branch that shares a file name", co.ok && co.branch === "topic", JSON.stringify(co));
    // review binding
    const oid = sh(d, ["rev-parse", "feature/ok"]).trim();
    sh(d, ["update-ref", "refs/heads/feature/ok", sh(d, ["rev-parse", "HEAD"]).trim()]);
    await throws("G04 expect revalidation catches moved ref", () => git.checkout(d, "feature/ok", { expect: { "feature/ok": oid } }), /moved since/);
  }

  // ---------- G05 push plan: no invented origin; fully qualified refspecs; upstream only when asked ----------
  {
    const d = seeded("push");
    const up = bare("upstream"), fork = bare("fork");
    sh(d, ["remote", "add", "upstream", up]); sh(d, ["remote", "add", "fork", fork]);
    await throws("G05 push without any upstream/remote config refuses to guess", () => git.push(d), /no upstream|choose a remote|no remote/i);
    sh(d, ["config", "remote.pushDefault", "fork"]);
    const plan = await git.pushPlan(d, {});
    check("G05 plan resolves remote.pushDefault", plan.remote === "fork" && plan.dest === "main" && plan.hasUpstream === false, JSON.stringify(plan));
    const r = await git.push(d);
    check("G05 push honours plan (fork)", r.ok && r.remote === "fork", JSON.stringify(r));
    check("G05 fork received main", sh(fork, ["rev-parse", "refs/heads/main"]).trim() === sh(d, ["rev-parse", "HEAD"]).trim());
    let hasUp = true; try { sh(d, ["config", "--get", "branch.main.remote"]); } catch { hasUp = false; }
    check("G05 branch.main.remote absent after plain push", !hasUp);
    // branch named like a tag on remote: qualified refspec keeps them apart
    sh(d, ["tag", "v1"]); sh(d, ["branch", "v1"]);
    const rt = await git.pushBranch(d, { remote: "upstream", tag: "v1" });
    check("G05 tag push qualified", rt.ok && sh(up, ["rev-parse", "refs/tags/v1"]).trim() !== "");
    let branchOnRemote = true; try { sh(up, ["rev-parse", "-q", "--verify", "refs/heads/v1"]); } catch { branchOnRemote = false; }
    check("G05 tag push did not create branch v1", !branchOnRemote);
    const rb = await git.pushBranch(d, { branch: "v1", remote: "upstream", dest: "v1", setUpstream: true });
    check("G05 explicit set-upstream works", rb.ok && sh(d, ["config", "--get", "branch.v1.remote"]).trim() === "upstream");
    // reject non-ff → state rejected (result, not exception)
    const other = path.join(ROOT, `clone-${++n}`); sh(ROOT, ["clone", "-q", fork, other]);
    w(other, "z.txt", "z\n"); sh(other, ["add", "-A"]); sh(other, ["-c", "user.name=o", "-c", "user.email=o@x.invalid", "commit", "-q", "-m", "remote work"]); sh(other, ["push", "-q", "fork" === "fork" ? "origin" : "origin", "main"]);
    w(d, "a.txt", "local\n"); commitAll(d, "local work");
    const rej = await git.pushBranch(d, { branch: "main", remote: "fork", dest: "main" });
    check("G05 non-ff push → rejected result", rej.ok === false && rej.state === "rejected" && rej.rejected === true, JSON.stringify(rej).slice(0, 200));
    // force-with-lease pinned to the reviewed remote oid
    sh(d, ["fetch", "-q", "fork"]);
    const remoteOid = sh(d, ["rev-parse", "refs/remotes/fork/main"]).trim();
    const forced = await git.pushBranch(d, { branch: "main", remote: "fork", dest: "main", force: true, expectedRemoteOid: remoteOid });
    check("G05 force-with-lease ok when expectation holds", forced.ok, JSON.stringify(forced).slice(0, 200));
    w(d, "a.txt", "local2\n"); commitAll(d, "local work 2");
    const stale = await git.pushBranch(d, { branch: "main", remote: "fork", dest: "main", force: true, expectedRemoteOid: remoteOid.replace(/^./, remoteOid[0] === "a" ? "b" : "a") });
    check("G05 force-with-lease refuses stale expectation", !stale.ok && stale.state === "rejected", JSON.stringify(stale).slice(0, 160));
  }

  // ---------- G06 merge target must be a local branch; rebase branch local ----------
  {
    const d = seeded("merge");
    const rem = bare("rem"); sh(d, ["remote", "add", "origin", rem]); sh(d, ["push", "-q", "origin", "main"]);
    sh(d, ["checkout", "-q", "-b", "feat"]); w(d, "f.txt", "f\n"); commitAll(d, "feat"); sh(d, ["checkout", "-q", "main"]);
    await throws("G06 merge into remote-tracking ref refused", () => git.mergeBranches(d, "feat", "origin/main"), /remote-tracking|not a local branch/);
    sh(d, ["tag", "t1"]);
    await throws("G06 merge into tag refused", () => git.mergeBranches(d, "feat", "t1"), /tag|not a local branch/);
    await throws("G06 rebase of remote-tracking branch refused", () => git.rebase(d, "main", { branch: "origin/main" }), /not a local branch/);
    const m = await git.mergeBranches(d, "feat", "main");
    check("G06 merge into local branch", m.ok && m.state === "success" && (await git.currentBranch(d)) === "main", JSON.stringify(m));
    check("G06 branch moved", sh(d, ["diff", "--quiet", "main", "feat"]) === "");
    check("G06 origin/main untouched", sh(rem, ["rev-parse", "main"]).trim() !== sh(d, ["rev-parse", "main"]).trim());
    // detached HEAD + merge()
    sh(d, ["checkout", "-q", "--detach"]);
    await throws("G06 merge() on detached HEAD refused", () => git.merge(d, "feat"), /detached/);
  }

  // ---------- G07 conflicts are results; repoState knows sides; continue dispatch by operation ----------
  {
    const d = seeded("conflict");
    sh(d, ["checkout", "-q", "-b", "side"]); w(d, "a.txt", "side\n"); commitAll(d, "side");
    sh(d, ["checkout", "-q", "main"]); w(d, "a.txt", "main\n"); commitAll(d, "main");
    const m = await git.merge(d, "side");
    check("G07 merge conflict is a result", m.ok === false && m.state === "conflict" && m.conflict === true, JSON.stringify(m).slice(0, 200));
    const st = await git.repoState(d);
    check("G07 repoState merge + sides", st.op === "merge" && st.sides.mine === "ours" && st.actions.includes("continue"));
    const cs = await git.conflictStages(d, "a.txt");
    check("G07 conflictStages has 3 stages", cs.base && cs.ours && cs.theirs && !cs.modifyDelete);
    await throws("G07 continue with unresolved refused", () => git.mergeContinue(d), /unresolved/i);
    const rw = await git.resolveWith(d, ["a.txt"], "theirs");
    check("G07 resolveWith theirs", rw.ok && fs.readFileSync(path.join(d, "a.txt"), "utf8") === "side\n");
    const c = await git.mergeContinue(d);
    check("G07 mergeContinue commits merge", c.ok && c.op === "merge" && !c.stillInProgress, JSON.stringify(c).slice(0, 200));
    check("G07 merge commit has 2 parents", sh(d, ["rev-list", "--parents", "-n1", "HEAD"]).trim().split(" ").length === 3);
    // rebase conflict: sides swapped, continue dispatches to rebase
    sh(d, ["checkout", "-q", "-b", "rb", "HEAD~1"]); w(d, "a.txt", "rb\n"); commitAll(d, "rb");
    const rb = await git.rebase(d, "main");
    check("G07 rebase conflict is a result", rb.ok === false && rb.state === "conflict");
    const st2 = await git.repoState(d);
    check("G07 rebase sides swapped", st2.op === "rebase" && st2.sides.mine === "theirs" && st2.sides.incoming === "ours" && st2.actions.includes("skip"));
    // keep MINE during a rebase → git "theirs"
    const keepMine = await git.resolveWith(d, ["a.txt"], st2.sides.mine);
    check("G07 keep-mine during rebase keeps rb content", keepMine.ok && fs.readFileSync(path.join(d, "a.txt"), "utf8") === "rb\n");
    const c2 = await git.mergeContinue(d);
    check("G07 continue dispatches to rebase --continue", c2.ok && c2.op === "rebase" && !(await git.repoState(d)).op, JSON.stringify(c2).slice(0, 200));
    // no-op continue/abort explicit
    await throws("G07 continue with nothing in progress", () => git.mergeContinue(d), /No merge/);
    await throws("G07 abort with nothing in progress", () => git.mergeAbort(d), /No merge/);
    // modify/delete: missing stage → deletion
    sh(d, ["checkout", "-q", "main"]); sh(d, ["checkout", "-q", "-b", "del"]); sh(d, ["rm", "-q", "b.txt"]); sh(d, ["commit", "-q", "-m", "del b"]);
    sh(d, ["checkout", "-q", "main"]); w(d, "b.txt", "b-main\n"); commitAll(d, "mod b");
    const md = await git.merge(d, "del");
    check("G07 modify/delete conflict result", md.state === "conflict");
    const stg = await git.conflictStages(d, "b.txt");
    check("G07 modify/delete detected", stg.modifyDelete && !stg.theirs);
    const rd = await git.resolveWith(d, ["b.txt"], "theirs");
    check("G07 taking the deleted side deletes", rd.ok && rd.results[0].action === "deleted" && !fs.existsSync(path.join(d, "b.txt")));
    await git.mergeContinue(d);
    // bisect is NOT a merge
    sh(d, ["bisect", "start"]);
    const bs = await git.repoState(d);
    check("G07 bisect state distinct", bs.op === "bisect" && bs.actions.includes("bisect-reset"));
    await throws("G07 continue during bisect refused", () => git.mergeContinue(d), /bisect/);
    const ab = await git.mergeAbort(d);
    check("G07 abort during bisect = bisect reset", ab.ok && ab.op === "bisect" && !(await git.repoState(d)).op);
  }

  // ---------- G08 discard: per-path outcomes, no delete after failed unstage, renames ----------
  {
    const d = seeded("discard");
    w(d, "a.txt", "mod\n"); w(d, "new.txt", "n\n"); sh(d, ["add", "new.txt"]); w(d, "untracked.txt", "u\n");
    sh(d, ["mv", "b.txt", "b2.txt"]);
    const r = await git.discard(d, ["a.txt", "new.txt", "untracked.txt", "b2.txt", "nothing.txt"]);
    check("G08 discard ok with per-path results", r.ok && r.results.length >= 5, JSON.stringify(r).slice(0, 300));
    check("G08 a.txt restored", fs.readFileSync(path.join(d, "a.txt"), "utf8") === "a\n");
    check("G08 staged new removed", !fs.existsSync(path.join(d, "new.txt")));
    check("G08 untracked removed", !fs.existsSync(path.join(d, "untracked.txt")));
    check("G08 rename undone (b.txt back, b2 gone)", fs.existsSync(path.join(d, "b.txt")) && !fs.existsSync(path.join(d, "b2.txt")));
    check("G08 unknown path reported harmlessly", r.results.some((x) => x.path === "nothing.txt" && x.ok));
    check("G08 tree clean", (await git.status(d)).clean);
    // literal
    w(d, "a[1].txt", "1\n"); w(d, "a1.txt", "2\n");
    await git.discard(d, ["a[1].txt"]);
    check("G08 discard literal path only", !fs.existsSync(path.join(d, "a[1].txt")) && fs.existsSync(path.join(d, "a1.txt")));
  }

  // ---------- G09 diff baselines: clean tracked → empty; staged vs working distinct; untracked → no-index ----------
  {
    const d = seeded("diff");
    const clean = await git.diff(d, "a.txt");
    check("G09 clean tracked file → empty diff (not fabricated)", clean.text === "" && clean.mode === "working");
    w(d, "a.txt", "idx\n"); sh(d, ["add", "a.txt"]); w(d, "a.txt", "wt\n");
    const staged = await git.diff(d, "a.txt", { staged: true }), work = await git.diff(d, "a.txt");
    check("G09 staged diff shows index", /\+idx/.test(staged.text) && !/\+wt/.test(staged.text));
    check("G09 working diff shows worktree vs index", /\+wt/.test(work.text) && /-idx/.test(work.text));
    const head = await git.fileDiff(d, "a.txt");
    check("G09 fileDiff = HEAD→working", /-a\b/.test(head.text) && /\+wt/.test(head.text) && head.mode === "head");
    w(d, "u.txt", "u\n");
    const u = await git.diff(d, "u.txt");
    check("G09 untracked → no-index diff", u.untracked && /\+u/.test(u.text));
    await throws("G09 missing path is an error", () => git.diff(d, "ghost.txt"), /does not exist|notFound/);
    w(d, "a[1].txt", "x\n"); w(d, "a1.txt", "y\n");
    const lit = await git.diff(d, "a[1].txt");
    check("G09 diff literal path", /\+x/.test(lit.text) && !/\+y/.test(lit.text));
  }

  // ---------- G10 stashes by object id ----------
  {
    const d = seeded("stash");
    w(d, "a.txt", "s1\n"); sh(d, ["stash", "push", "-q", "-m", "first"]);
    w(d, "a.txt", "s2\n"); sh(d, ["stash", "push", "-q", "-m", "second"]);
    const list = await git.stashList(d);
    check("G10 list has hashes", list.stashes.length === 2 && list.stashes.every((s) => /^[0-9a-f]{40}$/.test(s.hash)) && list.stashes[0].message === "second");
    const first = list.stashes.find((s) => s.message === "first");
    sh(d, ["stash", "drop", "-q", "stash@{0}"]);                 // list renumbers: "first" is now @{0}
    const show = await git.stashShow(d, { hash: first.hash });
    check("G10 show by hash after renumbering", show.files.some((f) => f.path === "a.txt") && show.hash === first.hash);
    const ap = await git.stashApply(d, { hash: first.hash }, { pop: true });
    check("G10 pop by hash", ap.ok && fs.readFileSync(path.join(d, "a.txt"), "utf8") === "s1\n");
    await throws("G10 vanished stash reported", () => git.stashDrop(d, { hash: first.hash }), /no longer exists|notFound/);
    // stash with paths + untracked
    w(d, "un.txt", "u\n"); w(d, "b.txt", "bb\n");
    const sv = await git.stashSave(d, { message: "partial", includeUntracked: true, paths: ["un.txt"] });
    check("G10 partial stash by path", sv.ok && fs.existsSync(path.join(d, "b.txt")) && !fs.existsSync(path.join(d, "un.txt")), JSON.stringify(sv));
    const l2 = await git.stashList(d);
    const sh2 = await git.stashShow(d, { hash: l2.stashes[0].hash });
    check("G10 stash show lists untracked part", sh2.files.some((f) => f.path === "un.txt"));
    const fd = await git.stashFileDiff(d, { hash: l2.stashes[0].hash }, "un.txt");
    check("G10 stash untracked file diff", /\+u/.test(fd.text));
  }

  // ---------- G11 tags: remote first, qualified refs, phases ----------
  {
    const d = seeded("tags");
    const rem = bare("tagrem"); sh(d, ["remote", "add", "origin", rem]); sh(d, ["push", "-q", "origin", "main"]);
    sh(d, ["tag", "-a", "-m", "release", "v1"]); sh(d, ["branch", "v1"]); sh(d, ["push", "-q", "origin", "refs/tags/v1", "refs/heads/v1"]);
    const t = await git.tags(d);
    check("G11 tags list annotated", t.tags.length === 1 && t.tags[0].annotated && t.tags[0].oid === sh(d, ["rev-parse", "HEAD"]).trim());
    const del = await git.tagDelete(d, "v1", { remote: "origin" });
    check("G11 tag delete both phases", del.ok && del.phases.remote.ok && del.phases.local.ok, JSON.stringify(del));
    let remoteTag = true; try { sh(rem, ["rev-parse", "-q", "--verify", "refs/tags/v1"]); } catch { remoteTag = false; }
    check("G11 remote tag gone", !remoteTag);
    check("G11 remote BRANCH v1 untouched", sh(rem, ["rev-parse", "refs/heads/v1"]).trim() !== "");
    check("G11 local branch v1 untouched", sh(d, ["rev-parse", "refs/heads/v1"]).trim() !== "");
    // remote failure keeps local tag
    sh(d, ["tag", "v2"]); sh(d, ["remote", "add", "dead", path.join(ROOT, "does-not-exist.git")]);
    const bad = await git.tagDelete(d, "v2", { remote: "dead" });
    check("G11 remote failure → local tag kept", !bad.ok && bad.phases.remote && !bad.phases.remote.ok && sh(d, ["tag", "--list", "v2"]).trim() === "v2", JSON.stringify(bad).slice(0, 200));
    await throws("G11 delete missing tag explicit", () => git.tagDelete(d, "nope"), /does not exist/);
  }

  // ---------- G12 commitInfo/commitFileDiff with explicit parent; merge + root commits ----------
  {
    const d = seeded("info");
    const root = sh(d, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    const ri = await git.commitInfo(d, root);
    check("G12 root commit lists its files", ri.isRoot && ri.files.length === 3 && ri.files.every((f) => f.code === "A"), JSON.stringify(ri.files));
    sh(d, ["checkout", "-q", "-b", "m1"]); w(d, "m1.txt", "1\n"); commitAll(d, "m1");
    sh(d, ["checkout", "-q", "main"]); w(d, "m2.txt", "2\n"); commitAll(d, "m2");
    sh(d, ["merge", "-q", "--no-ff", "-m", "merge m1", "m1"]);
    const mi = await git.commitInfo(d, "HEAD");
    check("G12 merge commit vs first parent lists m1.txt", mi.isMerge && mi.parents.length === 2 && mi.files.length === 1 && mi.files[0].path === "m1.txt", JSON.stringify(mi.files));
    const mi2 = await git.commitInfo(d, "HEAD", { parent: 2 });
    check("G12 merge commit vs second parent lists m2.txt", mi2.files.length === 1 && mi2.files[0].path === "m2.txt" && mi2.parentIndex === 2);
    const fd = await git.commitFileDiff(d, "HEAD", "m1.txt");
    check("G12 merge file diff non-empty", /\+1/.test(fd.text));
    await throws("G12 bad parent index", () => git.commitInfo(d, "HEAD", { parent: 3 }), /Parent 3/);
    const fdr = await git.commitFileDiff(d, root, "a.txt");
    check("G12 root file diff vs empty tree", /\+a/.test(fdr.text));
    // rename in a commit: pairs, numstat attached
    sh(d, ["mv", "a.txt", "renamed.txt"]); sh(d, ["commit", "-q", "-m", "rename"]);
    const rn = await git.commitInfo(d, "HEAD");
    check("G12 rename pair", rn.files.length === 1 && rn.files[0].code === "R" && rn.files[0].orig === "a.txt" && rn.files[0].path === "renamed.txt");
    // paged commitsBetween
    for (let i = 0; i < 12; i++) { w(d, "p.txt", String(i)); commitAll(d, "p" + i); }
    const pg = await git.commitsBetween(d, "m1", "main", { limit: 5 });
    check("G12 commitsBetween pages", pg.commits.length === 5 && pg.hasMore === true && pg.complete === false);
    const pg2 = await git.commitsBetween(d, "m1", "main", { limit: 5, skip: 10 });
    check("G12 commitsBetween skip", pg2.commits.length >= 1 && pg2.skip === 10);
    // log with -z-safe fields (subject with newlines impossible, but %x1e records)
    const lg = await git.log(d, { limit: 3 });
    check("G12 log returns 3 + hasMore", lg.commits.length === 3 && lg.hasMore && lg.commits[0].parents.length === 1);
  }

  // ---------- G13 fileAt typed ----------
  {
    const d = seeded("fileat");
    const bin = Buffer.alloc(5000); for (let i = 0; i < bin.length; i++) bin[i] = i % 256;
    fs.writeFileSync(path.join(d, "blob.bin"), bin);
    const big = "é".repeat(200000) + "\nEND\n";   // 2 bytes each → ~400 KB
    w(d, "big.txt", big); commitAll(d, "binary+big");
    const b = await git.fileAt(d, "HEAD", "blob.bin", { base64: true });
    check("G13 binary typed", b.binary === true && b.size === 5000 && Buffer.from(b.base64, "base64").equals(bin));
    const t = await git.fileAt(d, "HEAD", "big.txt", { limit: 100001 });
    check("G13 text chunk does not split UTF-8", t.binary === false && t.truncated === true && !t.content.includes("�") && t.nextOffset > 0 && t.size === Buffer.byteLength(big));
    const t2 = await git.fileAt(d, "HEAD", "big.txt", { offset: t.nextOffset, limit: 10_000_000 });
    check("G13 continuation completes the file", t.content + t2.content === big && t2.nextOffset === null);
    await throws("G13 missing file typed error", () => git.fileAt(d, "HEAD", "nope.txt"), /not in|notFound/);
  }

  // ---------- G14 remotes config-aware; checkoutRemote choice ----------
  {
    const d = seeded("remotes");
    const spaced = path.join(ROOT, `dir with space-${++n}`); fs.mkdirSync(spaced);
    const rem = path.join(spaced, "r.git"); sh(ROOT, ["init", "-q", "--bare", rem]);   // URL containing spaces
    sh(d, ["remote", "add", "spaced", rem]);
    sh(d, ["remote", "set-url", "--add", "--push", "spaced", rem + " push"]);
    const rs = await git.remotes(d);
    const r = rs.remotes.find((x) => x.name === "spaced");
    check("G14 remote URLs with spaces parsed exactly", r && r.fetch === rem && r.push === rem + " push", JSON.stringify(r));
    sh(d, ["remote", "rename", "spaced", "origin"]); sh(d, ["config", "--unset", "remote.origin.pushurl"]);
    sh(d, ["push", "-q", "origin", "main:feature"]); sh(d, ["fetch", "-q", "origin"]);
    // local 'feature' that does NOT track origin/feature and differs
    sh(d, ["branch", "feature", "HEAD~0"]); w(d, "x.txt", "x\n"); commitAll(d, "ahead"); sh(d, ["branch", "-f", "feature", "HEAD"]);
    const ch = await git.checkoutRemote(d, "origin/feature");
    check("G14 checkoutRemote reports a choice, checks out nothing", ch.needsChoice === true && ch.state === "choice" && (await git.currentBranch(d)) === "main", JSON.stringify(ch).slice(0, 200));
    const nw = await git.checkoutRemote(d, "origin/feature", { mode: "new", name: "feature-remote" });
    check("G14 checkoutRemote new tracking branch", nw.ok && nw.created && sh(d, ["config", "--get", "branch.feature-remote.merge"]).trim() === "refs/heads/feature");
    await throws("G14 pullFrom remote without branch refused", () => git.pullFrom(d, { remote: "origin" }), /ambiguous|Pick the remote branch/);
  }

  // ---------- G15 unborn: unstageAll keeps files; commitPlan root ----------
  {
    const d = fresh("unborn");
    w(d, "a.txt", "a\n"); w(d, "b.txt", "b\n"); sh(d, ["add", "-A"]);
    const u = await git.unstageAll(d);
    check("G15 unstageAll on unborn keeps files", u.ok && fs.existsSync(path.join(d, "a.txt")) && (await git.status(d)).files.every((f) => f.untracked));
    const r = await git.commitPlan(d, { message: "root", paths: ["a.txt"] });
    check("G15 root commit via plan has only a.txt", r.ok && sh(d, ["ls-tree", "--name-only", "HEAD"]).trim() === "a.txt");
  }

  // ---------- G16 commitZip: manifest, no collision, no silent skip, UTF-8 names ----------
  {
    const d = seeded("zip");
    w(d, "COMMIT.txt", "user file\n"); w(d, "ünï/ファイル.txt", "u\n"); sh(d, ["rm", "-q", "b.txt"]); commitAll(d, "zip me");
    const out = path.join(ROOT, `commit-${++n}.zip`);
    const z = await git.commitZip(d, "HEAD", out);
    const { unzip } = require("../src/main/zipper");
    const entries = unzip(fs.readFileSync(out));
    const names = entries.map((e) => e.name).sort();
    check("G16 zip ok + files under files/", z.ok && names.includes("files/COMMIT.txt") && names.includes("COMMIT.txt") && names.includes("manifest.json") && names.includes("files/ünï/ファイル.txt"), names.join(","));
    check("G16 user COMMIT.txt preserved", entries.find((e) => e.name === "files/COMMIT.txt").data.toString() === "user file\n");
    const man = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString());
    check("G16 manifest lists deletion as skipped", man.skipped.some((s) => s.path === "b.txt") && man.complete === true);
    // UTF-8 flag set in headers
    const buf = fs.readFileSync(out);
    check("G16 zip UTF-8 flag", (buf.readUInt16LE(6) & 0x800) !== 0);
    check("G16 no .part left", !fs.existsSync(out + ".part-" + process.pid));
    const arch = await git.archiveZip(d, "HEAD", path.join(ROOT, `arch-${++n}.zip`));
    check("G16 archiveZip ok", arch.ok && arch.size > 0);
  }

  // ---------- G17 cherry-pick/revert of merge commits need mainline; results ----------
  {
    const d = seeded("cp");
    sh(d, ["checkout", "-q", "-b", "f"]); w(d, "f.txt", "f\n"); commitAll(d, "f");
    sh(d, ["checkout", "-q", "main"]); sh(d, ["merge", "-q", "--no-ff", "-m", "M", "f"]);
    const M = sh(d, ["rev-parse", "HEAD"]).trim();
    sh(d, ["checkout", "-q", "-b", "target", "HEAD~1"]);
    const cp = await git.cherryPick(d, [M]);
    check("G17 cherry-pick merge commit uses mainline 1", cp.ok && cp.mainline === 1 && fs.existsSync(path.join(d, "f.txt")), JSON.stringify(cp).slice(0, 200));
    const rv = await git.revert(d, "HEAD");
    check("G17 revert ok", rv.ok && !fs.existsSync(path.join(d, "f.txt")));
    await throws("G17 cherry-pick option-like refused", () => git.cherryPick(d, ["--no-commit"]), /not a valid revision|invalid/);
  }

  // ---------- G18 runner: complete diagnostics, cancel, operation ids, per-repo queue ----------
  {
    const d = seeded("runner");
    const e = await throws("G18 error is GitError with type", () => git.checkout(d, "does-not-exist"), /./);
    check("G18 GitError has type+details", e && e.type && "details" in e);
    const events = [];
    git.setProgressSink((ev) => events.push(ev));
    const res = await git.runInOperation({ label: "test-op", cwd: d }, () => git.status(d));
    check("G18 operation events", res.repo && events.some((ev) => ev.kind === "start" && ev.label === "test-op") && events.some((ev) => ev.kind === "end" && ev.ok));
    git.setProgressSink(null);
    // concurrency: two mutations on the same repo are serialized; independent repos aren't blocked
    const d2 = seeded("runner2");
    const order = [];
    await Promise.all([
      git.withLock(d, async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 120)); order.push("a-end"); }),
      git.withLock(d, async () => { order.push("b-start"); order.push("b-end"); }),
      git.withLock(d2, async () => { order.push("c-start"); order.push("c-end"); }),
    ]);
    // Serialized = a and b never overlap. (Which of them acquires the lock first depends on how fast each
    // resolves the repository identity — under CPU load b can legitimately go first.)
    const i = (k) => order.indexOf(k);
    check("G18 same repo serialized", i("a-end") < i("b-start") || i("b-end") < i("a-start"), order.join(" "));
    check("G18 other repo not blocked", order.indexOf("c-start") < order.indexOf("a-end"), order.join(" "));
    // env scrubbing
    process.env.GIT_DIR = path.join(d2, ".git");
    const stEnv = await git.status(d);
    delete process.env.GIT_DIR;
    check("G18 inherited GIT_DIR ignored", stEnv.root.toLowerCase() === d.replace(/\\/g, "/").toLowerCase(), stEnv.root);
    // probe: non-repo folder vs missing folder
    const plain = path.join(ROOT, `plain-${++n}`); fs.mkdirSync(plain);
    const p1 = await git.probe(plain), p2 = await git.probe(path.join(ROOT, "missing-folder"));
    check("G18 probe non-repo", p1.repo === false && !p1.error);
    check("G18 probe missing folder is an error", p2.repo === false && !!p2.error, JSON.stringify(p2));
    // stdin-heavy call whose child exits early does not crash the process
    await throws("G18 EPIPE-safe stdin", () => git.stage(path.join(ROOT, "missing-folder"), ["a"]), /./);
  }

  // ---------- G19 branches(): locals/remotes AND legacy local/remote names ----------
  {
    const d = seeded("br");
    const b = await git.branches(d);
    check("G19 branches has both key styles", Array.isArray(b.locals) && Array.isArray(b.local) && Array.isArray(b.remotes) && b.current === "main");
    const bd = await git.branchesDetailed(d);
    check("G19 branchesDetailed", bd.locals.length === 1 && bd.locals[0].current && bd.headOid);
  }

  // ---------- G20 pull / push report what moved (files · +/- lines · commits) for the result toasts ----------
  {
    const d = seeded("summary");
    const rem = bare("summary-remote"); sh(d, ["remote", "add", "origin", rem]); sh(d, ["push", "-q", "-u", "origin", "main"]);
    const other = path.join(ROOT, `clone-${++n}`); sh(ROOT, ["clone", "-q", rem, other]);
    w(other, "a.txt", "a\nmore\n"); w(other, "new.txt", "n\n"); sh(other, ["add", "-A"]); sh(other, ["-c", "user.name=o", "-c", "user.email=o@x.invalid", "commit", "-q", "-m", "remote work"]); sh(other, ["push", "-q", "origin", "main"]);
    const p1 = await git.pull(d);
    check("G20 pull reports files / lines / commits", p1.ok && p1.summary && p1.summary.files === 2 && p1.summary.insertions === 2 && p1.summary.deletions === 0 && p1.summary.commits === 1 && p1.before && p1.after && p1.before !== p1.after, JSON.stringify({ summary: p1.summary, before: p1.before, after: p1.after }));
    const p2 = await git.pullFrom(d, { remote: "origin", branch: "main" });
    check("G20 up-to-date pull reports zero changes", p2.ok && p2.upToDate && p2.summary && p2.summary.files === 0 && p2.summary.commits === 0, JSON.stringify(p2.summary));
    w(d, "b.txt", "b\nb2\n"); commitAll(d, "local");
    const ps = await git.pushBranch(d, { branch: "main", remote: "origin", dest: "main" });
    check("G20 push reports the pushed range", ps.ok && ps.summary && ps.summary.commits === 1 && ps.summary.files === 1 && ps.summary.insertions === 1 && ps.newRef === false, JSON.stringify({ summary: ps.summary, newRef: ps.newRef, output: ps.output }));
    sh(d, ["checkout", "-q", "-b", "topic"]);
    const pn = await git.pushBranch(d, { branch: "topic", remote: "origin", dest: "topic", setUpstream: true });
    check("G20 new-branch push is flagged and has no range summary", pn.ok && pn.newRef === true && pn.summary === null, JSON.stringify({ newRef: pn.newRef, summary: pn.summary, output: pn.output }));
    const ps2 = await git.pushBranch(d, { branch: "topic", remote: "origin", dest: "topic" });
    check("G20 up-to-date push has no range summary", ps2.ok && ps2.upToDate && ps2.summary === null, JSON.stringify({ upToDate: ps2.upToDate, summary: ps2.summary }));
    const cs = await git.changeSummary(d, "nonexistent-ref", "HEAD");
    check("G20 an unresolvable range yields no summary, never an error", cs === null);
  }

  clearTimeout(watchdog);
  console.log(`\n${pass} passed, ${failN} failed`);
  if (failures.length) { console.log("Failures:\n  " + failures.join("\n  ")); }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
