"use strict";
/* IPC: the background fleet — fleet:* (queue one or many, cancel, retry, remove, clear finished),
 * backed by src/main/agents/fleet.js. */
const fleet = require("../agents/fleet");

function register(ctx) {
  const { handle } = ctx;
  // ---- fleet (background agents on a queue, same-file conflict prevention) ----
  handle("fleet:list", async () => fleet.list());
  handle("fleet:enqueue", async (_e, cwd, task) => fleet.enqueue({ cwd, ...(task || {}) }));
  handle("fleet:enqueue-many", async (_e, cwd, items) => fleet.enqueueMany(cwd, items || []));
  handle("fleet:cancel", async (_e, id) => fleet.cancel(id));
  handle("fleet:retry", async (_e, id) => fleet.retry(id));
  handle("fleet:remove", async (_e, id) => fleet.remove(id));
  handle("fleet:clear-finished", async () => fleet.clearFinished());
}

module.exports = { register };
