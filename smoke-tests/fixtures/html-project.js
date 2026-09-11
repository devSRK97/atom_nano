/* Reusable git fixture: a small but real HTML project with a branch topology
 * designed to exercise diffs, branch switching, clean merges, conflicting merges,
 * and (optionally) push/pull against a local bare remote.
 *
 * SINGLE SOURCE OF TRUTH: the same builder generates the playground project under
 * E:\Mac\sample-html-project AND the deterministic temp repos future smoke tests
 * spin up — so the playground can drift freely without affecting tests.
 *
 * Topology (all from the initial commit C0):
 *   main ─ C0 ─ C1 (sharpen hero) ─ C2 (footer note)
 *           ├─ feature/dark-mode   (adds a theme toggle: styles.css + app.js + nav)
 *           └─ feature/headline    (rewrites the hero <h1> — CONFLICTS with main's C1)
 *
 *   • merge feature/dark-mode → main : clean 3-way merge (different files/lines)
 *   • merge feature/headline  → main : conflict on the hero line
 *
 * Usage (as a module):
 *   const { buildHtmlFixture } = require("./fixtures/html-project");
 *   const fx = buildHtmlFixture(path.join(os.tmpdir(), "atomnano-html"), { remote: true });
 *
 * Usage (CLI — (re)create the playground):
 *   node smoke-tests/fixtures/html-project.js "E:\\Mac\\sample-html-project"
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HERO_BASE = `      <h1 class="hero-title">Build something people love.</h1>`;
const HERO_HEADLINE = `      <h1 class="hero-title">Launch in record time.</h1>`;
const HERO_MAIN = `      <h1 class="hero-title">Build faster than your competition.</h1>`;
const NAV_ANCHOR = `        <a class="nav-link" href="about.html">About</a>`;
const DARK_TOGGLE = `\n        <button id="themeToggle" class="nav-toggle" type="button" aria-label="Toggle dark mode">🌙</button>`;
const FOOTER_ANCHOR = `      <p class="footer-copy">&copy; 2026 Sample Co.</p>`;
const FOOTER_EXTRA = `\n      <p class="footer-note">Built with the AtomNano sample fixture.</p>`;

const BASE_INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sample Co. — Home</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="site-header">
    <nav class="nav">
      <a class="nav-brand" href="index.html">Sample&nbsp;Co.</a>
${NAV_ANCHOR}
    </nav>
  </header>

  <main>
    <section class="hero">
${HERO_BASE}
      <p class="hero-sub">A tiny landing page used to demo Git in AtomNano.</p>
      <a class="btn" href="about.html">Learn more</a>
    </section>

    <section class="features">
      <article class="feature"><h3>Fast</h3><p>Minimal footprint, instant load.</p></article>
      <article class="feature"><h3>Simple</h3><p>No framework, just the basics.</p></article>
      <article class="feature"><h3>Open</h3><p>Readable, hackable source.</p></article>
    </section>
  </main>

  <footer class="site-footer">
${FOOTER_ANCHOR}
  </footer>
  <script src="app.js"></script>
</body>
</html>
`;

const ABOUT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sample Co. — About</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="site-header">
    <nav class="nav">
      <a class="nav-brand" href="index.html">Sample&nbsp;Co.</a>
      <a class="nav-link" href="about.html">About</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1 class="hero-title">About us</h1>
      <p class="hero-sub">We make small, sharp tools.</p>
    </section>
  </main>
  <footer class="site-footer">
    <p class="footer-copy">&copy; 2026 Sample Co.</p>
  </footer>
  <script src="app.js"></script>
</body>
</html>
`;

const BASE_CSS = `:root {
  --bg: #0f1115;
  --fg: #e7e9ee;
  --muted: #9aa3b2;
  --accent: #f0a94e;
  --card: #171a21;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--fg); }
.nav { display: flex; gap: 18px; align-items: center; padding: 16px 24px; border-bottom: 1px solid #222; }
.nav-brand { font-weight: 700; color: var(--fg); text-decoration: none; }
.nav-link { color: var(--muted); text-decoration: none; }
.nav-link:hover { color: var(--fg); }
.hero { padding: 80px 24px; text-align: center; }
.hero-title { font-size: 40px; margin: 0 0 12px; }
.hero-sub { color: var(--muted); margin: 0 0 24px; }
.btn { display: inline-block; padding: 10px 18px; border-radius: 8px; background: var(--accent); color: #1a1208; font-weight: 600; text-decoration: none; }
.features { display: flex; gap: 16px; justify-content: center; padding: 0 24px 80px; flex-wrap: wrap; }
.feature { background: var(--card); border: 1px solid #222; border-radius: 12px; padding: 20px; width: 220px; }
.feature h3 { margin: 0 0 6px; }
.feature p { margin: 0; color: var(--muted); }
.site-footer { padding: 24px; text-align: center; color: var(--muted); border-top: 1px solid #222; }
`;

const DARK_CSS = `
/* dark-mode theme (feature/dark-mode) */
body[data-theme="dark"] { --bg: #07080b; --card: #0e1015; --fg: #f3f5f9; }
.nav-toggle { margin-left: auto; background: none; border: 1px solid #333; border-radius: 8px; color: var(--fg); padding: 4px 8px; cursor: pointer; }
`;

const BASE_JS = `// Sample Co. — tiny interactions
document.addEventListener("DOMContentLoaded", () => {
  const year = new Date().getFullYear();
  document.querySelectorAll(".footer-copy").forEach((el) => {
    el.textContent = el.textContent.replace("2026", String(year));
  });
});
`;

const DARK_JS = `
// dark-mode toggle (feature/dark-mode)
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const on = document.body.getAttribute("data-theme") === "dark";
    document.body.setAttribute("data-theme", on ? "light" : "dark");
  });
});
`;

const README = `# Sample HTML Project

