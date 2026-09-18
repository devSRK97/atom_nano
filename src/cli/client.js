"use strict";
/* CLI ↔ app transport (docs/WORKFLOW_CONTRACT.md §5). Plain Node, no Electron.
 *
 * Discovery: ATOMNANO_CONTROL + ATOMNANO_TOKEN — the running app exports both to every child process
 * (the Orchestrator's Bash tool, the in-app terminal) — else <userData>/control.json written by the app:
 * ATOMNANO_USER_DATA, then %APPDATA%\atomnano and %APPDATA%\AtomNano (Windows),
 * ~/Library/Application Support/{atomnano,AtomNano} (macOS), $XDG_CONFIG_HOME|~/.config/{atomnano,AtomNano}
 * (Linux). A control.json whose pid is gone is ignored.
 *
 * request() uses Node 18+ fetch. The first request is preceded by a 5-second connect check (GET /v1/ping);
 * a refused / reset / timed-out connection is a CliError with code 2 ("AtomNano is not running"). */
const fs = require("fs");
const os = require("os");
const path = require("path");

const NOT_RUNNING = "AtomNano is not running — start the app";
const CONNECT_TIMEOUT_MS = 5000;

class CliError extends Error {
  constructor(message, code = 1, data = null) { super(message); this.name = "CliError"; this.code = code; this.data = data; }
}

function userDataDirs(env = process.env) {
  const out = [];
  if (env.ATOMNANO_USER_DATA) out.push(path.resolve(env.ATOMNANO_USER_DATA));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    out.push(path.join(appData, "atomnano"), path.join(appData, "AtomNano"));
  } else if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    out.push(path.join(base, "atomnano"), path.join(base, "AtomNano"));
  } else {
    const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
    out.push(path.join(base, "atomnano"), path.join(base, "AtomNano"));
  }
  return [...new Set(out)];
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true;   // unknown → assume alive, the connect check decides
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

// → { url, token, source } | null
function discover(env = process.env) {
  if (env.ATOMNANO_CONTROL && env.ATOMNANO_TOKEN) return { url: String(env.ATOMNANO_CONTROL).replace(/\/+$/, ""), token: String(env.ATOMNANO_TOKEN), source: "env" };
  for (const dir of userDataDirs(env)) {
    const file = path.join(dir, "control.json");
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!j || !j.url || !j.token) continue;
    if (!pidAlive(j.pid)) continue;   // stale file from a crashed / killed app
    return { url: String(j.url).replace(/\/+$/, ""), token: String(j.token), source: file, pid: j.pid };
  }
  return null;
}

const CONN_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/;
// Every error code fetch may bury: e.code, e.cause.code, and AggregateError (autoSelectFamily) members.
function codesOf(e) {
  const out = [];
  const visit = (x, depth) => { if (!x || depth > 3) return; if (x.code) out.push(String(x.code)); if (Array.isArray(x.errors)) for (const y of x.errors) visit(y, depth + 1); if (x.cause) visit(x.cause, depth + 1); };
  visit(e, 0);
  return out;
}
function causeMessage(e) { let x = e; while (x && x.cause) x = x.cause; return String((x && x.message) || (e && e.message) || e); }
function connectionError(e) {
  if (!e) return false;
  if (codesOf(e).some((c) => CONN_CODES.test(c))) return true;
  return /socket hang up|other side closed|connect ECONNREFUSED|connection refused/i.test(causeMessage(e));
}
function timeoutError(e) { return !!e && (e.name === "TimeoutError" || e.name === "AbortError" || codesOf(e).includes("UND_ERR_HEADERS_TIMEOUT") || (e.cause && e.cause.name === "TimeoutError")); }

function signalFor(ms) {
  if (!(ms > 0)) return undefined;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ac = new AbortController(); setTimeout(() => ac.abort(), ms).unref(); return ac.signal;
}

/* createClient(env) → { url, token, source, request(method, route, body?, opts?) }. Throws CliError(2)
 * when no running app can be found. opts.timeoutMs bounds one request (default 60 s; long-polls pass
 * their own wait + margin). */
function createClient(env = process.env) {
  const conn = discover(env);
  if (!conn) throw new CliError(NOT_RUNNING, 2);
  if (typeof fetch !== "function") throw new CliError("This Node runtime has no fetch() — Node 18 or newer is required", 1);
  let checked = false;

  async function raw(method, route, body, timeoutMs) {
    const headers = { authorization: "Bearer " + conn.token, accept: "application/json" };
    const init = { method, headers, signal: signalFor(timeoutMs) };
    if (body !== undefined && body !== null) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(conn.url + route, init); }
    catch (e) {
      if (connectionError(e)) throw new CliError(checked ? "AtomNano stopped answering (the app quit or is restarting)" : NOT_RUNNING, 2);
      if (timeoutError(e)) throw new CliError(checked ? "AtomNano did not answer in time" : NOT_RUNNING, checked ? 1 : 2);
      throw new CliError(`Request to ${conn.url} failed: ${causeMessage(e)}${conn.source === "env" ? " (check ATOMNANO_CONTROL)" : ""}`, 1);
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 300) || `HTTP ${res.status}` }; }
    if (!res.ok) {
      const msg = json && json.error ? String(json.error) : `HTTP ${res.status}`;
      throw new CliError(res.status === 401 ? "The control token was rejected — restart the app, or unset ATOMNANO_CONTROL / ATOMNANO_TOKEN to rediscover it" : msg, 1, json);
    }
    return json;
  }

  async function request(method, route, body, opts = {}) {
    if (!checked) { await raw("GET", "/v1/ping", undefined, CONNECT_TIMEOUT_MS); checked = true; }
    return raw(method, route, body, opts.timeoutMs != null ? opts.timeoutMs : 60000);
  }

  return { url: conn.url, token: conn.token, source: conn.source, request };
}

module.exports = { createClient, discover, userDataDirs, CliError, NOT_RUNNING };
