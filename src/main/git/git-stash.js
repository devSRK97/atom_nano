"use strict";
/* Stashes addressed by OBJECT ID. Positions renumber whenever the list changes, so apply / pop /
 * drop / show re-resolve the hash to the CURRENT stash@{n} right before running and verify the
 * entry still holds it; apply takes the stash commit itself so renumbering can never redirect it. */
const { GitError, fail, run, withLock, normPaths, runPaths, conflictOr } = require("./git-runner");
const { parseNameStatusZ, attachNumstatZ } = require("./git-history");

/* ============================== stashes (identity = object id) ============================== */
async function stashList(cwd) {
  const fmt = "%gd%x1f%gs%x1f%ar%x1f%aI%x1f%H";
  const r = await run(cwd, ["stash", "list", `--pretty=format:${fmt}`], 15000);
  if (!r.ok) fail(r, "git stash list failed");
  const stashes = [];
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, msg, rel, date, hash] = line.split("\x1f");
    const idx = +((/\{(\d+)\}/.exec(ref) || [])[1] || stashes.length);
    const bm = /^(?:WIP on|On) ([^:]+): ?(.*)$/.exec(msg || "");
    stashes.push({ index: idx, ref, hash, rel, date, branch: bm ? bm[1] : "", message: bm ? (bm[2] || "(no message)") : (msg || ""), wip: /^WIP on/.test(msg || "") });
  }
  return { stashes };
}
// The CURRENT stash@{n} for an object id — positions renumber whenever stashes change.
async function stashRefFor(cwd, sel) {
  const hash = typeof sel === "object" && sel ? sel.hash : (typeof sel === "string" && /^[0-9a-f]{7,40}$/i.test(sel) ? sel : "");
  const index = typeof sel === "object" && sel ? sel.index : (typeof sel === "number" ? sel : null);
  const { stashes } = await stashList(cwd);
  if (hash) {
    const hit = stashes.find((s) => s.hash === hash || s.hash.startsWith(hash));
    if (!hit) throw new GitError("That stash no longer exists (the stash list changed). Refresh and pick again.", { type: "notFound" });
    return hit;
  }
  if (index == null) throw new GitError("Stash is required.", { type: "invalid" });
  const hit = stashes.find((s) => s.index === +index);
  if (!hit) throw new GitError(`stash@{${index}} does not exist.`, { type: "notFound" });
  return hit;
}
async function stashSave(cwd, { message, includeUntracked, keepIndex, paths } = {}) {
  return withLock(cwd, async () => {
    const args = ["stash", "push"];
    if (includeUntracked) args.push("-u");
    if (keepIndex) args.push("--keep-index");
    if (message && message.trim()) args.push("-m", message.trim());
    const list = paths && paths.length ? normPaths(paths) : null;
    const r = list ? await runPaths(cwd, args, list, { timeout: 60000 }) : await run(cwd, args, 60000);
    if (!r.ok) fail(r, "git stash failed");
    const output = (r.stdout + r.stderr).trim();
    return { ok: true, state: "success", output, nothing: /No local changes to save/i.test(output) };
  });
}
/* Apply / pop by OBJECT ID. `git stash apply` accepts the stash commit itself, so
 * the applied content can never be redirected by renumbering. `drop` (and hence
 * pop's second half) only accepts stash@{n}: it is re-resolved from the hash
 * immediately before running, and the entry is verified to still hold that hash. */
async function dropByHash(cwd, hash) {
  const st = await stashRefFor(cwd, { hash });
  const now = await run(cwd, ["rev-parse", "--verify", "-q", st.ref], 8000);
  if (!now.ok || now.stdout.trim() !== st.hash) throw new GitError("The stash list changed while dropping — nothing was dropped. Refresh and try again.", { type: "invalid" });
  const r = await run(cwd, ["stash", "drop", "-q", st.ref], 30000);
  if (!r.ok) fail(r, "git stash drop failed");
  return st;
}
async function stashApply(cwd, sel, { pop, restoreIndex } = {}) {
  return withLock(cwd, async () => {
    const st = await stashRefFor(cwd, sel);
    const r = await run(cwd, ["stash", "apply", ...(restoreIndex ? ["--index"] : []), st.hash], 60000);
    const res = conflictOr(r, "git stash apply failed");
    let dropped = false;
    if (pop && res.ok) { await dropByHash(cwd, st.hash); dropped = true; }   // like git: a conflicting pop keeps the stash
    return { ...res, hash: st.hash, ref: st.ref, kept: !dropped, dropped };
  });
}
async function stashDrop(cwd, sel) {
  return withLock(cwd, async () => {
    const st = await stashRefFor(cwd, sel);
    await dropByHash(cwd, st.hash);
    return { ok: true, state: "success", hash: st.hash };
  });
}
async function stashShow(cwd, sel) {
  const st = await stashRefFor(cwd, sel);
  const [ns, num] = await Promise.all([
    run(cwd, ["diff", "-z", "--name-status", "-M", `${st.hash}^`, st.hash], 30000),
    run(cwd, ["diff", "-z", "--numstat", "-M", `${st.hash}^`, st.hash], 30000),
  ]);
  if (!ns.ok) fail(ns, "git stash show failed");
  if (!num.ok) fail(num, "git stash show --numstat failed");
  const files = attachNumstatZ(parseNameStatusZ(ns.stdout), num.stdout);
  const u = await run(cwd, ["show", "-z", "--pretty=format:", "--name-only", `${st.hash}^3`], 15000);
  if (u.ok) for (const p of u.stdout.split("\0").map((s) => s.trim()).filter(Boolean)) if (!files.find((f) => f.path === p)) files.push({ path: p, code: "A", label: "Untracked", untracked: true });
  return { files, hash: st.hash, ref: st.ref };
}
async function stashFileDiff(cwd, sel, file) {
  const st = await stashRefFor(cwd, sel);
  const [f] = normPaths([file]);
  const r = await run(cwd, ["--literal-pathspecs", "diff", "--no-color", "-M", `${st.hash}^`, st.hash, "--", f], 30000);
  if (!r.ok) fail(r, "git diff failed");
  if (r.stdout) return { text: r.stdout };
  const u = await run(cwd, ["--literal-pathspecs", "show", "--no-color", "--pretty=format:", `${st.hash}^3`, "--", f], 30000);   // untracked part
  return { text: u.ok ? (u.stdout || "") : "" };
}

module.exports = { stashList, stashSave, stashApply, stashDrop, stashShow, stashFileDiff };