A small static site used as a Git playground / smoke-test fixture for **AtomNano**.

## Branches

| Branch | What it does | Merge into \`main\` |
|---|---|---|
| \`main\` | Baseline site (hero sharpened, footer note) | — |
| \`feature/dark-mode\` | Adds a theme toggle (styles.css + app.js + nav) | **clean** 3-way merge |
| \`feature/headline\` | Rewrites the hero \`<h1>\` | **conflicts** with main on the hero line |

## Try it in AtomNano

1. Open this folder.
2. Use the **Branches & merge** button in the Changes view.
3. Merge \`feature/dark-mode\` → clean merge commit.
4. Merge \`feature/headline\` → resolve the hero-line conflict (or abort).
5. Click any changed file to view its **diff** (split / unified).

Rebuild from scratch any time:

\`\`\`
node AtomNano/smoke-tests/fixtures/html-project.js "E:\\Mac\\sample-html-project"
\`\`\`
`;

function buildHtmlFixture(dir, opts = {}) {
  const { remote = false, dirty = false } = opts;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const g = (args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const write = (rel, content) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), "utf8");
  const edit = (rel, fn) => { const before = read(rel); const after = fn(before); if (after === before) throw new Error(`fixture edit was a no-op for ${rel} (anchor missing?)`); write(rel, after); };
  const commit = (msg) => { g(["add", "-A"]); g(["commit", "-m", msg]); };

  g(["init", "-b", "main"]);
  g(["config", "user.email", "dev@example.com"]);
  g(["config", "user.name", "Sample Dev"]);

  // ---- C0: initial commit ----
  write("index.html", BASE_INDEX);
  write("about.html", ABOUT);
  write("styles.css", BASE_CSS);
  write("app.js", BASE_JS);
  write("README.md", README);
  write(".gitignore", "node_modules/\ndist/\n.DS_Store\n");
  commit("Initial commit: landing page + about");

  // ---- feature/dark-mode (from C0) ----
  g(["checkout", "-b", "feature/dark-mode"]);
  edit("styles.css", (c) => c + DARK_CSS);
  edit("app.js", (c) => c + DARK_JS);
  edit("index.html", (c) => c.replace(NAV_ANCHOR, NAV_ANCHOR + DARK_TOGGLE));
  commit("Add a dark-mode theme toggle");
  g(["checkout", "main"]);

  // ---- feature/headline (from C0) — will conflict with main's hero change ----
  g(["checkout", "-b", "feature/headline"]);
  edit("index.html", (c) => c.replace(HERO_BASE, HERO_HEADLINE));
  commit("Rewrite the hero headline");
  g(["checkout", "main"]);

  // ---- main advances ----
  edit("index.html", (c) => c.replace(HERO_BASE, HERO_MAIN));
  commit("Sharpen the hero headline");
  // Touch only index.html here (not styles.css) so feature/dark-mode's CSS/JS
  // changes merge cleanly — main + dark-mode otherwise both append at EOF.
  edit("index.html", (c) => c.replace(FOOTER_ANCHOR, FOOTER_ANCHOR + FOOTER_EXTRA));
  commit("Add a footer note");

  // ---- optional bare remote (origin) ----
  let remotePath = null;
  if (remote) {
    remotePath = dir.replace(/[\\/]+$/, "") + "-origin.git";
    fs.rmSync(remotePath, { recursive: true, force: true });
    execFileSync("git", ["init", "--bare", "-b", "main", remotePath], { stdio: ["ignore", "pipe", "pipe"] });
    g(["remote", "add", "origin", remotePath]);
    g(["push", "-u", "origin", "main"]);
    g(["push", "origin", "feature/dark-mode", "feature/headline"]);
  }

  // ---- optional working-tree changes (for an immediately-diffable playground).
  // Touch only files NOT involved in either merge so branch switching/merging
  // still works freely. ----
  if (dirty) {
    edit("about.html", (c) => c.replace("We make small, sharp tools.", "We make small, sharp tools. (edited — uncommitted)"));
    write("NOTES.md", "# Scratch notes\n\n- Try merging feature/dark-mode (clean) then feature/headline (conflict).\n");
  }

  return { dir, remote: remotePath, current: "main", branches: ["main", "feature/dark-mode", "feature/headline"] };
}

