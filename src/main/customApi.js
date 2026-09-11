"use strict";
/* Raw-HTTP custom provider — talk to ANY chat/completions API, not just
 * Anthropic-compatible ones. The user supplies:
 *   - endpoint URL
 *   - extra headers (one "Key: Value" per line, {{apiKey}} substituted)
 *   - a request payload TEMPLATE (JSON with {{prompt}} / {{system}} / {{model}})
 *   - an output PATH (where the reply text lives, e.g. choices[0].message.content)
 *
 * Different APIs nest their reply differently, so the output path is configurable.
 * When it's blank (or wrong) we fall back to a list of common shapes and also
 * return every string leaf path so the UI can let the user pick the right one.
 */
const https = require("https");
const http = require("http");

// Escape a value so it can be dropped INSIDE an existing JSON string in the
// template — i.e. "content": "{{prompt}}" stays valid after substitution.
function jsonInner(v) {
  const s = v == null ? "" : String(v);
  const j = JSON.stringify(s);
  return j.slice(1, j.length - 1);
}

// Substitute {{var}} placeholders. String vars are JSON-inner-escaped so the
// result stays valid JSON when the placeholder sits inside quotes.
function applyTemplate(tpl, vars = {}) {
  return String(tpl || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return jsonInner(vars[key]);
    return m;   // leave unknown placeholders untouched
  });
}

// Same, but for header values (no JSON escaping — plain text substitution).
function applyPlain(str, vars = {}) {
  return String(str || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] == null ? "" : vars[key]) : m);
}

// Build the request body object from the template (throws a clear error if the
// substituted text isn't valid JSON, so the UI can surface it).
function buildBody(template, vars) {
  const filled = applyTemplate(template, vars);
  try { return JSON.parse(filled); }
  catch (e) { throw new Error("Payload template isn't valid JSON after substitution: " + e.message); }
}

// Fallback when the template has no {{prompt}} placeholder (e.g. a curl example
// pasted verbatim) — inject the real prompt/system into the parsed body so each
// turn actually sends the user's message instead of the hardcoded sample. Handles
// OpenAI `messages`, Gemini `contents`, and common single-field shapes.
function injectPrompt(body, prompt, system, hasSystemToken) {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body.messages)) {
    let lastUser = null;
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "user") lastUser = m;
      if (!hasSystemToken && system && m.role === "system" && typeof m.content === "string") m.content = system;
    }
    if (lastUser) lastUser.content = prompt;
    else body.messages.push({ role: "user", content: prompt });
    return true;
  }
  if (Array.isArray(body.contents)) {   // Gemini
    const last = body.contents[body.contents.length - 1];
    if (last && Array.isArray(last.parts) && last.parts[0] && typeof last.parts[0] === "object") { last.parts[0].text = prompt; return true; }
    body.contents.push({ parts: [{ text: prompt }] });
    return true;
  }
  for (const k of ["prompt", "input", "text", "query", "message", "inputs", "question"]) {
    if (k in body && typeof body[k] === "string") { body[k] = prompt; return true; }
  }
  return false;
}

// Parse "Key: Value" lines into a headers object; {{apiKey}} etc. substituted.
function parseHeaders(text, vars) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    const v = applyPlain(t.slice(i + 1).trim(), vars);
    if (k) out[k] = v;
  }
  return out;
}

// Read a value at a dotted/bracketed path: "a.b[0].c" or "a/b/0/c".
function jsonGet(obj, path) {
  if (!path) return undefined;
  const parts = String(path).replace(/\[(\w+)\]/g, ".$1").replace(/\//g, ".").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Collect every string-valued leaf path (capped) so the UI can offer choices.
function leafPaths(obj, prefix = "", out = [], depth = 0) {
  if (depth > 6 || out.length > 60) return out;
  if (Array.isArray(obj)) {
    obj.slice(0, 6).forEach((v, i) => leafPaths(v, `${prefix}[${i}]`, out, depth + 1));
  } else if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const np = prefix ? `${prefix}.${k}` : k;
      const v = obj[k];
      if (typeof v === "string") { if (v.trim()) out.push({ path: np, sample: v.slice(0, 80) }); }
      else leafPaths(v, np, out, depth + 1);
    }
  }
  return out;
}

// Common reply locations to try when the configured path misses.
const FALLBACK_PATHS = [
  "choices[0].message.content",
  "choices[0].text",
  "choices[0].delta.content",
  "content[0].text",
  "candidates[0].content.parts[0].text",   // Gemini
  "output[0].content[0].text",             // Responses API
  "output_text",
  "message.content",
  "completion",
  "response",
  "text",
  "data",
];

