"use strict";
/* IPC: provider logins and accounts — auth:*, provider:* (status, authorize, custom-endpoint probe),
 * the credential profiles (profiles:*), codex:account, the tool version / update routes (updates:*,
 * tools:*) and usage:get. They call src/main/auth/cli-auth.js; a login change is reported back to
 * the bootstrap through ctx.onProviderLoginChanged so the runtime + every window follow it. */
const { dialog } = require("electron");
const store = require("../storage/store");
const auth = require("../auth/cli-auth");
const claude = require("../session/index");

function register(ctx) {
  const { handle, winFrom, onProviderLoginChanged } = ctx;
  // ---- Auth / updates ----
  handle("auth:status", async () => auth.status());
  handle("auth:open-login", async () => auth.openLoginTerminal());
  handle("updates:check", async (_e, opts) => auth.checkUpdates(opts || {}));
  handle("updates:run", async (e) => {
    const w = winFrom(e);
    const send = (message) => { if (w && !w.isDestroyed()) w.webContents.send("updates:progress", { message }); };
    const busy = claude.runningCount();
    if (busy > 0) send(`⚠ ${busy} session${busy > 1 ? "s are" : " is"} running — the Claude CLI binary can't be replaced while it is in use. Stop them if the CLI step fails.`);
    const r = await auth.updateAll(send);
    try { claude.resetCliCache(); } catch { /* ignore */ }
    return r;
  });
  // ---- per-tool versions + per-item update, per-provider authorize ----
  handle("tools:versions", async () => auth.toolVersions());
  handle("tools:latest", async (_e, installed, opts) => auth.toolLatest(installed || null, opts || {}));
  // Per-tool update. Serialized (one install at a time), and honest about what is
  // ACTIVE: the Codex app-server is stopped so the next turn spawns the new binary
  // (a running turn keeps the old one until it finishes); an already-imported Codex
  // SDK / Agent SDK module stays the old version in this process until relaunch,
  // which the result says explicitly (installedVersion vs activeVersion).
  let updateInFlight = null;
  handle("tools:update", async (e, tool) => {
    if (updateInFlight) return { ok: false, detail: `Another update (${updateInFlight}) is still running — wait for it to finish.`, busy: true };
    updateInFlight = tool;
    const w = winFrom(e);
    try {
      const r = await auth.updateTool(tool, (message) => { if (w && !w.isDestroyed()) w.webContents.send("updates:progress", { message }); });
      try { claude.resetCliCache(); } catch { /* ignore */ }
      if (r && r.ok) {
        const changed = r.before && r.after && r.before !== r.after;
        if (tool === "codexSdk" || tool === "codex") {
          const appserver = require("../providers/codex-appserver");
          const wasBusy = appserver.busy();
          if (!wasBusy) appserver.stop();
          try { require("../providers/codex-exec").resetSdk(); } catch { /* */ }
          try { require("../providers/catalog").refreshCodexModels(); } catch { /* */ }
          r.activation = wasBusy ? "A Codex turn is running — the new version starts with the next Codex turn after it finishes." : "The next Codex turn starts the updated binary.";
          if (changed && require("../providers/codex-exec").sdkLoaded()) r.restartRequired = true;
        }
        if (tool === "agentSdk" && changed) { r.restartRequired = true; r.activation = "The Agent SDK is loaded once per process — restart AtomNano to run the new version."; }
        if (tool === "claudeCli") r.activation = "The next Claude turn spawns the updated CLI.";
      }
      return r;
    } finally { updateInFlight = null; }
  });
  handle("provider:auth-status", async () => auth.providerAuthStatus());
  handle("provider:authorize", async (_e, provider) => auth.authorizeProvider(provider));
  // ---- credential profiles (multi-account; Claude + Codex) ----
  // A login change is a PROVIDER-SCOPED transaction: only that provider's runtime
  // bindings are refreshed (Codex: the login-context app-server re-reads auth.json
  // once idle and the effective account is read back from the runtime; Claude: the
  // CLI reads its credential file per spawn, and native transcripts live in the app
  // home, so resumed sessions simply continue under the new login). Conversation
  // records are never cleared to reload credentials. Running turns keep the
  // credentials they started with; the switch applies at the next turn boundary.
  const afterLoginChange = (provider) => onProviderLoginChanged(provider);
  handle("profiles:list", async (_e, provider) => auth.listProfiles(provider));
  handle("profiles:live", async (_e, provider) => auth.liveLogin(provider));
  handle("profiles:save", async (_e, label, provider) => auth.saveCurrentAsProfile(label, provider));
  handle("profiles:save-current", async (_e, provider) => auth.saveNewLoginAsProfile(provider));
  handle("profiles:switch", async (_e, label, provider) => {
    const r = auth.switchProfile(label, provider);
    if (r && r.ok && !r.already) {
      const ack = await afterLoginChange(provider);
      if (ack) r.runtimeAccount = ack;   // what the runtime ACTUALLY reports after the switch
    }
    return r;
  });
  handle("profiles:logout", async (_e, provider) => {
    const r = await auth.logout(provider);
    if (r && r.ok) await afterLoginChange(provider);
    return r;
  });
  // The account the Codex runtime is actually using (type / email / plan), read from
  // app-server `account/read` — never inferred from a profile label.
  handle("codex:account", async (_e, force) => {
    try { const s = store.getSettings(); return await require("../providers/codex-appserver").accountRead({ apiKey: s.openaiApiKey || "" }, { force: !!force }); } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  handle("profiles:delete", async (_e, label, provider) => auth.deleteProfile(label, provider));
  handle("profiles:rename", async (_e, oldLabel, newLabel, provider) => auth.renameProfile(oldLabel, newLabel, provider));
  handle("profiles:export", async (e, label, provider) => {
    const P = auth.profiles;
    const def = String(label || "account").replace(/[^a-zA-Z0-9_@.\-]/g, "_") + P.exportExt(provider || "anthropic");
    const res = await dialog.showSaveDialog(winFrom(e), { title: "Export saved account", defaultPath: def, filters: [P.fileFilter(provider || "anthropic")] });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    return auth.exportProfile(label, res.filePath, provider);
  });
  handle("profiles:import", async (e, provider) => {
    const P = auth.profiles;
    const res = await dialog.showOpenDialog(winFrom(e), { title: "Import saved account", properties: ["openFile"], filters: [P.fileFilter(provider || "anthropic")] });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    return auth.importProfile(res.filePaths[0], "", provider);
  });
  // ---- real Claude subscription usage (for the active-tab tooltip) ----
  handle("usage:get", async (_e, force) => auth.fetchUsage(force));
  // (headroom:stats handler removed with the headroom integration.)
  // Probe a raw-HTTP custom provider with a sample prompt. Returns the raw JSON
  // response + extracted text + every detected reply key, so the modal's Test
  // button can show the response and help the user pick the right Output path.
  handle("provider:test-custom", async (_e, cfg) => {
    const customApi = require("../providers/custom-api");
    const s = store.getSettings();
    const c = cfg || {};
    const r = await customApi.call({
      endpoint: c.endpoint != null ? c.endpoint : s.customEndpoint,
      headers: c.headers != null ? c.headers : s.customHeaders,
      payloadTemplate: c.payloadTemplate != null ? c.payloadTemplate : s.customPayloadTemplate,
      outputPath: c.outputPath != null ? c.outputPath : s.customOutputPath,
      model: c.model || s.defaultModel || "",
      prompt: c.prompt || "Reply with the single word: pong",
      system: c.system || "",
      apiKey: c.apiKey != null ? c.apiKey : s.customApiKey,
    });
    // Truncate the raw body for transport; keep candidates + extracted text whole.
    return { ok: r.ok, status: r.status || 0, text: r.text || "", usedPath: r.usedPath || null,
      candidates: r.candidates || [], error: r.error || null,
      raw: (r.raw || "").slice(0, 8000), json: r.json || null };
  });
}

module.exports = { register };
