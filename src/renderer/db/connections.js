/* AtomNano renderer — Database Manager — the error card (driver install offer) and the connection form (edits a deep copy; secrets kept / cleared / revealed explicitly; TLS verify by default).
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { bumpGen } from "./health.js";
import { activeTabId, atom, conns, connStatus, D, desired, h, icon, kindOf, kinds, setConns, setKinds, tabsOf, toast, wsHost } from "./state.js";
import { pendingCount } from "./structure.js";
import { errMsg } from "./utils.js";
import { disposeTab, hideAllWs, openInTab, switchTab } from "./workspace.js";

// Error card. A missing driver gets an Install button; extra actions can be added.
export const errBanner = (e, kind, { onInstalled, extra } = {}) => {
  const msg = errMsg(e), type = (e && e.type) || "";
  const isPolicy = type === "policy" || /^Policy:/.test(msg);
  const isConn = type === "transport" || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(msg);
  const isAuth = type === "auth" || /Access denied|authentication|password|login failed|ER_ACCESS/i.test(msg);
  const isUnknown = type === "outcome-unknown";
  const wrap = h("div", { class: "dbm-err" + (isPolicy ? " dbm-policy-block" : "") + (isUnknown ? " dbm-unknown" : "") },
    h("span", { html: icon("alert", 13) }),
    h("div", { class: "dbm-err-body" }, h("span", { text: msg }),
      isUnknown ? h("span", { class: "dbm-err-hint", text: "Do not re-run blindly: check whether the change is present first." }) : null,
      isConn ? h("span", { class: "dbm-err-hint", text: "Server not reachable — is it running, and are host/port right?" }) : null,
      isAuth ? h("span", { class: "dbm-err-hint", text: "Check the user, password and database on this connection." }) : null,
      e && e.hint ? h("span", { class: "dbm-err-hint", text: e.hint }) : null,
      type ? h("span", { class: "dbm-err-type", text: type }) : null));
  const m = msg.match(/Driver "([^"]+)" is not installed/);
  const acts = h("div", { class: "dbm-err-acts" });
  if (m && kind) acts.append(h("button", { class: "btn btn-primary btn-sm", text: `Install ${m[1]}`, onclick: async (ev) => {
    const b = ev.currentTarget; b.disabled = true; b.innerHTML = '<span class="dbm-spinner"></span> Installing…';
    const note = h("span", { class: "dbm-err-hint", text: "Downloading with npm — usually 10–60 s." }); acts.append(note);
    const r = await atom().db.installDriver(kind).catch((x) => ({ ok: false, detail: x.message }));
    note.remove();
    toast(r.ok ? "Driver installed and loaded ✓" + (r.version ? " · " + r.version : "") : `Install ${r.state || "failed"}: ${r.detail || ""}`, r.ok ? "check" : "alert", { ms: r.ok ? 3500 : 8000 });
    setKinds(await atom().db.kinds().catch(() => kinds));
    if (r.ok && onInstalled) onInstalled(); else { b.disabled = false; b.textContent = `Install ${m[1]}`; }
  } }));
  for (const a of extra || []) acts.append(a);
  if (acts.childNodes.length) wrap.append(acts);
  return wrap;
};
/* ============================================================
   CONNECTION FORM — edits a DEEP COPY; Cancel changes nothing
   ============================================================ */
