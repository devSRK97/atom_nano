"use strict";
/* IPC: the model catalog (models:discover, providers:catalog, plus the Codex re-list broadcast) and
 * image generation (image:generate), backed by src/main/providers/. */
const store = require("../storage/store");
const claude = require("../session/index");

function register(ctx) {
  const { handle, winFrom, projectOf, broadcast } = ctx;
  // Provider-aware: resolve the live model list + reasoning controls (thinking
  // levels vs reasoning effort) + 1M-context flags for the chosen provider.
  handle("models:discover", async (_e, provider, opts) => {
    const s = store.getSettings();
    const p = provider || s.llmProvider || "anthropic";
    return require("../providers/catalog").discover(p, { claudeRef: claude, customModels: s.customModels, customEndpoints: s.customEndpoints, keys: { openai: s.openaiApiKey, google: s.geminiApiKey, anthropic: s.apiKey }, force: !!(opts && opts.force) });
  });
  handle("providers:catalog", async () => require("../providers/catalog").catalog());
  // Codex re-listed its models (after an update, login switch, or server-side
  // change) → every window re-applies the OpenAI list (with the new-models toast).
  require("../providers/catalog").onCodexModelsChange(() => broadcast("models:update", { provider: "openai" }));

  // Image generation — prompt → image(s), added to the conversation as a viewable
  // + downloadable message. Provider auto-picked from available keys unless given.
  require("../providers/image-gen").setTextRunner((p, m, prompt, o) => require("../providers/council").reviewerRun(p, m, prompt, o));
  handle("image:generate", async (e, sessionId, prompt, opts) => {
    opts = opts || {};
    const sess0 = store.getSession(sessionId);
    const s = store.getSettings((sess0 && sess0.cwd) || projectOf(winFrom(e)));
    const sess = sess0;
    if (!sess) return { ok: false, error: "no session" };
    const primary = s.llmProvider || "anthropic";
    const rasterKey = s.openaiApiKey ? "openai" : s.geminiApiKey ? "google" : null;
    // Default = VECTOR (SVG) via the primary CLI — no API key needed. PHOTO
    // (raster) only when explicitly asked AND an image API key exists.
    const mode = opts.mode || (opts.photo && rasterKey ? "photo" : "vector");
    const provider = mode === "photo" ? (rasterKey || "openai") : primary;
    // Claim the runner slot BEFORE we mutate the session — otherwise a concurrent
    // claude.run() would silently steal the slot and image gen leaks a dangling
    // user message + status event onto a session that has its own real run.
    const ctl = claude.registerExternalRunner(sessionId, { label: "image: " + prompt.slice(0, 60) });
    if (!ctl) return { ok: false, error: "This tab is already running — wait for it to finish." };
    claude.addMessage(sess, { id: store.uid(), role: "user", text: prompt, attachments: [], ts: store.nowISO() });
    store.updateSession(sessionId, { status: "running" }); claude.send("session:status", { sessionId, status: "running" });
    let completion = null;
    try {
      const imgs = await require("../providers/image-gen").generate({ mode, provider, model: s.defaultModel, effort: s.defaultThinking, prompt, size: opts.size, n: opts.n, keys: { openai: s.openaiApiKey, google: s.geminiApiKey }, signal: ctl.signal });
      if (ctl.isAborted()) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (!imgs.length) throw new Error("no image returned");
      const images = imgs.map((im, i) => ({ kind: "image", data: im.data, mediaType: im.mediaType || "image/png", name: `generated-${i + 1}.${(im.mediaType || "").includes("svg") ? "svg" : "png"}` }));
      completion = { status: "done", message: { id: store.uid(), role: "image", prompt, provider, mode, images, ts: store.nowISO() } };
      return { ok: true, count: images.length, provider, mode };
    } catch (err) {
      if ((err && err.name === "AbortError") || ctl.isAborted()) {
        completion = { status: "idle", message: { id: store.uid(), role: "system", text: "Image generation stopped.", ts: store.nowISO() } };
        return { ok: false, error: "stopped" };
      }
      completion = { status: "error", message: { id: store.uid(), role: "error", text: "Image generation failed — " + String((err && err.message) || err), ts: store.nowISO() } };
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      // Stop releases the slot immediately. An old request settling afterwards must
      // not append a result or overwrite the replacement turn's running status.
      if (ctl.unregister() && store.getSession(sessionId) === sess && completion) {
        claude.addMessage(sess, completion.message);
        store.updateSession(sessionId, { status: completion.status });
        claude.send("session:status", { sessionId, status: completion.status });
      }
    }
  });

  // (The Optimise/Distill pre-mind and the embedded local optimizer were removed —
  //  the request is sent exactly as written; no local rewriting layer exists.)
}

module.exports = { register };
