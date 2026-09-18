"use strict";
/* IPC: this project's skills — skills:* (list / create / update / remove / import-url), backed by
 * src/main/agents/skills.js. The Workflow studio's Skills modal is the only caller (2026-09-18: the
 * hub / marketplace / cross-project / scout / promote / peek / export channels went with the panels
 * that used them). `get` and `invoke` stay main-process functions for the session code. */

function register(ctx) {
  const { handle } = ctx;
  const skills = require("../agents/skills");
  handle("skills:list", async (_e, cwd) => skills.list(cwd));
  handle("skills:create", async (_e, cwd, input) => skills.create(cwd, input || {}));
  handle("skills:update", async (_e, cwd, id, patch) => skills.update(cwd, id, patch || {}));
  handle("skills:remove", async (_e, cwd, id) => skills.remove(cwd, id));
  handle("skills:import-url", async (_e, cwd, url) => skills.importFromUrl(cwd, url));
}

module.exports = { register };
