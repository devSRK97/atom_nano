"use strict";
/* Project skills store (src/main/agents/skills.js) + its IPC / preload surface — the DESIRED behaviour after
 * the 2026-09-18 reduction (the Workflow studio is the only skills UI; the apprentice, hub, marketplace,
 * cross-project, scout, promote / peek and standalone import / export are gone):
 *   · the exact export surface (store: list/get/create/update/remove/digest/markUsed/invoke/importFromUrl;
 *     IPC: skills:list/create/update/remove/import-url; preload: list/create/update/remove/importUrl);
 *   · files written by the earlier module load unchanged — ids, slugs, procedures, legacy statuses, the runs log;
 *   · CRUD records, get by id / slug, remove, update bumps updatedAt;
 *   · invoke() bumps uses / lastUsed and returns the digest WITHOUT touching updatedAt (the session code hashes
 *     id + updatedAt to know when to resend a role's procedures); digest() is PURE (the session code freezes it
 *     per turn, 2026-09-18) and markUsed() is the bookkeeping half alone (uses / lastUsed, never updatedAt);
 *   · importFromUrl: JSON object, JSON array (nameless entries skipped), SKILL.md front matter, GitHub blob →
 *     raw, HTTP error, oversized body, malformed body, failed fetch, timeout signal, invalid URL;
 *   · the 80-skill limit is an ERROR, never an eviction; a batch import that would not fit adds nothing.
 * Real module on an isolated userData; `electron` stubbed; `fetch` faked. Run: node scripts/test-workflow-skills.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-wfskills-"));
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === "electron") return { app: { getPath: (k) => (k === "userData" ? HOME : os.homedir()), getAppPath: () => ROOT, isPackaged: false } }; return origLoad.call(this, req, ...rest); };

let pass = 0, failN = 0; const failures = [];
function check(id, name, ok, evidence) { if (ok) pass++; else { failN++; failures.push(`${id} ${name}`); console.log(`  FAIL ${id} ${name}  ${evidence ? JSON.stringify(evidence).slice(0, 900) : ""}`); } }
const watchdog = setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(3); }, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKILLS_PATH = path.join(ROOT, "src/main/agents/skills.js");
const fresh = () => { delete require.cache[require.resolve(SKILLS_PATH)]; return require(SKILLS_PATH); };
const keyOf = (p) => (p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-120) || "_";
const fileFor = (cwd) => path.join(HOME, "skills", keyOf(cwd) + ".json");

// A scripted fetch: url → { status, body } | Error. Records every call (url + options) for assertions.
const fetchLog = [];
let fetchPlan = {};
globalThis.fetch = async (url, opts) => {
  fetchLog.push({ url, opts });
  const plan = fetchPlan[url];
  if (!plan) return { ok: false, status: 404, text: async () => "not here" };
  if (plan instanceof Error) throw plan;
  return { ok: plan.status === undefined || (plan.status >= 200 && plan.status < 300), status: plan.status || 200, text: async () => plan.body };
};

(async () => {
  /* ---------- 1. the surface ---------- */
  const skills = fresh();
  check("S1", "store exports exactly list/get/create/update/remove/digest/markUsed/invoke/importFromUrl", Object.keys(skills).sort().join() === ["create", "digest", "get", "importFromUrl", "invoke", "list", "markUsed", "remove", "update"].join(), Object.keys(skills));
  check("S2", "every export is a function", Object.values(skills).every((f) => typeof f === "function"));
  const channels = [];
  require(path.join(ROOT, "src/main/ipc/skills.js")).register({ handle: (ch) => channels.push(ch) });
  check("S3", "IPC registers exactly skills:list/create/update/remove/import-url", channels.sort().join() === ["skills:create", "skills:import-url", "skills:list", "skills:remove", "skills:update"].join(), channels);
  const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.js"), "utf8");
  const block = /\n\s*skills:\s*\{([\s\S]*?)\n\s*\},/.exec(preload);
  const preKeys = block ? [...block[1].matchAll(/^\s*(\w+):\s*\(/gm)].map((m) => m[1]).sort() : [];
  check("S4", "preload atom.skills is exactly { list, create, update, remove, importUrl }", preKeys.join() === ["create", "importUrl", "list", "remove", "update"].join(), preKeys);
  check("S5", "preload no longer bridges the removed channels", !/skills:(promote|peek|hub|cross-project|scout|import-skill|export-skill|marketplace|install)"/.test(preload));
  check("S6", "the store module carries no hub / marketplace / scout / apprentice leftovers", !/SKILL_HUB|MARKETPLACE_INDEX|function (scout|crossProject|marketplace|installHub|installMarketplace|exportSkill|importSkill|promote|peek|capSkills|signatureOf|recordRun|mine)\b|MIN_OCCURRENCES|MAX_RUNS/.test(fs.readFileSync(SKILLS_PATH, "utf8")));

  /* ---------- 2. existing data loads unchanged ---------- */
  const LEGACY = path.join(HOME, "proj-legacy");
  const legacy = {
    version: 1, _project: LEGACY,
    runs: [{ sig: "add+endpoint", files: ["a.js"], ts: 1 }, { sig: "rename+css", files: ["b.css"], ts: 2 }],
    skills: {
      aaaa11112222: { id: "aaaa11112222", name: "Add IPC handler", slug: "add-ipc-handler", description: "Wire a channel", steps: "1. handle()\n2. preload\n3. call", params: [], triggers: ["ipc", "handler"], files: [LEGACY.replace(/\\/g, "/") + "/src/main/main.js"], source: "manual", status: "active", uses: 4, lastUsed: 1700000000000, createdAt: 1690000000000, updatedAt: 1695000000000 },
      bbbb33334444: { id: "bbbb33334444", name: "Learned thing", slug: "learned-thing", description: "", steps: "guess", params: [], triggers: ["endpoint"], files: [], source: "learned", status: "suggested", uses: 0, lastUsed: 0, createdAt: 1690000000001, updatedAt: 1690000000001 },
      cccc55556666: { id: "cccc55556666", name: "From the hub", slug: "from-the-hub", description: "imported once", steps: "1. a\n2. b", params: [], triggers: [], files: [], source: "imported", status: "active", uses: 0, lastUsed: 0, createdAt: 1690000000002, updatedAt: 1690000000002 },
    },
  };
  fs.mkdirSync(path.join(HOME, "skills"), { recursive: true });
  fs.writeFileSync(fileFor(LEGACY), JSON.stringify(legacy));
  const l = skills.list(LEGACY);
  check("L1", "a legacy file lists every skill with its id, slug, steps and status", l.length === 3 && l.map((s) => s.id).sort().join() === "aaaa11112222,bbbb33334444,cccc55556666" && l.find((s) => s.id === "aaaa11112222").steps === "1. handle()\n2. preload\n3. call" && l.find((s) => s.id === "bbbb33334444").status === "suggested", l);
  check("L2", "active skills sort before legacy suggestions; more-used first", l[0].id === "aaaa11112222" && l[2].id === "bbbb33334444", l.map((s) => s.id));
  check("L3", "files come back relative to the project", l.find((s) => s.id === "aaaa11112222").files[0] === "src/main/main.js", l[0].files);
  check("L4", "get() by id and by slug returns the same record; a missing id gives null", skills.get(LEGACY, "aaaa11112222") === skills.get(LEGACY, "add-ipc-handler") && skills.get(LEGACY, "aaaa11112222").name === "Add IPC handler" && skills.get(LEGACY, "nope") === null);
  const legacyRec = skills.get(LEGACY, "cccc55556666");
  check("L5", "the record the session code reads has id / name / updatedAt (ms number) and source", legacyRec.id === "cccc55556666" && legacyRec.name === "From the hub" && legacyRec.updatedAt === 1690000000002 && legacyRec.source === "imported");

  /* ---------- 3. CRUD ---------- */
  const P = path.join(HOME, "proj-a");
  const made = skills.create(P, { name: "  Review   checklist ", description: "What the Reviewer checks", steps: "1. tests\n2. types\n3. docs", triggers: ["review"], files: [P + "/docs/REVIEW.md"] });
  check("C1", "create() returns the public record (manual, active, uses 0, slug, ms clocks)", made.id && made.name === "Review checklist" && made.slug === "review-checklist" && made.source === "manual" && made.status === "active" && made.uses === 0 && typeof made.createdAt === "number" && made.createdAt === made.updatedAt && made.steps === "1. tests\n2. types\n3. docs" && made.files[0] === "docs/REVIEW.md", made);
  check("C2", "the record shape is exactly the one the renderer and session code know", Object.keys(made).sort().join() === ["createdAt", "description", "files", "id", "lastUsed", "name", "params", "slug", "source", "status", "steps", "triggers", "updatedAt", "uses"].join(), Object.keys(made));
  const made2 = skills.create(P, { name: "Review checklist", steps: "again" });
  check("C3", "a second skill with the same name gets a unique slug and its own id", made2.id !== made.id && made2.slug === "review-checklist-2", made2);
  check("C4", "create() ignores a 'suggested' status and unknown sources (always active / manual)", skills.create(P, { name: "X", status: "suggested", source: "learned", steps: "s" }).status === "active" && skills.list(P).find((s) => s.name === "X").source === "manual");
  check("C5", "list() shows the created skills", skills.list(P).length === 3 && skills.list(P).some((s) => s.id === made.id));
  await sleep(5);
  const up = skills.update(P, made.id, { description: "  Tighter   text ", steps: "1. tests\n2. types", triggers: ["review", " lint "] });
  check("C6", "update() edits name/description/steps/triggers and bumps updatedAt", up.description === "Tighter text" && up.steps === "1. tests\n2. types" && up.triggers.join() === "review,lint" && up.updatedAt > made.updatedAt && up.id === made.id, up);
  check("C7", "update() of a missing id returns null", skills.update(P, "missing", { name: "x" }) === null);
  const xId = skills.list(P).find((s) => s.name === "X").id;
  check("C8", "remove() returns true once, then false; the list drops the skill", skills.remove(P, xId) === true && skills.remove(P, xId) === false && !skills.list(P).some((s) => s.id === xId));

  /* ---------- 4. invoke: usage only ---------- */
  const before = skills.get(P, made.id).updatedAt;
  await sleep(5);
  const digest = skills.invoke(P, made.id);
  const after = skills.get(P, made.id);
  check("I1", "invoke() returns the digest (name, description, steps, files)", /Skill "Review checklist" — Tighter text\./.test(digest) && /1\. tests\n2\. types/.test(digest) && /Relevant files: docs\/REVIEW\.md/.test(digest), digest);
  check("I2", "invoke() bumps uses and lastUsed but leaves updatedAt alone", after.uses === 1 && after.lastUsed > 0 && after.updatedAt === before, { uses: after.uses, lastUsed: after.lastUsed, before, after: after.updatedAt });
  check("I3", "invoke() by slug works too; a missing skill gives null", skills.invoke(P, "review-checklist") && skills.get(P, made.id).uses === 2 && skills.invoke(P, "nope") === null);
  const big = skills.create(P, { name: "Big", steps: "x".repeat(5000) });
  check("I4", "the digest is capped at its budget", skills.invoke(P, big.id).length <= 1200);
  // digest() is the PURE half (the session code freezes it per turn); markUsed() the bookkeeping half (2026-09-18)
  const snapBefore = { ...skills.get(P, made.id) };
  await sleep(5);
  const pure = skills.digest(P, made.id), pureBySlug = skills.digest(P, "review-checklist");
  const snapAfter = skills.get(P, made.id);
  check("I5", "digest() returns the same procedure text as invoke() (by id and by slug) WITHOUT bumping uses / lastUsed or touching updatedAt; a missing skill gives null", pure === digest && pureBySlug === digest && snapAfter.uses === snapBefore.uses && snapAfter.lastUsed === snapBefore.lastUsed && snapAfter.updatedAt === snapBefore.updatedAt && skills.digest(P, "nope") === null, { pure: pure && pure.slice(0, 60), uses: [snapBefore.uses, snapAfter.uses], lastUsed: [snapBefore.lastUsed, snapAfter.lastUsed] });
  const m2Before = { ...skills.get(P, made2.id) };
  await sleep(5);
  const marked = skills.markUsed(P, made2.id), markedSlug = skills.markUsed(P, "review-checklist-2");
  const m2After = skills.get(P, made2.id);
  check("I6", "markUsed() returns true and bumps uses / lastUsed (by id and by slug) without touching updatedAt or the procedure; a missing skill gives false", marked === true && markedSlug === true && m2After.uses === m2Before.uses + 2 && m2After.lastUsed > m2Before.lastUsed && m2After.updatedAt === m2Before.updatedAt && m2After.steps === m2Before.steps && skills.markUsed(P, "nope") === false, { uses: [m2Before.uses, m2After.uses], updatedAt: [m2Before.updatedAt, m2After.updatedAt] });

  /* ---------- 5. importFromUrl ---------- */
  const Q = path.join(HOME, "proj-import");
  fetchPlan = {
    "https://example.test/one.json": { body: JSON.stringify({ name: "One skill", description: "d1", steps: "1. a\n2. b", tags: ["alpha"] }) },
    "https://example.test/many.json": { body: JSON.stringify([{ name: "Many A", steps: "a" }, { description: "no name here" }, null, { name: "Many B", steps: "b", triggers: ["t"] }]) },
    "https://example.test/nameless.json": { body: JSON.stringify([{ steps: "x" }, { title: "wrong key" }]) },
    "https://raw.githubusercontent.com/o/r/main/SKILL.md": { body: '---\nname: "Design tokens"\ndescription: Use the tokens\n---\n\n1. read tokens.css\n2. never hardcode colours\n' },
    "https://example.test/bad.md": { body: "# just markdown\nno front matter" },
    "https://example.test/huge.json": { body: JSON.stringify({ name: "Huge", steps: "y".repeat(500001) }) },
    "https://example.test/500.json": { status: 500, body: "boom" },
    "https://example.test/down.json": new Error("ECONNREFUSED"),
  };
  const one = await skills.importFromUrl(Q, "https://example.test/one.json");
  check("U1", "a JSON object imports one skill (source imported, steps + tags→triggers kept)", one.length === 1 && one[0].source === "imported" && one[0].name === "One skill" && one[0].steps === "1. a\n2. b" && one[0].triggers.join() === "alpha" && one[0].status === "active", one);
  const many = await skills.importFromUrl(Q, "https://example.test/many.json");
  check("U2", "a JSON array imports every named entry and skips the nameless ones", many.length === 2 && many.map((s) => s.name).join() === "Many A,Many B" && many[1].triggers.join() === "t", many);
  const md = await skills.importFromUrl(Q, "https://github.com/o/r/blob/main/SKILL.md");
  check("U3", "a GitHub blob link is fetched raw and SKILL.md front matter becomes name / description, the body the steps", fetchLog.at(-1).url === "https://raw.githubusercontent.com/o/r/main/SKILL.md" && md.length === 1 && md[0].name === "Design tokens" && md[0].description === "Use the tokens" && md[0].steps === "1. read tokens.css\n2. never hardcode colours", md);
  check("U4", "every fetch carries a timeout signal", fetchLog.every((c) => c.opts && c.opts.signal instanceof AbortSignal), fetchLog.map((c) => !!(c.opts && c.opts.signal)));
  const countQ = () => skills.list(Q).length;
  const n0 = countQ();
  const rejects = async (url, re) => { try { await skills.importFromUrl(Q, url); return "resolved"; } catch (e) { return re.test(e.message) ? true : e.message; } };
  check("U5", "an HTTP error rejects with its status", (await rejects("https://example.test/500.json", /HTTP 500/)) === true);
  check("U6", "a 404 rejects", (await rejects("https://example.test/none.json", /HTTP 404/)) === true);
  check("U7", "an oversized body is refused", (await rejects("https://example.test/huge.json", /too large/i)) === true);
  check("U8", "a body that is neither JSON nor a SKILL.md is refused", (await rejects("https://example.test/bad.md", /Invalid skill format/)) === true);
  check("U9", "an array without a single named entry is refused", (await rejects("https://example.test/nameless.json", /No skills found/)) === true);
  check("U10", "a failed fetch rejects", (await rejects("https://example.test/down.json", /ECONNREFUSED/)) === true);
  check("U11", "a blank / non-string URL is refused before any fetch", (await rejects("   ", /Invalid URL/)) === true && (await (async () => { try { await skills.importFromUrl(Q, 42); return false; } catch (e) { return /Invalid URL/.test(e.message); } })()));
  check("U12", "none of the failures added a skill", countQ() === n0, { n0, now: countQ() });

  /* ---------- 6. capacity: an error, never an eviction ---------- */
  const R = path.join(HOME, "proj-full");
  const ids = [];
  for (let i = 0; i < 80; i++) ids.push(skills.create(R, { name: "Skill " + i, steps: "s" + i }).id);
  check("K1", "80 skills fit", skills.list(R).length === 80);
  let capErr = null; try { skills.create(R, { name: "one too many", steps: "x" }); } catch (e) { capErr = e; }
  check("K2", "the 81st create() throws a clear capacity error", capErr && /80/.test(capErr.message) && /limit/i.test(capErr.message), capErr && capErr.message);
  check("K3", "nothing was evicted — all 80 ids are still there", skills.list(R).length === 80 && ids.every((id) => !!skills.get(R, id)));
  skills.remove(R, ids[0]); skills.remove(R, ids[1]);   // 78 left
  fetchPlan["https://example.test/three.json"] = { body: JSON.stringify([{ name: "B1", steps: "1" }, { name: "B2", steps: "2" }, { name: "B3", steps: "3" }]) };
  const batchErr = await (async () => { try { await skills.importFromUrl(R, "https://example.test/three.json"); return null; } catch (e) { return e; } })();
  check("K4", "a batch that would cross the limit is refused up front and adds NOTHING", batchErr && /3 skills/.test(batchErr.message) && /78 installed/.test(batchErr.message) && skills.list(R).length === 78, batchErr && batchErr.message);
  fetchPlan["https://example.test/two.json"] = { body: JSON.stringify([{ name: "B1", steps: "1" }, { name: "B2", steps: "2" }]) };
  const two = await skills.importFromUrl(R, "https://example.test/two.json");
  check("K5", "a batch that exactly fills the project imports", two.length === 2 && skills.list(R).length === 80);

  /* ---------- 7. persistence (debounced write) + reload from disk ---------- */
  await sleep(900);
  const onDisk = JSON.parse(fs.readFileSync(fileFor(P), "utf8"));
  check("D1", "the project file holds the skills with their ids and procedures", onDisk.skills && onDisk.skills[made.id] && onDisk.skills[made.id].steps === "1. tests\n2. types" && onDisk.skills[made.id].uses === 2, Object.keys(onDisk.skills || {}));
  skills.invoke(LEGACY, "aaaa11112222"); skills.update(LEGACY, "cccc55556666", { description: "edited" });
  await sleep(900);
  const legacyDisk = JSON.parse(fs.readFileSync(fileFor(LEGACY), "utf8"));
  check("D2", "a legacy file keeps its ids, its suggested record and its runs log after a save", Object.keys(legacyDisk.skills).sort().join() === "aaaa11112222,bbbb33334444,cccc55556666" && legacyDisk.skills.bbbb33334444.status === "suggested" && Array.isArray(legacyDisk.runs) && legacyDisk.runs.length === 2 && legacyDisk.skills.aaaa11112222.uses === 5 && legacyDisk.skills.aaaa11112222.updatedAt === 1695000000000, { keys: Object.keys(legacyDisk.skills), runs: legacyDisk.runs && legacyDisk.runs.length });
  const again = fresh();
  check("D3", "a fresh module instance reads the same records back", again.list(P).length === 3 && again.get(P, made.id).steps === "1. tests\n2. types" && again.get(P, made.id).uses === 2 && again.list(LEGACY).length === 3);

  clearTimeout(watchdog);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(`\nworkflow-skills: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