// Pick the reply text: configured path first, then fallbacks. Returns the text
// and which path produced it (so the UI can show/learn it).
function extractOutput(resp, outputPath) {
  if (outputPath) {
    const v = jsonGet(resp, outputPath);
    if (typeof v === "string") return { text: v, usedPath: outputPath };
    if (v != null && typeof v !== "object") return { text: String(v), usedPath: outputPath };
    // Array of {text} or strings (some APIs split the reply into chunks)
    if (Array.isArray(v)) {
      const joined = v.map((x) => (typeof x === "string" ? x : (x && (x.text || x.content)) || "")).join("");
      if (joined) return { text: joined, usedPath: outputPath };
    }
  }
  for (const p of FALLBACK_PATHS) {
    const v = jsonGet(resp, p);
    if (typeof v === "string" && v.trim()) return { text: v, usedPath: p };
  }
  return { text: "", usedPath: null };
}

// Low-level POST returning { status, text, json }.
function request(url, headers, bodyObj, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    let u; try { u = new URL(url); } catch (e) { return reject(new Error("Invalid endpoint URL: " + e.message)); }
    const data = JSON.stringify(bodyObj);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "AtomNano", ...(headers || {}) },
      timeout: 120000,
    }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; if (b.length > 4_000_000) req.destroy(new Error("response too large")); });
      res.on("end", () => {
        let json = null; try { json = JSON.parse(b); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, text: b, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (signal) signal.addEventListener("abort", () => { try { req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })); } catch { /* */ } }, { once: true });
    req.write(data); req.end();
  });
}

// One full custom turn. Returns { ok, status, raw, json, text, usedPath, candidates, error }.
async function call({ endpoint, headers, payloadTemplate, outputPath, model, prompt, system, apiKey, signal } = {}) {
  if (!endpoint || !String(endpoint).trim()) return { ok: false, error: "No endpoint URL configured." };
  if (!payloadTemplate || !String(payloadTemplate).trim()) return { ok: false, error: "No request payload template configured." };
  const vars = { prompt: prompt || "", system: system || "", model: model || "", apiKey: apiKey || "" };
  const hasPromptToken = /\{\{\s*prompt\s*\}\}/.test(payloadTemplate);
  const hasSystemToken = /\{\{\s*system\s*\}\}/.test(payloadTemplate);
  let body, hdrs;
  try { body = buildBody(payloadTemplate, vars); } catch (e) { return { ok: false, error: e.message }; }
  // No {{prompt}} in the template → inject the real message so every turn isn't the
  // same hardcoded sample (common when a curl example is pasted as the payload).
  if (!hasPromptToken) injectPrompt(body, prompt || "", system || "", hasSystemToken);
  try { hdrs = parseHeaders(headers, vars); } catch (e) { return { ok: false, error: "Bad headers: " + e.message }; }
  let res;
  try { res = await request(endpoint, hdrs, body, signal); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e), aborted: e && e.name === "AbortError" }; }
  const candidates = res.json ? leafPaths(res.json) : [];
  if (res.status < 200 || res.status >= 300) {
    let msg = `HTTP ${res.status}`;
    if (res.json && res.json.error) msg += " — " + (res.json.error.message || JSON.stringify(res.json.error)).slice(0, 200);
    else if (res.text) msg += " — " + res.text.slice(0, 200);
    return { ok: false, status: res.status, raw: res.text, json: res.json, candidates, error: msg };
  }
  const { text, usedPath } = extractOutput(res.json || {}, outputPath);
  return { ok: !!text, status: res.status, raw: res.text, json: res.json, text, usedPath, candidates,
    error: text ? null : "Couldn't find the reply text — set the Output path to one of the detected keys." };
}

// Normalize the configured custom endpoints. Migrates the legacy single raw
// config into one entry so older setups keep working with the new multi-endpoint
// model. Each endpoint is one selectable "model" in the custom provider.
function listEndpoints(settings) {
  const s = settings || {};
  const list = Array.isArray(s.customEndpoints) ? s.customEndpoints.filter((e) => e && e.id) : [];
  if (list.length) return list;
  // Legacy single raw config → synthesize one endpoint.
  if (s.customMode === "raw" && (s.customEndpoint || s.customPayloadTemplate)) {
    return [{
      id: "custom-default", name: "Custom endpoint",
      endpoint: s.customEndpoint || "", apiKey: s.customApiKey || "",
      model: s.defaultModel || "", headers: s.customHeaders || "",
      payloadTemplate: s.customPayloadTemplate || "", outputPath: s.customOutputPath || "",
    }];
  }
  return [];
}
// Resolve an endpoint by id OR name (exact first, then case-insensitive, then a
// partial name match) so the CLI can pick it with -m custom-default | "GLM 5.2" | glm.
function getEndpoint(settings, idOrName) {
  const list = listEndpoints(settings);
  if (!idOrName) return null;
  const q = String(idOrName).trim().toLowerCase();
  return list.find((e) => e.id === idOrName)
    || list.find((e) => (e.name || "").toLowerCase() === q)
    || list.find((e) => (e.id || "").toLowerCase() === q)
    || list.find((e) => (e.name || "").toLowerCase().includes(q))
    || null;
}

module.exports = { call, buildBody, parseHeaders, jsonGet, leafPaths, extractOutput, applyTemplate, applyPlain, injectPrompt, FALLBACK_PATHS, listEndpoints, getEndpoint };
