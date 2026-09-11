"use strict";
/* Shared bootstrap for the Electron smoke suites (audit GIT-040):
 *   · unique fixture roots per run (two suites can run concurrently, nothing is
 *     shared or recursively deleted outside the run's own folder);
 *   · an isolated AtomNano userData + empty Claude/Codex homes, so a smoke run never
 *     reads or writes the developer's settings, sessions or logins;
 *   · an isolated Git identity/configuration for the app AND this test process.
 * Remotes are always local bare repositories — no network, no credentials. */
const fs = require("fs");
const os = require("os");
const path = require("path");

function tmpRoot(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `atomnano-${name}-`)); }

function isolatedEnv(root) {
  const gcfg = path.join(root, "gitconfig");
  fs.writeFileSync(gcfg, "[user]\n\tname = AtomNano Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[credential]\n\thelper =\n");
  const env = {
    ...process.env,
    ATOMNANO_TEST: "1",
    ATOMNANO_USER_DATA: path.join(root, "userData"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude-home"),
    CODEX_HOME: path.join(root, "codex-home"),
    GIT_CONFIG_GLOBAL: gcfg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
  fs.mkdirSync(env.ATOMNANO_USER_DATA, { recursive: true });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  // The test process builds fixtures with the same isolated git configuration.
  process.env.GIT_CONFIG_GLOBAL = gcfg; process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete process.env[k];
  return env;
}

// Remove the run folder only (never a shared path). Best effort: a locked file must not fail the suite.
function cleanup(root) { try { if (root && root.includes("atomnano-")) fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } }

module.exports = { tmpRoot, isolatedEnv, cleanup };