export const drawConnForm = (existing, defaults = {}) => {
  const src = existing ? structuredClone(existing) : structuredClone(defaults);
  const c = Object.assign({ kind: "mysql", name: "", host: "localhost", port: "", user: "", database: "", file: "", ssl: false, sslMode: "verify", sslCa: "", createIfMissing: false, readOnly: false }, src);
  c.policy = structuredClone(c.policy || {});
  // secret fields: undefined = keep what's stored; "" = clear; string = replace
  const secret = { password: undefined, uri: undefined };
  hideAllWs();
  const fields = h("div", { class: "dbm-form-fields" });
  const inp = (key, label, type = "text", ph = "") => {
    const i = h("input", { class: "input", type, value: c[key] !== undefined && c[key] !== null ? String(c[key]) : "", placeholder: ph, autocomplete: "off", spellcheck: "false", "aria-label": label });
    i.oninput = () => { c[key] = i.value; }; return h("label", { class: "dbm-field" }, h("span", { text: label }), i);
  };
  const secretField = (key, label, ph) => {
    const has = key === "password" ? !!c.hasPassword : !!c.hasUri;
    const locked = !!(c.secretLocked && c.secretLocked[key]);
    const i = h("input", { class: "input", type: key === "password" ? "password" : "text", value: "", placeholder: has ? (locked ? "saved value can't be decrypted here — enter it again" : "•••••• (saved — leave empty to keep)") : ph, autocomplete: "off", spellcheck: "false", "aria-label": label });
    i.oninput = () => { secret[key] = i.value; };
    const acts = h("span", { class: "dbm-secret-acts" });
    if (has && !locked && c.id) acts.append(h("button", { class: "dbm-mini dbm-eye", html: icon("eye", 13), title: "Reveal the saved value (explicit request)", "aria-label": "Reveal saved value", onclick: async (e) => { e.preventDefault(); try { const r = await atom().db.revealSecret(c.id, key); i.value = r.value; i.type = "text"; secret[key] = r.value; } catch (err) { toast(errMsg(err), "alert"); } } }));
    if (key === "password") acts.append(h("button", { class: "dbm-mini dbm-eye", html: icon("eye", 13), title: "Show / hide", "aria-label": "Show or hide", onclick: (e) => { e.preventDefault(); i.type = i.type === "password" ? "text" : "password"; } }));
    if (has) acts.append(h("button", { class: "dbm-mini", html: icon("x", 12), title: `Clear the saved ${key}`, "aria-label": `Clear saved ${key}`, onclick: (e) => { e.preventDefault(); secret[key] = ""; i.value = ""; i.placeholder = "(will be cleared)"; } }));
    const l = h("label", { class: "dbm-field dbm-pw-field" }, h("span", { text: label }), i, acts);
    if (locked) l.append(h("span", { class: "dbm-err-hint", text: "The stored value was encrypted by another OS account or machine and stays intact until you replace it." }));
    return l;
  };
  const kindSel = h("select", { class: "input", "aria-label": "Engine" });
  for (const k of kinds) kindSel.append(h("option", { value: k.id, text: k.name + (k.installed ? "" : " (driver not installed)") }));
  kindSel.value = c.kind; kindSel.onchange = () => { c.kind = kindSel.value; c.port = ""; drawF(); drawPolicy(); };
  function drawF() {
    const k = kindOf(c.kind); fields.innerHTML = "";
    if (!c.port) c.port = k.port || "";
    fields.append(inp("name", "Name", "text", k.name + " connection"));
    let pendH = false;
    for (const f of k.fields) {
      if (f === "host") { pendH = true; continue; }
      if (f === "port") {
        const hIn = h("input", { class: "input", type: "text", value: c.host || "localhost", autocomplete: "off", "aria-label": "Host" }); hIn.oninput = () => { c.host = hIn.value; };
        const pIn = h("input", { class: "input dbm-port-in", type: "number", value: c.port || k.port || "", placeholder: String(k.port || ""), "aria-label": "Port" }); pIn.oninput = () => { c.port = pIn.value; };
        if (pendH) fields.append(h("div", { class: "dbm-host-port" }, h("label", { class: "dbm-field dbm-host-f" }, h("span", { text: "Host" }), hIn), h("label", { class: "dbm-field dbm-port-f" }, h("span", { text: "Port" }), pIn)));
        else fields.append(h("label", { class: "dbm-field" }, h("span", { text: "Port" }), pIn));
        pendH = false; continue;
      }
      if (f === "user") { fields.append(inp("user", "User")); continue; }
      if (f === "password") { fields.append(secretField("password", "Password", "")); continue; }
      if (f === "database") { fields.append(inp("database", k.dbLabel || "Database")); continue; }
      if (f === "uri") { fields.append(secretField("uri", "Connection URI", k.uriPlaceholder)); continue; }
      if (f === "file") {
        fields.append(inp("file", "Database file path", "text", "C:\\data\\app.db"));
        const cb = h("input", { type: "checkbox" }); cb.checked = !!c.createIfMissing; cb.onchange = () => { c.createIfMissing = cb.checked; };
        const ro = h("input", { type: "checkbox" }); ro.checked = !!c.readOnly; ro.onchange = () => { c.readOnly = ro.checked; };
        fields.append(h("label", { class: "dbm-field dbm-ssl-row" }, cb, h("span", { text: "Create the file if it doesn't exist (otherwise opening a missing file is an error)" })), h("label", { class: "dbm-field dbm-ssl-row" }, ro, h("span", { text: "Open read-only" })));
        continue;
      }
    }
    if (k.tls) {
      const cb = h("input", { type: "checkbox" }); cb.checked = !!c.ssl;
      const mode = h("select", { class: "input", "aria-label": "Certificate verification" }, h("option", { value: "verify", text: "Verify the server certificate and host name (recommended)" }), h("option", { value: "insecure", text: "Encrypt only — trust ANY certificate (insecure: no server authentication)" }));
      mode.value = c.sslMode === "insecure" ? "insecure" : "verify"; mode.onchange = () => { c.sslMode = mode.value; syncTls(); };
      const ca = h("input", { class: "input", type: "text", value: c.sslCa || "", placeholder: "optional: path to a CA certificate (PEM)", "aria-label": "CA certificate file" }); ca.oninput = () => { c.sslCa = ca.value; };
      const sn = h("input", { class: "input", type: "text", value: c.sslServerName || "", placeholder: "optional: expected server name (SNI)", "aria-label": "Server name" }); sn.oninput = () => { c.sslServerName = sn.value; };
      const tlsBox = h("div", { class: "dbm-tls-box" }, h("label", { class: "dbm-field" }, h("span", { text: "Certificate check" }), mode), h("label", { class: "dbm-field" }, h("span", { text: "CA certificate" }), ca), c.kind === "mssql" ? null : h("label", { class: "dbm-field" }, h("span", { text: "Server name" }), sn), h("div", { class: "dbm-form-hint dbm-tls-warn", text: "" }));
      const syncTls = () => { tlsBox.style.display = c.ssl ? "" : "none"; const w = tlsBox.querySelector(".dbm-tls-warn"); w.textContent = c.sslMode === "insecure" ? "⚠ Insecure: the connection is encrypted but the server is NOT authenticated — a man-in-the-middle can read it." : "The server certificate must be valid for the host name (or signed by the CA file)."; w.classList.toggle("dbm-bad", c.sslMode === "insecure"); };
      cb.onchange = () => { c.ssl = cb.checked; syncTls(); };
      fields.append(h("label", { class: "dbm-field dbm-ssl-row" }, cb, h("span", { text: c.kind === "mssql" ? "Encrypt (TLS)" : "Use SSL / TLS" })), tlsBox);
      syncTls();
    }
  }
  drawF();
  const policyBody = h("div", { class: "dbm-policy-body" });
  const mkPCb = (key, label) => { const cb = h("input", { type: "checkbox" }); cb.checked = !!c.policy[key]; cb.onchange = () => { c.policy[key] = cb.checked; }; return h("label", { class: "dbm-policy-row" }, cb, h("span", { text: label })); };
  function drawPolicy() {
    const allowed = new Set(kindOf(c.kind).policies || []);
    policyBody.innerHTML = "";
    const isRedis = c.kind === "redis", isMongo = c.kind === "mongodb";
    if (allowed.has("blockDrop")) policyBody.append(mkPCb("blockDrop", isRedis ? "Block DEL / UNLINK / FLUSH*" : isMongo ? "Block drop (collections, indexes, databases)" : "Block DROP statements"));
    if (allowed.has("blockTruncate")) policyBody.append(mkPCb("blockTruncate", isRedis ? "Block FLUSHDB / FLUSHALL" : isMongo ? "Block emptying collections (drop / deleteMany)" : "Block TRUNCATE"));
    if (allowed.has("blockWrite")) policyBody.append(mkPCb("blockWrite", isRedis ? "Block every write and admin command (read-only)" : isMongo ? "Block writes — insert / update / delete / $out / $merge (also disables inline editing)" : "Block writes — INSERT / UPDATE / DELETE / MERGE, writable CTEs, procedures (also disables inline editing)"));
    if (allowed.has("blockDDL")) policyBody.append(mkPCb("blockDDL", isRedis ? "Block admin commands (CONFIG, SCRIPT, …)" : isMongo ? "Block schema/index changes and admin commands" : "Block all DDL and procedure calls"));
    if (allowed.has("protectedTables")) {
      const ptIn = h("input", { class: "input dbm-policy-tables", type: "text", value: (c.policy.protectedTables || []).join(", "), placeholder: isRedis ? "exact key names, e.g. config:main, session:*" : "users, payments, sales.orders", "aria-label": "Protected objects" });
      ptIn.oninput = () => { c.policy.protectedTables = ptIn.value.split(",").map((s) => s.trim()).filter(Boolean); };
      policyBody.append(h("label", { class: "dbm-field", style: "margin-top:6px" }, h("span", { text: isRedis ? "Protected keys (read-only):" : `Protected ${isMongo ? "collections" : "tables"} (read-only, schema-qualified names allowed):` }), ptIn));
    }
    policyBody.append(h("div", { class: "dbm-form-hint", text: "These are application-side protections enforced by AtomNano on every statement it sends, including CTE bodies, procedure calls and imports. They are not a substitute for database permissions." }));
  }
  drawPolicy();
  const policyEl = h("details", { class: "dbm-policy-section" }, h("summary", { class: "dbm-policy-summary" }, h("span", { html: icon("shield", 13) }), h("span", { text: "Security policies" })), policyBody);
  if (Object.values(c.policy).some((v) => (Array.isArray(v) ? v.length : v))) policyEl.open = true;
  const status = h("div", { class: "dbm-form-status", role: "status" });
  const installBtnFn = (kind, pkg) => h("button", { class: "btn btn-primary btn-sm", style: "margin-left:8px", text: `Install ${pkg}`, onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Installing…";
    const r = await atom().db.installDriver(kind).catch((x) => ({ ok: false, detail: x.message }));
    toast(r.ok ? "Driver installed and loaded ✓ — test again" : `Install ${r.state || "failed"}: ${r.detail || ""}`, r.ok ? "check" : "alert", { ms: 7000 });
    b.disabled = false; b.textContent = `Install ${pkg}`; setKinds(await atom().db.kinds().catch(() => kinds));
  } });
  const payload = () => { const out = { ...c }; for (const k of ["hasPassword", "hasUri", "secretLocked", "legacyPlaintext", "sessionSecret"]) delete out[k]; for (const f of ["password", "uri"]) { if (secret[f] === undefined) { if (c.id) out[f] = { $keep: true }; else delete out[f]; } else out[f] = secret[f]; } if (out.policy && !Object.values(out.policy).some((v) => (Array.isArray(v) ? v.length : v))) out.policy = {}; return out; };
  let saving = false;
  const secretUnavailable = async (err, saved) => {
    // OS secure storage is unavailable: offer a session-only credential (memory) instead of plaintext
    const choice = await D.chooseDialog({ title: "Secure storage unavailable", ic: "alert", message: `${err.message}\n\nThe connection can be saved WITHOUT the secret and use it for this app session only (you will enter it again after a restart).`, choices: [{ label: "Save without secret, use it this session", value: "session", primary: true }, { label: "Cancel", value: null }] });
    if (choice !== "session") return null;
    const p = payload(); const fields = {}; for (const f of ["password", "uri"]) { if (typeof secret[f] === "string" && secret[f]) { fields[f] = secret[f]; p[f] = ""; } }
    const s2 = await atom().db.save(p);
    await atom().db.setSessionSecret(s2.id, fields);
    return s2;
  };
  const formEl = h("div", { class: "dbm-form-ws", role: "form", "aria-label": existing && existing.id ? "Edit connection" : "New connection" },
    h("div", { class: "dbm-form" },
      h("div", { class: "dbm-form-title", text: existing && existing.id ? "Edit connection" : "New connection" }),
      h("label", { class: "dbm-field" }, h("span", { text: "Engine" }), kindSel),
      fields, policyEl, status,
      h("div", { class: "dbm-form-hint", text: kinds.length && kinds[0].secureStorage === false ? "⚠ OS credential encryption is unavailable on this system — secrets cannot be saved to disk (a session-only credential is offered instead)." : "Passwords and URIs are encrypted at rest with the OS credential store and never sent to the UI unless you reveal them." }),
      h("div", { class: "dbm-form-actions" },
        h("button", { class: "btn btn-ghost", text: "Cancel", onclick: () => { formEl.remove(); switchTab(activeTabId); } }),
        h("button", { class: "btn btn-ghost", text: "Test connection", onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; status.innerHTML = ""; status.append(h("span", { class: "dbm-dim", text: "Connecting…" }));
          const r = await atom().db.test({ ...payload(), id: c.id || "" }).catch((x) => ({ ok: false, detail: x.message, type: x.type }));
          status.innerHTML = "";
          if (r.ok) status.append(h("span", { class: "dbm-ok", text: `Connected ✓  (${r.ms} ms)` }));
          else { status.append(h("span", { class: "dbm-bad", text: `${r.type ? `[${r.type}] ` : ""}${r.detail || "Failed"}` })); if (r.hint) status.append(h("div", { class: "dbm-err-hint", text: r.hint })); if (r.driverMissing) status.append(installBtnFn(c.kind, r.driverMissing)); }
          b.disabled = false;
        } }),
        h("button", { class: "btn btn-primary", text: existing && existing.id ? "Save" : "Save & connect", onclick: async (e) => {
          if (saving) return; saving = true; const b = e.currentTarget; b.disabled = true;
          try {
            if (!c.name) c.name = (kindOf(c.kind).name || "DB") + (c.database ? " · " + c.database : c.file ? " · " + c.file.split(/[\\/]/).pop() : "");
            let saved;
            try { saved = await atom().db.save(payload()); }
            catch (x) { if (x.type === "secret-unavailable") saved = await secretUnavailable(x); else throw x; }
            if (!saved) return;
            setConns(await atom().db.list().catch(() => conns));
            toast("Connection saved ✓", "check");
            formEl.remove();
            // tabs on this connection: new revision → sessions/pending plans of the OLD configuration are dropped explicitly
            for (const t of tabsOf(saved.id)) { const hadPending = [...t.pendingByTable.values()].some((p) => pendingCount(p) > 0); await disposeTab(t); t.conn = conns.find((x) => x.id === saved.id) || saved; t.schema = null; t.struct.clear(); t.pendingByTable.clear(); if (hadPending) toast("Pending schema changes were discarded because the connection changed.", "alert", { ms: 5000 }); }
            desired.set(saved.id, "on"); bumpGen(saved.id); connStatus.delete(saved.id);
            openInTab(conns.find((x) => x.id === saved.id) || saved);
          } catch (x) { toast(`Save failed${x.type ? ` (${x.type})` : ""}: ${errMsg(x)}`, "alert", { ms: 8000 }); status.innerHTML = ""; status.append(h("span", { class: "dbm-bad", text: errMsg(x) }), x.hint ? h("div", { class: "dbm-err-hint", text: x.hint }) : null); }
          finally { saving = false; b.disabled = false; }
        } }))));
  wsHost.append(formEl);
  const first = formEl.querySelector("input"); if (first) setTimeout(() => first.focus(), 30);
};
