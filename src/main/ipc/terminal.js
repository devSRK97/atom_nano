"use strict";
/* IPC: the integrated terminal — terminal:* (create / write / run / resize / interrupt / kill …),
 * backed by src/main/workspace/terminal.js. */
const terminal = require("../workspace/terminal");

function register(ctx) {
  const { handle } = ctx;
  /* Integrated terminal — a shell inside the app, so a command's output is
   * something the app can show and read back (see terminal.js). */
  handle("terminal:create", async (_e, opts) => terminal.create(opts || {}));
  handle("terminal:write", async (_e, id, data) => terminal.write(id, data));
  handle("terminal:run", async (_e, id, command) => terminal.run(id, command));
  handle("terminal:run-tracked", async (_e, id, command) => terminal.runTracked(id, command));
  handle("terminal:resize", async (_e, id, cols, rows) => terminal.resize(id, cols, rows));
  handle("terminal:interrupt", async (_e, id) => terminal.interrupt(id));
  handle("terminal:clear", async (_e, id) => terminal.clear(id));
  handle("terminal:kill", async (_e, id) => terminal.kill(id));
  handle("terminal:list", async () => terminal.list());
  handle("terminal:buffer", async (_e, id) => terminal.buffer(id));
  handle("terminal:rename", async (_e, id, title) => terminal.rename(id, title));
}

module.exports = { register };
