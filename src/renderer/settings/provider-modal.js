/* Settings › Providers › one provider's management modal — Authorize (browser / CLI login),
 * saved accounts, an optional API key, Codex options, and for Custom the named endpoints
 * (URL + key + model + request template + output path, with a live Test). */
import { setSharedSetting } from "../chat/composer.js";
import { loadProviderModels } from "../core/catalog.js";
import { closeModal, confirmDialog, h, modalShell, promptDialog, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";
import { field, section, segmented } from "./controls.js";

// Request-template presets for the Custom provider — any HTTP API, not just Anthropic-shaped ones.
const CUSTOM_PRESETS = {
  openai: {
    label: "OpenAI-style",
    headers: "Authorization: Bearer {{apiKey}}",
    payload: '{\n  "model": "{{model}}",\n  "messages": [\n    { "role": "system", "content": "{{system}}" },\n    { "role": "user", "content": "{{prompt}}" }\n  ]\n}',
    output: "choices[0].message.content",
  },
  anthropic: {
    label: "Anthropic-style",
    headers: "x-api-key: {{apiKey}}\nanthropic-version: 2023-06-01",
    payload: '{\n  "model": "{{model}}",\n  "max_tokens": 4096,\n  "system": "{{system}}",\n  "messages": [\n    { "role": "user", "content": "{{prompt}}" }\n  ]\n}',
    output: "content[0].text",
  },
  gemini: {
    label: "Gemini-style",
    headers: "x-goog-api-key: {{apiKey}}",
    payload: '{\n  "system_instruction": { "parts": [ { "text": "{{system}}" } ] },\n  "contents": [ { "parts": [ { "text": "{{prompt}}" } ] } ]\n}',
    output: "candidates[0].content.parts[0].text",
  },
};
const slugifyEp = (name) => (String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "endpoint");
// Rewrite a pasted payload (with hardcoded message text) to use {{prompt}}/{{system}}.
function autofixPayload(text) {
  let obj; try { obj = JSON.parse(text); } catch { return null; }
  let changed = false;
  if (Array.isArray(obj.messages)) {
    let lastUser = null;
    for (const m of obj.messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "user") lastUser = m;
      if (m.role === "system" && typeof m.content === "string") { m.content = "{{system}}"; changed = true; }
    }
    if (lastUser) { lastUser.content = "{{prompt}}"; changed = true; }
    else { obj.messages.push({ role: "user", content: "{{prompt}}" }); changed = true; }
  } else if (Array.isArray(obj.contents)) {
    const last = obj.contents[obj.contents.length - 1];
    if (last && Array.isArray(last.parts) && last.parts[0]) { last.parts[0].text = "{{prompt}}"; changed = true; }
  } else {
    for (const k of ["prompt", "input", "text", "query", "message", "question"]) {
      if (k in obj && typeof obj[k] === "string") { obj[k] = "{{prompt}}"; changed = true; break; }
    }
  }
  return changed ? JSON.stringify(obj, null, 2) : null;
}

