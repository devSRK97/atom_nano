"use strict";
/* Worker thread that runs project search off the main process (uses a separate core). */
const { parentPort, workerData } = require("worker_threads");
const core = require("./search-core");

(async () => {
  try {
    const { type, opts } = workerData;
    const res = type === "names" ? await core.searchNames(opts)
      : type === "definition" ? await core.findDefinition(opts)
      : await core.searchContent(opts);
    parentPort.postMessage({ ok: true, data: res });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
})();
