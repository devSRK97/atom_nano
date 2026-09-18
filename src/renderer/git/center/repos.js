/* AtomNano renderer — Git Center — data loading: repository discovery, status snapshots (ready | error | stale), branch info, refresh, the pending-push continuation.
 * One of the modules the former single gitcenter.js was split into (see git/center/index.js). */
import { doPush } from "./ops.js";
import { renderBanner, renderBar, renderCmpBar, renderMain, renderRepoDD, renderStateBar, renderTabs } from "./render.js";
import { renderOpLog } from "./shell.js";
import { alive, conflicts, D, empty, errText, isOpen, per, q, repoName, S, spinner, stat, statusOk } from "./state.js";
import { confirmPop } from "./widgets.js";

/* ============================ data loading ============================ */
export async function loadRepos() {
  const root = D.projectRoot();
  let repos = [];
  S.discoveryError = "";
  try { repos = root ? await D.atom.git.repos(root) : []; } catch (e) { repos = []; S.discoveryError = errText(e); }
  if (!isOpen()) return;
  S.repos = repos;
  try { if (D.atom.git.watch) D.atom.git.watch(repos).catch(() => {}); } catch { /* optional */ }
  await loadStatuses();
}
/* Status snapshot per repo. A FAILED read keeps the previous snapshot and marks it
 * stale/error — it is never presented as a clean tree. */
export async function loadStatus(repo) {
  const prev = S.statuses[repo];
  try {
    const s = await D.atom.git.status(repo);
    return s && s.repo === false ? { repo: false, state: "notRepo", files: [], branch: "", error: "Not a Git repository (anymore)." } : { ...s, state: "ready", error: "" };
  } catch (e) {
    // `stale` = an older SUCCESSFUL snapshot is being shown (it survives repeated failures)
    return { ...(prev && prev.repo ? prev : { repo: true, branch: "", files: [] }), state: "error", stale: !!(prev && (prev.state === "ready" || prev.stale)), error: errText(e), type: e && e.type, files: (prev && prev.files) || [], clean: false };
  }
}
export async function loadStatuses() {
  const gen = S.gen;
  const st = {};
  await Promise.all(S.repos.map(async (r) => { st[r] = await loadStatus(r); }));
  if (!isOpen() || gen !== S.gen) { Object.assign(S.statuses, st); return; }   // still record — data is repo-keyed, not view-keyed
  S.statuses = { ...S.statuses, ...st };
  renderRepoDD(); renderStateBar();
}
export function pickRefs(repo) {
  const P = per(repo), info = S.infos[repo]; if (!info) return;
  const names = new Set([...info.locals.map((b) => b.name), ...info.remotes.map((b) => b.name)]);
  if (!names.has(P.source)) P.source = info.current && info.current !== "HEAD" ? info.current : (info.locals[0] ? info.locals[0].name : "");
  if (!names.has(P.target) || P.target === P.source) P.target = defaultTargetFor(repo);
}
export async function selectRepo(repo) {
  const gen = ++S.gen;
  const prev = S.repo;
  S.repo = repo;
  if (prev !== repo) { const P = per(repo); P.cmp = { ...P.cmp, compared: false, ready: false, ids: null, sel: null }; P.chg.diffKey = P.chg.diffKey || null; }
  renderRepoDD(); renderBar(); renderBanner(); renderStateBar(); renderOpLog();
  const c = q(".gitc-content"); if (c) { c.innerHTML = ""; c.append(spinner("Reading branches…")); }
  let info = null, err = null;
  try { info = await D.atom.git.branchesDetailed(repo); } catch (e) { err = e; }
  if (!alive(gen) || S.repo !== repo) { if (info) S.infos[repo] = info; return; }   // stale response: record for its own repo only, never render
  if (err) { c.innerHTML = ""; c.append(empty("alert", "Couldn't read this repository", errText(err))); return; }
  S.infos[repo] = info;
  pickRefs(repo);
  renderBar(); renderBanner(); renderTabs();
  await renderMain();                                        // (bumps S.gen for its own loads)
  if (isOpen() && S.repo === repo) offerContinuation(repo);
}
export function defaultTargetFor(repo) {
  const info = S.infos[repo], P = per(repo);
  const locals = info ? info.locals.map((b) => b.name) : [];
  for (const p of ["main", "master", "develop"]) if (locals.includes(p) && p !== P.source) return p;
  const all = [...locals, ...(info ? info.remotes.map((b) => b.name) : [])];
  return all.find((b) => b !== P.source) || "";
}
export function defaultTarget() { return defaultTargetFor(S.repo); }
/* Re-read ONE repository (status + branches) and redraw if it is the visible one.
 * The Changes shell is kept mounted, so a draft being typed is never disturbed. */
export async function refreshRepo(repo, { quiet = false, keepTab = true, skipStatus = false } = {}) {
  if (!isOpen() || !repo) return;
  const gen = S.gen;
  const [st, info] = await Promise.all([skipStatus ? Promise.resolve(S.statuses[repo]) : loadStatus(repo), D.atom.git.branchesDetailed(repo).catch(() => null)]);
  if (!isOpen()) return;
  if (st) S.statuses[repo] = st;
  if (info) S.infos[repo] = info;
  if (repo !== S.repo || gen !== S.gen) { renderRepoDD(); return; }
  pickRefs(repo);
  renderRepoDD(); renderBar(); renderBanner(); renderStateBar(); renderTabs(); renderCmpBar();
  if (keepTab) await renderMain({ soft: true });
  if (!quiet) { try { D.refreshGit(); D.refreshTree(true); } catch { /* sidebar sync is best-effort */ } }
  offerContinuation(repo);
}
// Re-read everything and redraw the current repo.
export async function refreshAll({ keepTab = true } = {}) {
  if (!isOpen()) return;
  const gen = S.gen;
  await loadStatuses();
  if (!S.repo || !alive(gen)) return;
  await refreshRepo(S.repo, { keepTab, skipStatus: true });   // statuses were just read for every repo
}
/* A push that was waiting on a pull/merge/rebase in THIS repo: offered only when
 * the same repo is visible, its operation finished, nothing is conflicted and the
 * branch still matches what the continuation was created for. */
export async function offerContinuation(repo) {
  const P = per(repo), c = P.continuation;
  if (!c || c.kind !== "push" || repo !== S.repo || c.offering) return;
  const s = stat(repo), info = S.infos[repo];
  if (!statusOk(repo) || !info || (info.state && info.state.op) || conflicts(repo).length) return;
  if (info.current !== c.branch) { P.continuation = null; return; }   // switched branch meanwhile → the push no longer applies
  c.offering = true;
  const r = await confirmPop(q(".gitc-act.pushbtn") || q(".gitc-bar"), { title: `Push ${c.branch} now?`, ic: "push", message: `The remote changes are merged into “${c.branch}” in ${repoName(repo)}. Push your commits to ${c.remote}/${c.dest} now?`, confirmLabel: "Push" });
  c.offering = false;
  if (P.continuation !== c) return;                          // aborted / replaced meanwhile
  P.continuation = null;
  if (r.ok && S.repo === repo && (stat(repo) || {}).branch === c.branch) doPush({ repo, skipConfirm: true, remote: c.remote, dest: c.dest });
}
