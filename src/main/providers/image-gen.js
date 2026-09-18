"use strict";
/* IMAGE GENERATION — turn a text prompt into image(s) via the provider's image
 * API (OpenAI gpt-image-1 / Google Imagen), using the user's API key. Returns
 * base64 image data the renderer shows as a viewable + downloadable message.
 * The backend is injectable so the flow is testable without a key/network.
 */
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

let backend = null;   // injected: async ({provider,prompt,size,n}) => [{ data(base64), mediaType }]
function setBackend(fn) { backend = fn; }

// Text runner for VECTOR (SVG) generation — uses whatever CLI/model the user is
// already authed for (Claude / Codex / Gemini), so it needs NO image API key.
let textRunner = null;   // injected: async (provider, model, prompt, opts) => { ok, text, error }
function setTextRunner(fn) { textRunner = fn; }
function defaultTextRunner(provider, model, prompt, opts) { return require("./council").reviewerRun(provider, model, prompt, opts || {}); }

// Pull a standalone <svg> out of a model reply and make it safe + sized.
function extractSvg(text) {
  const m = /<svg[\s\S]*?<\/svg>/i.exec(String(text || ""));
  if (!m) return null;
  let svg = m[0].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "");
  if (!/viewBox/i.test(svg) && !/width\s*=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg width="512" height="512" viewBox="0 0 512 512"');
  if (!/xmlns=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

// VECTOR image gen: ask the text model for a complete SVG illustration.
async function generateVector({ provider, model, prompt, effort, signal } = {}) {
  const run = textRunner || defaultTextRunner;
  const ask = `You are an illustrator that outputs SVG. Create a clean, detailed SVG illustration of: "${prompt}".\nReturn ONLY one complete, standalone <svg>…</svg> element — valid SVG with an xmlns and a viewBox, using shapes/paths/gradients. No markdown code fences, no explanation, no <script>, no external links.`;
  if (signal && signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  const r = await run(provider, model, ask, { effort, signal });
  if (signal && signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  if (!r || !r.ok) throw new Error((r && r.error) || "the model didn't respond — check that its CLI is authorized in Settings → Providers");
  const svg = extractSvg(r.text);
  if (!svg) throw new Error("the model didn't return an SVG. Try rephrasing (e.g. 'a flat icon of a cat'), or add an image API key for photo-realistic images.");
  return [{ data: Buffer.from(svg, "utf8").toString("base64"), mediaType: "image/svg+xml" }];
}

// Fall back to the token the CLI already stored, so CLI-auth users (no API key)
// still get a shot. Best-effort: the token may or may not have image-API access.
function readField(file, pick) { try { return pick(JSON.parse(fs.readFileSync(file, "utf8"))) || null; } catch { return null; } }
function openaiToken(keys) { return keys.openai || readField(path.join(os.homedir(), ".codex", "auth.json"), (j) => j.OPENAI_API_KEY || (j.tokens && j.tokens.access_token)); }
function googleToken(keys) { const k = keys.google; if (k) return { token: k, bearer: !/^AIza/.test(k) }; const t = readField(path.join(os.homedir(), ".gemini", "oauth_creds.json"), (j) => j.access_token); return t ? { token: t, bearer: true } : null; }

function httpPostJson(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const data = JSON.stringify(body);
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "AtomNano", ...(headers || {}) }, timeout: 120000 }, (res) => {
      let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } } else reject(Object.assign(new Error("HTTP " + res.statusCode), { status: res.statusCode, body: b })); });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    if (signal) {
      const onAbort = () => { try { req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })); } catch { /* */ } };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.write(data); req.end();
  });
}
// Turn an API error into one short, actionable sentence (no raw JSON).
function friendly(e, provider, usingKey) {
  if (!e || !e.status) return String((e && e.message) || e);
  const P = provider === "openai" ? "OpenAI" : "Google";
  let msg = ""; try { const j = JSON.parse(e.body || ""); msg = (j.error && (j.error.message || j.error)) || j.message || ""; } catch { /* */ }
  if (e.status === 401 || e.status === 403) {
    return usingKey
      ? `${P} API key isn't authorized for image generation — use a key with image access (and billing enabled).`
      : "Image generation needs an API key with image access. Add a free Google AI Studio key, or an OpenAI key (image-enabled), in Settings → Providers. (Your CLI login isn't scoped for the image API.)";
  }
  if (e.status === 404) return `${P} image model not available on this account. ${String(msg).slice(0, 100)}`;
  if (e.status === 429) return `${P} rate limit / quota reached — try again shortly.`;
  return `${P} image API error ${e.status}${msg ? ": " + String(msg).slice(0, 140) : ""}`;
}

async function generate({ provider, model, prompt, size = "1024x1024", n = 1, mode = "vector", effort, keys = {}, signal } = {}) {
  if (!prompt || !prompt.trim()) throw new Error("empty prompt");
  if (backend) { const r = await backend({ provider, prompt, size, n, mode, signal }); if (Array.isArray(r)) return r; }
  // VECTOR (SVG) — key-free, via the Claude/Codex/Gemini CLI the user is authed for.
  if (mode === "vector" || mode === "svg") return generateVector({ provider, model, prompt, effort, signal });
  // PHOTO (raster) — needs an image-capable API key.
  provider = provider || "openai";

  if (provider === "openai") {
    const key = openaiToken(keys); if (!key) throw new Error("Add an OpenAI API key (with image access) in Settings → Providers to generate images.");
    try {
      const j = await httpPostJson("https://api.openai.com/v1/images/generations", { Authorization: "Bearer " + key }, { model: "gpt-image-1", prompt, size, n }, signal);
      return (j.data || []).map((d) => ({ data: d.b64_json, mediaType: "image/png" })).filter((x) => x.data);
    } catch (e) { if (e && e.name === "AbortError") throw e; throw new Error(friendly(e, "openai", !!keys.openai)); }
  }
  if (provider === "google") {
    const g = googleToken(keys); if (!g) throw new Error("Add a Google API key (free at aistudio.google.com) in Settings → Providers to generate images.");
    const base = "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict";
    const url = g.bearer ? base : `${base}?key=${encodeURIComponent(g.token)}`;
    const headers = g.bearer ? { Authorization: "Bearer " + g.token } : {};
    try {
      const j = await httpPostJson(url, headers, { instances: [{ prompt }], parameters: { sampleCount: Math.max(1, Math.min(4, n)) } }, signal);
      return (j.predictions || []).map((p) => ({ data: p.bytesBase64Encoded || p.image, mediaType: "image/png" })).filter((x) => x.data);
    } catch (e) { if (e && e.name === "AbortError") throw e; throw new Error(friendly(e, "google", !!keys.google)); }
  }
  throw new Error("unsupported image provider: " + provider);
}

module.exports = { generate, generateVector, extractSvg, setBackend, setTextRunner };