// `onChange` re-renders the providers list so the card status + Primary mark stay live.
export async function openProviderModal(p, onChange) {
  const s = state.settings;
  const isAnthropic = p.id === "anthropic";
  const canPrimary = p.id === "anthropic" || p.id === "google" || p.id === "custom";
  const firstWord = p.name.split(" ")[0];
  const body = h("div", { class: "prov-modal" });
  let backRef = null;
  let custEdit = null;   // null = endpoint list; object = endpoint being added/edited

  async function render() {
    body.innerHTML = "";
    const pst = await atom.providers.authStatus().catch(() => ({}));
    const ps = pst[p.id] || {};
    let loggedIn = ps.loggedIn, methodTxt = "", detail = "";
    if (isAnthropic) { const a = await atom.auth.status().catch(() => ({})); loggedIn = a.loggedIn || ps.loggedIn; methodTxt = a.loggedIn ? `Signed in — ${a.authMethod || "CLI login"}` : ""; detail = a.cliFound ? `Claude CLI: ${a.cliPath}${a.version ? " · v" + a.version : ""}` : "Claude CLI not found on PATH — set its path in Storage."; }
    else methodTxt = loggedIn ? "Signed in via CLI / browser login" : "";
    // For custom, "connected" means at least one endpoint is configured.
    const custCount = p.id === "custom" ? epList().length : 0;
    if (p.id === "custom") methodTxt = custCount ? `${custCount} endpoint${custCount > 1 ? "s" : ""} configured` : "";
    const authed = p.id === "custom" ? custCount > 0 : (loggedIn || ps.key);
    const isPrimary = (s.llmProvider || "anthropic") === p.id;

    // status header
    body.append(h("div", { class: "pm-status" },
      h("span", { class: "status-pill " + (authed ? "ok" : "bad") }, h("span", { class: "dot" }), authed ? "Connected" : "Not connected"),
      isPrimary ? h("span", { class: "pc-primary", text: "Primary" }) : null,
      h("span", { class: "hint", style: "margin:0", text: methodTxt || (p.id === "custom" ? "Add an endpoint to get started" : ps.key ? "Using an API key" : "Not connected yet") })));

    // sign-in
    if (ps.canAuthorize !== false) {
      body.append(section("Sign in", "shield"));
      const authBtn = h("button", { class: "btn btn-primary", html: `${icon("shield", 14)}<span>Authorize ${firstWord}</span>`, onclick: async () => {
        if (isAnthropic) { await atom.auth.openLogin(); toast("Login terminal opened — finish /login, then Re-check"); }
        else { const r = await atom.providers.authorize(p.id).catch(() => ({ ok: false })); toast(r.ok ? "Opened a login window — finish there, then Re-check" : (r.detail || "Use an API key instead"), r.ok ? "shield" : "alert"); }
      } });
      body.append(h("div", { class: "pm-row" }, authBtn, h("button", { class: "btn btn-ghost", html: `${icon("refresh", 14)}<span>Re-check</span>`, onclick: () => render() })));
      if (detail) body.append(h("div", { class: "hint", text: detail }));
    }

    // Saved accounts (Claude and Codex CLI logins) — switch between logins without re-authorizing.
    if (isAnthropic || p.id === "openai") {
      const prov = p.id === "openai" ? "openai" : "anthropic";
      const brand = prov === "openai" ? "Codex" : "Claude";
      body.append(section("Saved accounts", "user"));
      const profBox = h("div", { class: "prof-list" });
      let profiles = [], live = null;
      try { profiles = await atom.profiles.list(prov); } catch { /* ignore */ }
      try { live = await atom.profiles.live(prov); } catch { /* ignore */ }
      if (live && live.loggedIn && !live.savedAs) profBox.append(h("div", { class: "hint", text: `Signed in${live.email ? " as " + live.email : ""}${live.sub ? " (" + live.sub + ")" : ""} — not saved yet. It's saved automatically on the next token refresh, or click “Save current login”.` }));
      if (profiles.length) {
        for (const pf of profiles) {
          const rename = h("button", { class: "prof-act", html: icon("pencil", 12), title: "Rename", onclick: () => {
            promptDialog({ title: "Rename saved account", ic: "user", message: "A friendly name to tell your accounts apart.", placeholder: "e.g. Work · Personal", value: pf.label, confirmLabel: "Rename", onConfirm: async (name) => {
              if (!name || !name.trim()) return;
              const r = await atom.profiles.rename(pf.label, name.trim(), prov).catch((e) => ({ ok: false, detail: e.message }));
              if (r.ok) { toast("Renamed to " + r.label, "check"); render(); } else toast(r.detail || "Rename failed", "alert");
            } });
          } });
          const exp = h("button", { class: "prof-act", html: icon("download", 12), title: "Export this account", onclick: async () => {
            const r = await atom.profiles.export(pf.label, prov).catch((e) => ({ ok: false, detail: e.message }));
            if (r.ok) toast("Exported to " + r.path, "download");
            else if (!r.canceled) toast(r.detail || "Export failed", "alert");
          } });
          const subLine = pf.active ? "Active — currently signed in" + (pf.sub ? " · " + pf.sub : "") : (pf.expired ? "Expired — sign in to this account again and re-save" : (pf.email && pf.email !== pf.label ? pf.email : (pf.sub ? brand + " " + pf.sub : "saved login")));
          profBox.append(h("div", { class: "prof-item" + (pf.active ? " active" : "") + (pf.expired ? " expired" : "") },
            h("span", { class: "prof-ic", html: icon(pf.active ? "check" : pf.expired ? "alert" : "user", 14) }),
            h("span", { class: "prof-main" },
              h("span", { class: "prof-email", text: pf.label || pf.email || (pf.sub ? brand + " " + pf.sub : "account") }),
              h("span", { class: "prof-sub", text: subLine })),
            pf.active
              ? h("span", { class: "prof-tag", text: "Active" })
              : h("button", { class: "btn btn-sm", text: "Switch", disabled: !!pf.expired, title: pf.expired ? "This saved login has expired" : `Sign in as ${pf.label}`, onclick: async () => {
                  const r = await atom.profiles.switch(pf.label, prov).catch((e) => ({ ok: false, detail: e.message }));
                  if (r.ok) {
                    // Show what the RUNTIME acknowledges after the switch (Codex account/read), not just the profile label.
                    const ack = r.runtimeAccount ? ` · runtime reports ${r.runtimeAccount.email || r.runtimeAccount.type}${r.runtimeAccount.planType ? " (" + r.runtimeAccount.planType + ")" : ""}` : "";
                    toast(r.already ? ("Already signed in as " + (pf.label || pf.email)) : ("Switched to " + (pf.label || pf.email) + ack + " — paused sessions resume…"), "key", { ms: 6000 });
                    for (const [id, ts2] of state.tabs) {
                      if (ts2.meta.status === "auth-expired" || ts2.meta.status === "ratelimited") atom.sessions.retry(id).catch(() => {});
                    }
                    render();                 // refresh this modal (status header + Active markers)
                    if (onChange) onChange();  // and the Providers card behind it
                  } else { toast(r.detail || "Switch failed", "alert", { ms: r.expired ? 8000 : 4000 }); }
                } }),
            rename, exp,
            h("button", { class: "prof-act prof-del", html: icon("trash", 12), title: "Remove saved account", onclick: async () => {
              await atom.profiles.delete(pf.label, prov).catch(() => {});
              toast("Removed " + (pf.label || pf.email));
              render();
            } })));
        }
      } else {
        profBox.append(h("div", { class: "hint", text: `No saved ${brand} accounts yet. Logins are saved automatically; save now to switch quickly when rate-limited.` }));
      }
      body.append(profBox);
      body.append(h("div", { class: "pm-row" },
        h("button", { class: "btn btn-ghost", html: `${icon("plus", 14)}<span>Save current login</span>`, onclick: async () => {
          const r = await atom.profiles.saveCurrent(prov).catch((e) => ({ ok: false, detail: e.message }));
          if (r.ok) { toast((r.created || !r.updated ? "Saved as " : "Refreshed ") + r.label, "check"); render(); }
          else toast(r.detail || "No active login to save", "alert");
        } }),
        h("button", { class: "btn btn-ghost", html: `${icon("upload", 14)}<span>Import account</span>`, title: `Import a ${brand} credential file exported from another machine`, onclick: async () => {
          const r = await atom.profiles.import(prov).catch((e) => ({ ok: false, detail: e.message }));
          if (r.ok) { toast("Imported as " + r.label, "check"); render(); }
          else if (!r.canceled) toast(r.detail || "Import failed", "alert");
        } }),
        (live && live.loggedIn) ? h("button", { class: "btn btn-ghost", html: `${icon("x", 14)}<span>Sign out</span>`, title: "Sign out of the CLI login — saved accounts are kept and can be restored with Switch", onclick: async () => {
          const r = await atom.profiles.logout(prov).catch((e) => ({ ok: false, detail: e.message }));
          if (r.ok) { toast(r.savedAs ? `Signed out — “${r.savedAs}” stays saved` : "Signed out", "key"); render(); if (onChange) onChange(); }
          else toast(r.detail || "Sign out failed", "alert");
        } }) : null));
    }

    if (p.id === "custom") {
      // Custom = a list of named endpoints (the ONLY way to configure it). Each carries its own URL + key + model + payload.
      body.append(customAdvanced());
    } else {
      // API key (optional)
      body.append(section("API key", "globe"));
      const keyIn = h("input", { class: "input", type: "password", placeholder: ps.key ? "•••••••• (set — type to replace)" : "Paste an API key (optional)" });
      const saveKey = h("button", { class: "btn btn-primary", text: "Save", onclick: () => { if (!keyIn.value.trim()) return; s[p.keyField] = keyIn.value.trim(); atom.settings.set({ [p.keyField]: s[p.keyField] }).then(() => { toast("API key saved"); render(); }); } });
      const removeKey = ps.key ? h("button", { class: "btn btn-ghost", text: "Remove", onclick: () => { s[p.keyField] = ""; atom.settings.set({ [p.keyField]: "" }).then(() => { toast("API key removed"); render(); }); } }) : null;
      body.append(h("div", { class: "pm-row" }, keyIn, saveKey, removeKey));
    }

    // Codex web search — the thread's `web_search` config on every OpenAI turn. "" = Codex's own config.toml.
    if (p.id === "openai") {
      body.append(section("Web search", "globe"));
      const WS = ["live", "cached", "disabled", ""];
      const WS_LABEL = { live: "Live", cached: "Cached", disabled: "Off", "": "Codex default" };
      const raw = s.openaiWebSearch;
      const cur = raw === true ? "live" : raw === false ? "disabled" : (WS.includes(raw) || raw === "indexed") ? raw : "live";
      body.append(segmented(WS, cur, (v) => { s.openaiWebSearch = v; atom.settings.set({ openaiWebSearch: v }).then(() => toast("Codex web search: " + WS_LABEL[v])); }, WS_LABEL));
      body.append(h("div", { class: "hint", text: "Live fetches current pages. Cached answers from Codex's search cache (fast, can be stale). Off blocks web search for the model. Codex default leaves ~/.codex/config.toml in charge. Managed Codex requirements can narrow this — the nearest allowed mode is used." }));
      // Reasoning summaries (the Codex "thinking" cards): an explicit choice, or the Codex default — never forced.
      body.append(section("Reasoning summaries", "brain"));
      const RS = ["", "auto", "concise", "detailed", "none"];
      const RS_LABEL = { "": "Codex default", auto: "Auto", concise: "Concise", detailed: "Detailed", none: "Off" };
      const curRs = RS.includes(s.codexReasoningSummary) ? s.codexReasoningSummary : "";
      body.append(segmented(RS, curRs, (v) => { s.codexReasoningSummary = v; atom.settings.set({ codexReasoningSummary: v }).then(() => toast("Codex reasoning summaries: " + RS_LABEL[v])); }, RS_LABEL));
      body.append(h("div", { class: "hint", text: "Codex shows a summary of its reasoning, not the raw reasoning. Sent as the thread's model_reasoning_summary only when you pick a value here." }));
      // The account the Codex runtime is ACTUALLY using (read from the runtime, not a label).
      const acctRow = h("div", { class: "hint", text: "Effective Codex account: reading…" });
      body.append(acctRow);
      atom.codex.account().then((a) => { acctRow.textContent = a && a.type ? `Effective Codex account (runtime): ${a.type}${a.email ? " · " + a.email : ""}${a.planType ? " · " + a.planType : ""}${s.openaiApiKey ? "  (API-key context)" : ""}` : (a && a.error ? "Effective Codex account: unavailable — " + a.error : "Effective Codex account: not signed in"); }).catch(() => { acctRow.textContent = "Effective Codex account: unavailable"; });
    }

    // make primary
    if (canPrimary && !isPrimary) {
      body.append(h("button", { class: "btn btn-ghost pm-primary", html: `${icon("check", 14)}<span>Make ${firstWord} the primary</span>`, onclick: () => { setSharedSetting("llmProvider", p.id); loadProviderModels(p.id); toast(`${firstWord} is now the primary`); render(); } }));
    }
    const note = p.id === "openai" ? "OpenAI runs the primary turn via the Codex SDK — live streaming, tool cards, and thread resume." : p.id === "google" ? "Antigravity (agy) was removed from this build." : "Runs the primary turn directly.";
    body.append(h("div", { class: "hint", text: note }));
    if (onChange) onChange();   // keep the underlying card live
  }

  const epList = () => Array.isArray(s.customEndpoints) ? s.customEndpoints : [];
  const saveEndpoints = (list) => {
    s.customEndpoints = list; atom.settings.set({ customEndpoints: list });
    if ((s.llmProvider || "anthropic") === "custom") loadProviderModels("custom");
  };

  function customAdvanced() {
    // One-time migration: fold any legacy single base-URL/key config into a named endpoint so nothing is lost.
    if (!epList().length && (s.customApiBaseUrl || s.customEndpoint)) {
      const legacy = {
        id: "custom-default", name: "Custom endpoint",
        endpoint: s.customEndpoint || s.customApiBaseUrl || "",
        apiKey: s.customApiKey || "", model: s.defaultModel && !/claude|gpt|gemini/i.test(s.defaultModel) ? s.defaultModel : "",
        headers: s.customHeaders || "Authorization: Bearer {{apiKey}}",
        payloadTemplate: s.customPayloadTemplate || CUSTOM_PRESETS.openai.payload,
        outputPath: s.customOutputPath || "choices[0].message.content",
      };
      saveEndpoints([legacy]);
    }

    const wrap = h("div", { class: "cust-adv" });
    wrap.append(section("Custom API endpoints", "cpu"));

    if (custEdit) { wrap.append(endpointEditor(custEdit)); return wrap; }

    // Endpoint list — each one is a selectable "model" for the Custom provider.
    const list = epList();
    if (!list.length) {
      wrap.append(h("div", { class: "hint", text: "Add one or more named API endpoints (e.g. \"Test Local LLM 5.3\"). Each becomes a selectable model when Custom is the provider — point it at any OpenAI-, Gemini- or custom-shaped API." }));
    } else {
      const rows = h("div", { class: "cust-ep-list" });
      for (const ep of list) {
        const isSel = (s.llmProvider || "anthropic") === "custom" && s.defaultModel === ep.id;
        rows.append(h("div", { class: "cust-ep-row" + (isSel ? " selected" : ""), title: "Edit this endpoint", onclick: () => { custEdit = { ...ep }; render(); } },
          h("span", { class: "cust-ep-ic", html: icon("globe", 14) }),
          h("div", { class: "cust-ep-meta" },
            h("div", { class: "cust-ep-name" }, h("span", { text: ep.name || ep.id }), isSel ? h("span", { class: "cust-ep-badge", text: "selected" }) : null),
            h("div", { class: "cust-ep-url", text: ep.endpoint || "(no URL)" })),
          h("button", { class: "cust-ep-act", title: "Edit endpoint", html: icon("edit", 14), onclick: (e) => { e.stopPropagation(); custEdit = { ...ep }; render(); } }),
          h("button", { class: "cust-ep-act", title: "Duplicate (copies the token too)", html: icon("copy", 14), onclick: (e) => {
            e.stopPropagation();
            custEdit = { ...ep, id: "", name: (ep.name || ep.id) + " copy" };   // clone EVERYTHING incl. the apiKey into a new draft
            render();
          } }),
          h("button", { class: "cust-ep-act danger", title: "Delete endpoint", html: icon("trash", 14), onclick: (e) => {
            e.stopPropagation();
            confirmDialog({ title: "Delete endpoint", message: `Delete the endpoint “${ep.name || ep.id}”?`, confirmLabel: "Delete", danger: true, onConfirm: () => {
              saveEndpoints(epList().filter((x) => x.id !== ep.id)); toast("Endpoint removed"); render();
            } });
          } })));
      }
      wrap.append(rows);
    }
    wrap.append(h("button", { class: "btn btn-primary cust-ep-add", html: `${icon("plus", 14)}<span>Add endpoint</span>`,
      onclick: () => { custEdit = { id: "", name: "", endpoint: "", apiKey: "", model: "", headers: "", payloadTemplate: "", outputPath: "" }; render(); } }));
    return wrap;
  }

  // Inline editor for a single endpoint (add or edit), with presets + live Test.
  function endpointEditor(ep) {
    const wrap = h("div", { class: "cust-editor" });
    const isNew = !ep.id;

    const name = h("input", { class: "input", placeholder: "Name (e.g. Test Local LLM 5.3)", value: ep.name || "" });
    wrap.append(field("Name", name));

    const presetRow = h("div", { class: "cust-presets" }, h("span", { class: "cust-presets-l", text: "Quick start:" }));
    for (const key of ["openai", "anthropic", "gemini"]) {
      const pr = CUSTOM_PRESETS[key];
      presetRow.append(h("button", { class: "btn btn-ghost btn-sm", text: pr.label, onclick: () => {
        headers.value = pr.headers; payload.value = pr.payload; outPath.value = pr.output; toast(pr.label + " template loaded");
      } }));
    }
    wrap.append(presetRow);

    const endpoint = h("input", { class: "input", placeholder: "https://api.example.com/v1/chat/completions", value: ep.endpoint || "" });
    wrap.append(field("Endpoint URL", endpoint));

    const keyIn = h("input", { class: "input", type: "password", placeholder: ep.apiKey ? "•••••••• (set — type to replace)" : "API key (optional)" });
    const modelIn = h("input", { class: "input cust-code", placeholder: "model id sent as {{model}} (e.g. llama-5.3)", value: ep.model || "" });
    wrap.append(h("div", { class: "cust-two" }, field("API key", keyIn), field("Model ({{model}})", modelIn)));

    const headers = h("textarea", { class: "input cust-ta", rows: "2", spellcheck: "false", placeholder: "Authorization: Bearer {{apiKey}}" });
    headers.value = ep.headers || "";
    wrap.append(field("Headers — one per line, {{apiKey}} substituted", headers));

    const payload = h("textarea", { class: "input cust-ta cust-code", rows: "7", spellcheck: "false", placeholder: '{ "model": "{{model}}", "messages": [ { "role": "user", "content": "{{prompt}}" } ] }' });
    payload.value = ep.payloadTemplate || "";
    wrap.append(field("Request payload — JSON template ({{prompt}} · {{system}} · {{model}})", payload));

    // Warn (+ one-click fix) when the payload has no {{prompt}} — otherwise every turn sends the same hardcoded text.
    const autofixBtn = h("button", { class: "btn btn-sm cust-autofix", text: "Insert {{prompt}} automatically", onclick: () => {
      const fixed = autofixPayload(payload.value);
      if (fixed) { payload.value = fixed; checkPayload(); toast("Payload now uses {{prompt}} / {{system}}", "check"); }
      else toast("Couldn't auto-insert — put {{prompt}} where the user message text goes", "alert");
    } });
    const payloadWarn = h("div", { class: "cust-warn hidden" },
      h("span", { html: icon("alert", 13) }),
      h("span", { text: "No {{prompt}} placeholder — every turn would send the same text. Replace the user message with {{prompt}}." }),
      autofixBtn);
    wrap.append(payloadWarn);
    const checkPayload = () => { payloadWarn.classList.toggle("hidden", /\{\{\s*prompt\s*\}\}/.test(payload.value)); };
    payload.addEventListener("input", checkPayload);
    checkPayload();

    const outPath = h("input", { class: "input cust-code", placeholder: "choices[0].message.content", value: ep.outputPath || "" });
    wrap.append(field("Output path — where the reply text lives in the response", outPath));

    // Test
    const result = h("div", { class: "cust-test-result" });
    const testBtn = h("button", { class: "btn btn-ghost", html: `${icon("send", 14)}<span>Test</span>`, onclick: async () => {
      if (!endpoint.value.trim()) { toast("Enter an endpoint URL first", "alert"); return; }
      result.innerHTML = ""; result.append(h("div", { class: "cust-test-loading" }, h("span", { html: icon("spinner", 14) }), h("span", { text: "Sending a test prompt…" })));
      let r; try {
        r = await atom.providers.testCustom({ endpoint: endpoint.value.trim(), headers: headers.value, payloadTemplate: payload.value, outputPath: outPath.value.trim(),
          model: modelIn.value.trim(), apiKey: keyIn.value.trim() || ep.apiKey || "", prompt: "Reply with the single word: pong" });
      } catch (e) { result.innerHTML = ""; result.append(h("div", { class: "cust-test-err", text: String((e && e.message) || e) })); return; }
      renderTestResult(r);
    } });
    wrap.append(h("div", { class: "pm-row" }, testBtn, h("span", { class: "hint", style: "margin:0", text: "Sends one sample prompt; click a detected key to set the output path." })));
    wrap.append(result);

    // Save / Cancel
    const saveBtn = h("button", { class: "btn btn-primary", text: isNew ? "Add endpoint" : "Save", onclick: () => {
      const nm = name.value.trim();
      if (!nm) { toast("Name the endpoint first", "alert"); return; }
      if (!endpoint.value.trim()) { toast("Enter an endpoint URL", "alert"); return; }
      const list = epList().slice();
      const id = ep.id || (slugifyEp(nm) + "-" + Math.random().toString(36).slice(2, 6));
      const next = { id, name: nm, endpoint: endpoint.value.trim(),
        apiKey: keyIn.value.trim() || ep.apiKey || "", model: modelIn.value.trim(),
        headers: headers.value, payloadTemplate: payload.value, outputPath: outPath.value.trim() };
      const idx = list.findIndex((e) => e.id === id);
      if (idx >= 0) list[idx] = next; else list.push(next);
      saveEndpoints(list);
      custEdit = null; toast(isNew ? "Endpoint added" : "Endpoint saved"); render();
    } });
    const cancelBtn = h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => { custEdit = null; render(); } });
    wrap.append(h("div", { class: "pm-row cust-editor-foot" }, h("div", { class: "spacer" }), cancelBtn, saveBtn));

    function renderTestResult(r) {
      result.innerHTML = "";
      const okExtract = r.ok && r.text;
      result.append(h("div", { class: "cust-test-head" },
        h("span", { class: "status-pill " + (r.status >= 200 && r.status < 300 ? "ok" : "bad") }, h("span", { class: "dot" }), r.status ? ("HTTP " + r.status) : "No response"),
        okExtract ? h("span", { class: "cust-test-ok", text: r.usedPath ? ("captured via " + r.usedPath) : "captured" }) : null));
      if (r.error && !okExtract) result.append(h("div", { class: "cust-test-err", text: r.error }));
      if (okExtract) {
        result.append(h("div", { class: "cust-test-label", text: "Captured output" }));
        result.append(h("div", { class: "cust-test-output", text: r.text.length > 600 ? r.text.slice(0, 600) + "…" : r.text }));
      }
      if (r.candidates && r.candidates.length) {
        result.append(h("div", { class: "cust-test-label", text: "Detected text keys — click to use as the output path" }));
        const chips = h("div", { class: "cust-keys" });
        for (const c of r.candidates.slice(0, 12)) {
          chips.append(h("button", { class: "cust-key" + (c.path === outPath.value.trim() ? " active" : ""), title: c.sample,
            onclick: () => { outPath.value = c.path; renderTestResult(r); toast("Output path set to " + c.path); } },
            h("span", { class: "cust-key-path", text: c.path }),
            h("span", { class: "cust-key-sample", text: c.sample })));
        }
        result.append(chips);
      }
      if (r.raw) {
        const pre = h("pre", { class: "cust-test-raw", text: prettyJson(r.raw) });
        result.append(h("details", { class: "cust-test-details" }, h("summary", { text: "Raw response" }), pre));
      }
    }
    function prettyJson(str) { try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; } }

    return wrap;
  }

  await render();
  backRef = modalShell({ title: p.name, ic: p.icon || "globe", body, footer: [h("button", { class: "btn btn-primary", text: "Done", onclick: () => closeModal(backRef) })] });
}
