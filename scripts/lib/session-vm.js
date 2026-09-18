"use strict";
/* Test loader for the session manager (src/main/session/*.js).
 *
 * The harnesses run the ORIGINAL session modules inside one VM context with FAKE dependencies:
 * `deps` maps a dependency's basename ("store", "history", "codex-appserver", … — the legacy
 * "./store" form is accepted too) or a Node builtin name ("child_process") to the object the
 * modules should receive. Session modules require each other normally (resolved inside the
 * context); anything else must be in `deps` — an unexpected dependency throws, so a new import
 * in the manager is noticed by the suites. `sdk` (a fake { query }) is injected through the
 * manager's own setSDK seam. Nothing here touches the network or the developer's data. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const SESSION_DIR = path.join(ROOT, "src", "main", "session");
const BUILTINS = new Set(["path", "fs", "os", "crypto", "child_process", "worker_threads", "events", "util", "url", "zlib", "stream", "http", "https", "net", "tls", "string_decoder", "readline", "assert"]);

function loadSessionInVm({ deps = {}, sdk = null, console: con } = {}) {
  const context = vm.createContext({ process, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, URL, TextEncoder, TextDecoder, console: con || { log() {}, warn() {}, error() {} } });
  const cache = new Map();
  const dep = (key) => (Object.prototype.hasOwnProperty.call(deps, key) ? deps[key] : Object.prototype.hasOwnProperty.call(deps, "./" + key) ? deps["./" + key] : undefined);
  const makeRequire = (fromDir) => (spec) => {
    if (BUILTINS.has(spec)) { const d = dep(spec); return d !== undefined ? d : require(spec); }
    if (spec.startsWith(".")) {
      const abs = path.resolve(fromDir, spec.endsWith(".js") ? spec : spec + ".js");
      const rel = path.relative(SESSION_DIR, abs).replace(/\\/g, "/");
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return load(rel);
      const base = path.basename(abs, ".js");
      const d = dep(base);
      if (d !== undefined) return d;
      throw new Error("Unexpected manager dependency " + spec);
    }
    const d = dep(spec);
    if (d !== undefined) return d;
    throw new Error("Unexpected manager dependency " + spec);
  };
  function load(rel) {
    if (cache.has(rel)) return cache.get(rel).exports;
    const file = path.join(SESSION_DIR, rel);
    const src = fs.readFileSync(file, "utf8");
    const mod = { exports: {} };
    cache.set(rel, mod);
    const fn = vm.runInContext("(function (module, exports, require, __filename, __dirname) {" + src + "\n})", context, { filename: file });
    fn(mod, mod.exports, makeRequire(path.dirname(file)), file, path.dirname(file));
    return mod.exports;
  }
  const M = load("index.js");
  if (sdk) M.setSDK(sdk);
  return { M, modules: cache, context };
}

// Every session module's source, concatenated (for the suites' static source guards).
function sessionSource() {
  return fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".js")).sort().map((f) => fs.readFileSync(path.join(SESSION_DIR, f), "utf8")).join("\n");
}

module.exports = { loadSessionInVm, sessionSource, SESSION_DIR };
