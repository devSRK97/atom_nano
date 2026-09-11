"use strict";
/* TypeScript language service host — runs in a dedicated Electron utilityProcess.
 *
 * Why a separate process: the TS service holds the whole program (~tens of MB) and
 * its typechecking is CPU-heavy. Out here it (1) runs on its own core so it never
 * blocks the main process event loop, and (2) can be KILLED when idle so the OS
 * actually reclaims its memory — disposing the service in-process doesn't, because
 * V8 never returns freed heap to the OS. main.js respawns this on the next request.
 *
 * Protocol: parent posts { id, method, args }; we reply { id, result }. All TS
 * results are plain objects/arrays (structured-clonable). */
const tsserver = require("./tsserver");

process.parentPort.on("message", (e) => {
  const msg = e.data || {};
  let result = null;
  try {
    if (msg.method === "diagnose") result = tsserver.diagnose(...msg.args);
    else if (msg.method === "request") result = tsserver.request(...msg.args);
  } catch { result = null; }
  try { process.parentPort.postMessage({ id: msg.id, result }); } catch { /* parent gone */ }
});
