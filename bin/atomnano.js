#!/usr/bin/env node
"use strict";
/* `atomnano` — the command-line side of AtomNano's workflow (docs/WORKFLOW_CONTRACT.md §5).
 * Plain Node: it never launches Electron. It talks to the RUNNING app over its local control server,
 * found through ATOMNANO_CONTROL / ATOMNANO_TOKEN (exported by the app to every child process — the
 * Planner's Bash tool, the in-app terminal) or <userData>/control.json for an outside terminal.
 *
 *   atomnano status | roles | sessions | providers | models
 *   atomnano run coder "Fix the failing login test" --wait
 *   atomnano jobs · job <id> · wait <id> · result <id> · log <id> · stop <id>
 *
 * Exit codes: 0 ok · 1 usage/other error · 2 AtomNano is not running · 3 the awaited job failed/stopped.
 * bin/atomnano.cmd (Windows) and bin/atomnano (sh) run this file with the app's own Node runtime
 * (ATOMNANO_NODE, Electron run as Node) when the app exported it, else with `node` from PATH. */
if (require.main === module) {
  const { main } = require("../src/cli/index.js");
  // No process.exit(): the loop drains by itself (fetch's idle sockets and timeout timers are unref'd),
  // which also guarantees piped stdout is flushed. The unref'd timer only fires if something lingers.
  const finish = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 2000).unref(); };
  main(process.argv.slice(2)).then((code) => finish(Number.isInteger(code) ? code : 0), (e) => {
    process.stderr.write("atomnano: " + ((e && e.message) || e) + "\n");
    finish(1);
  });
}