// Layer the sample project + branch topology onto an EXISTING git repo WITHOUT
// touching its .git, its remote, or its .gitignore — and WITHOUT pushing. Use this
// for a real clone (e.g. a Bitbucket playground) you want to experiment in.
function seedExistingRepo(dir, opts = {}) {
  const { dirty = true } = opts;
  const g = (args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  const write = (rel, content) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), "utf8");
  const edit = (rel, fn) => { const before = read(rel); const after = fn(before); if (after === before) throw new Error(`seed edit was a no-op for ${rel} (anchor missing?)`); write(rel, after); };
  const commit = (msg) => { g(["add", "-A"]); g(["commit", "-m", msg]); };

  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(dir + " is not a git repo — refusing to seed.");
  // only set a committer identity if the repo/global config has none (non-destructive)
  let hasIdentity = true;
  try { hasIdentity = !!g(["config", "user.email"]).trim(); } catch { hasIdentity = false; }
  if (!hasIdentity) { g(["config", "user.email", "dev@example.com"]); g(["config", "user.name", "Sample Dev"]); }

  const base = (g(["rev-parse", "--abbrev-ref", "HEAD"]).trim()) || "main";

  // base content (don't clobber an existing README/.gitignore)
  write("index.html", BASE_INDEX);
  write("about.html", ABOUT);
  write("styles.css", BASE_CSS);
  write("app.js", BASE_JS);
  if (!has("README.md")) write("README.md", README);
  commit("Add sample landing page + about");

  g(["checkout", "-b", "feature/dark-mode"]);
  edit("styles.css", (c) => c + DARK_CSS);
  edit("app.js", (c) => c + DARK_JS);
  edit("index.html", (c) => c.replace(NAV_ANCHOR, NAV_ANCHOR + DARK_TOGGLE));
  commit("Add a dark-mode theme toggle");
  g(["checkout", base]);

  g(["checkout", "-b", "feature/headline"]);
  edit("index.html", (c) => c.replace(HERO_BASE, HERO_HEADLINE));
  commit("Rewrite the hero headline");
  g(["checkout", base]);

  edit("index.html", (c) => c.replace(HERO_BASE, HERO_MAIN));
  commit("Sharpen the hero headline");
  edit("index.html", (c) => c.replace(FOOTER_ANCHOR, FOOTER_ANCHOR + FOOTER_EXTRA));
  commit("Add a footer note");

  if (dirty) {
    edit("about.html", (c) => c.replace("We make small, sharp tools.", "We make small, sharp tools. (edited — uncommitted)"));
    if (!has("NOTES.md")) write("NOTES.md", "# Scratch notes\n\n- Merge feature/dark-mode (clean), then feature/headline (conflict on the hero line).\n");
  }
  return { dir, base, branches: [base, "feature/dark-mode", "feature/headline"], pushed: false };
}

module.exports = { buildHtmlFixture, seedExistingRepo };

if (require.main === module) {
  const args = process.argv.slice(2);
  const existing = args.includes("--existing");
  const target = args.find((a) => !a.startsWith("--")) || path.join("E:", "Mac", "sample-html-project");
  if (existing) {
    const fx = seedExistingRepo(target, { dirty: true });
    console.log("Seeded existing repo:", fx.dir);
    console.log("  base branch:", fx.base);
    console.log("  new branches:", fx.branches.filter((b) => b !== fx.base).join(", "));
    console.log("  NOT pushed — push from the app (or `git push`) to publish.");
  } else {
    const fx = buildHtmlFixture(target, { remote: true, dirty: true });
    console.log("Built HTML fixture at:", fx.dir);
    console.log("  branches:", fx.branches.join(", "));
    console.log("  origin:  ", fx.remote || "(none)");
  }
}
