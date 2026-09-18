/* AtomNano renderer — the Settings modal shell: grouped categories on the left, a search box
 * that finds any setting across them, and the active category's rows on the right. Each
 * category lives in its own module and returns { id, label, ic, group, blurb, items() }.
 * Also the DBM wrapper (the Database Manager borrows the app helpers through it). */
import { closeModal, h, modalShell, promptDialog, showContextMenu, toast } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { mountDbManager } from "../db/index.js";
import { icon } from "../icons.js";
import { chooseDialog } from "../workspace/projects.js";
import { agentCategory, agentsCategory, sdkCategory } from "./agent.js";
import { appearanceCategory } from "./appearance.js";
import { section } from "./controls.js";
import { editorCategory } from "./editor.js";
import { integrationsCategory } from "./integrations.js";
import { providersCategory } from "./providers.js";
import { storageCategory } from "./storage.js";

export { checkUpdatesAndChip } from "./updates.js";
export { openProviderModal } from "./provider-modal.js";
export { openMcpEditor } from "./mcp.js";
export { field, inlineSelect, section, segmented, toggle } from "./controls.js";

/* ============================================================
   DBM — DATABASE MANAGER
   ============================================================ */
// The Database Manager lives in db/ (virtualised object list + result grids,
// Browse / Structure / Query modes). This wrapper hands it the app helpers it borrows.
export async function openDbManagerFull(mountEl) {
  return mountDbManager(mountEl, { h, icon, toast, atom, showContextMenu, chooseDialog, promptDialog, modalShell, closeModal });
}

const GROUPS = ["Model", "Workspace", "System"];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ============================================================
   SETTINGS MODAL
   ============================================================ */
export async function openSettings(initialCat) {
  const s = state.settings;
  const auth = await atom.auth.status().catch(() => ({ loggedIn: false, cliFound: false }));
  const info = await atom.app.info().catch(() => ({ version: "?" }));
  const ctx = { s, auth, info, isMac: state.platform === "darwin" };
  const CATS = [providersCategory(ctx), agentCategory(ctx), agentsCategory(ctx), sdkCategory(ctx), appearanceCategory(ctx), editorCategory(ctx), integrationsCategory(ctx), storageCategory(ctx)];

  // Each category builds its rows once; they keep their live state while you switch pages or search.
  const built = new Map();
  const itemsOf = (c) => { if (!built.has(c.id)) built.set(c.id, c.items()); return built.get(c.id); };
  const fieldsOf = (c) => itemsOf(c).filter((el) => el.classList && el.classList.contains("field"));
  let activeCat = CATS.some((c) => c.id === initialCat) ? initialCat : CATS[0].id;
  let query = "";
  const words = () => query.split(/\s+/).filter(Boolean);
  const hit = (el) => { const t = ((el.textContent || "") + " " + (el.dataset.keywords || "")).toLowerCase(); return words().every((w) => t.includes(w)); };
  // Highlight the query inside a row's label (plain text again when the query clears).
  function hlLabel(fieldEl) {
    const lab = fieldEl.querySelector(":scope > label"); if (!lab) return;
    if (lab.dataset.t === undefined) lab.dataset.t = lab.textContent;
    const t = lab.dataset.t; lab.textContent = "";
    if (!query) { lab.textContent = t; return; }
    const re = new RegExp(words().map(esc).join("|"), "gi"); let last = 0, m;
    while ((m = re.exec(t))) { if (!m[0]) { re.lastIndex++; continue; } if (m.index > last) lab.append(t.slice(last, m.index)); lab.append(h("mark", { class: "st-hl", text: m[0] })); last = m.index + m[0].length; }
    if (last < t.length) lab.append(t.slice(last));
  }

  const stNav = h("div", { class: "st-nav" });
  const stContent = h("div", { class: "st-content" });
  const searchIn = h("input", { type: "search", placeholder: "Search settings", "aria-label": "Search settings", spellcheck: "false", autocomplete: "off" });
  const clearBtn = h("button", { class: "st-search-clear hidden", title: "Clear", html: icon("close", 12), onclick: () => { searchIn.value = ""; setQuery(""); searchIn.focus(); } });
  const search = h("div", { class: "st-search" }, h("span", { class: "st-search-ic", html: icon("search", 13) }), searchIn, clearBtn);
  searchIn.addEventListener("input", () => setQuery(searchIn.value));
  searchIn.addEventListener("keydown", (e) => { if (e.key === "Escape" && searchIn.value) { e.stopPropagation(); searchIn.value = ""; setQuery(""); } });
  function setQuery(q) { query = q.trim().toLowerCase(); clearBtn.classList.toggle("hidden", !query); draw(); }
  const openCat = (id) => { activeCat = id; if (query) { searchIn.value = ""; setQuery(""); } else draw(); };

  function draw() {
    stNav.innerHTML = ""; stNav.append(search);
    for (const g of GROUPS) {
      const cats = CATS.filter((c) => c.group === g); if (!cats.length) continue;
      stNav.append(h("div", { class: "st-group", text: g }));
      for (const c of cats) {
        const n = query ? fieldsOf(c).filter(hit).length : 0;
        stNav.append(h("button", { class: "st-cat" + (!query && c.id === activeCat ? " active" : "") + (query && !n ? " dim" : ""), dataset: { cat: c.id, label: c.label }, onclick: () => openCat(c.id) },
          h("span", { class: "st-cat-ic", html: icon(c.ic, 14) }), h("span", { class: "st-cat-label", text: c.label }), query && n ? h("span", { class: "st-cat-n", text: String(n) }) : null));
      }
    }
    stContent.innerHTML = "";
    if (query) {
      let total = 0;
      const list = h("div", {});
      for (const c of CATS) {
        const m = fieldsOf(c).filter(hit); if (!m.length) continue;
        total += m.length;
        const sec = section(c.label, c.ic); sec.classList.add("st-result-cat"); sec.title = `Open ${c.label}`; sec.onclick = () => openCat(c.id);
        list.append(sec);
        for (const el of m) { hlLabel(el); list.append(el); }
      }
      stContent.append(h("div", { class: "st-page-head" },
        h("h2", { text: total ? `${total} setting${total === 1 ? "" : "s"} match “${searchIn.value.trim()}”` : `Nothing matches “${searchIn.value.trim()}”` }),
        h("p", { text: total ? "Click a section title to open that page." : "Labels, descriptions and related terms are all searched — try another word." })), list);
      return;
    }
    const cat = CATS.find((c) => c.id === activeCat) || CATS[0];
    stContent.append(h("div", { class: "st-page-head" }, h("h2", { text: cat.label }), cat.blurb ? h("p", { text: cat.blurb }) : null));
    for (const el of itemsOf(cat)) { if (el.classList && el.classList.contains("field")) hlLabel(el); stContent.append(el); }
    stContent.scrollTop = 0;
  }
  draw();

  const done = h("button", { class: "btn btn-primary", text: "Done", onclick: () => closeModal(back) });
  const foot = [
    h("div", { class: "st-foot-meta" },
      h("span", { class: "st-ver", text: `AtomNano v${info.version || "?"}` }),
      info.userData ? h("button", { class: "st-link", text: info.portable ? "Portable data folder" : "Data folder", onclick: () => atom.shell.openExternal("file://" + info.userData.replace(/\\/g, "/")) }) : null),
    h("div", { class: "spacer" }), done];
  const back = modalShell({ title: "Settings", ic: "settings", wide: true, body: h("div", { class: "st-layout" }, stNav, stContent), footer: foot });
  const modal = back.querySelector(".modal"); if (modal) modal.classList.add("st-modal");
  return back;
}
