/* AtomNano renderer — Database Manager — connection status per connection (desired state + generation) and the health pinger; failures classified as fatal or transport.
 * One of the modules the former single dbm.js was split into (see db/index.js). */
import { renderBrowse } from "./browse.js";
import { loadSchema } from "./sidebar.js";
import { AT, atom, conns, connStatus, desired, disposers, healthTimer, icon, kindOf, setDot, setHealthTimer, side, statusGen, tabBar, tabs, tabsOf, toast } from "./state.js";
import { errMsg } from "./utils.js";
import { logAll, syncSessionBadge } from "./workspace.js";

/* ---- connection status: desired state + generation per connection ----
 * live | error | reconnecting | off. `desired` records what the USER asked for; an
 * in-flight health result from before a disconnect (older generation) is ignored. */
export const genOf = (id) => statusGen.get(id) || 0;
export const bumpGen = (id) => { statusGen.set(id, genOf(id) + 1); return genOf(id); };
export const statusTitle = (st) => st === "live" ? "Connected — click to disconnect" : st === "error" ? "Connection failed — click to retry" : st === "reconnecting" ? "Connection dropped — reconnecting automatically (click to stop)" : "Not connected — click to connect";
export const syncConnCards = () => {
  for (const el of side.querySelectorAll(".dbm-conn")) {
    const st = connStatus.get(el.dataset.id) || "off";
    el.classList.toggle("live", st === "live"); el.classList.toggle("error", st === "error"); el.classList.toggle("reconnecting", st === "reconnecting");
    const d = el.querySelector(".dbm-conn-dot"); if (d) { d.className = "dbm-conn-dot " + st; d.title = statusTitle(st); }
    const b = el.querySelector(".dbm-conn-act");
    if (b) { b.innerHTML = icon(st === "live" || st === "reconnecting" ? "wifiOff" : "wifi", 12); b.title = st === "live" ? "Disconnect" : st === "reconnecting" ? "Stop reconnecting" : st === "error" ? "Retry" : "Connect"; b.setAttribute("aria-label", b.title); b.dataset.live = st === "live" || st === "reconnecting" ? "1" : ""; }
    const s = el.querySelector(".dbm-conn-status"); if (s) s.textContent = st === "live" ? "connected" : st === "error" ? "failed" : st === "reconnecting" ? "reconnecting…" : "";
  }
  // every view of a connection (tab dots, toolbar dots) follows the one status
  for (const t of tabs) if (t.conn) { const live = connStatus.get(t.conn.id) === "live"; if (t.connLive !== live) { t.connLive = live; } const i = tabs.indexOf(t); const el = tabBar.querySelectorAll(".dbm-conn-tab")[i]; if (el) setDot(el.querySelector(".dbm-tab-dot-sm"), live); if (t.wsEl) setDot(t.wsEl.querySelector(".dbm-dot"), live); }
};
export const setConnStatus = (id, st, { gen } = {}) => { if (!id) return; if (gen != null && gen !== genOf(id)) return; connStatus.set(id, st); syncConnCards(); };

/* ------------------------------ HEALTH ------------------------------
 * Every 20 s (and when the network/window comes back) each live or dropped
 * connection is pinged IN PARALLEL on the shared handle. Results carry the status
 * generation they were started under: a disconnect in between wins. Auth / permission
 * failures become "error" (they never heal by waiting); transport failures "reconnecting". */
export const HEALTH_MS = 20000;
export const connLabel = (c) => c.name || kindOf(c.kind).name;
export const checkOne = async (c, eager) => {
  const st = connStatus.get(c.id);
  if (st !== "live" && st !== "reconnecting") return;
  if (desired.get(c.id) === "off") return;
  if (st === "reconnecting" && !navigator.onLine && !eager) return;
  const gen = genOf(c.id);
  let r; try { r = await atom().db.ping(c.id); } catch (e) { r = { ok: false, detail: e.message, type: e.type }; }
  if (gen !== genOf(c.id) || desired.get(c.id) === "off") return;   // disconnected / re-targeted meanwhile → stale result
  if (r.ok) {
    if (st !== "live") {
      setConnStatus(c.id, "live", { gen });
      toast(`Reconnected to ${connLabel(c)}`, "checkCircle", { ms: 3500 });
      logAll(c.id, { kind: "conn", text: `reconnected to ${connLabel(c)}`, ok: true, ms: r.ms });
      for (const t of tabsOf(c.id)) { if (!t.schema) loadSchema(t); else if (t === AT() && t.mode === "browse" && t.cur) renderBrowse(t); }
    }
  } else if (st === "live" || (st === "reconnecting" && (r.type === "auth" || r.type === "permission" || r.type === "secret-locked"))) {
    const fatal = r.type === "auth" || r.type === "permission" || r.type === "secret-locked" || r.type === "driver-missing" || r.type === "driver-broken";
    setConnStatus(c.id, fatal ? "error" : "reconnecting", { gen });
    toast(fatal ? `${connLabel(c)}: ${r.detail}` : `Lost connection to ${connLabel(c)} — reconnecting…`, "alert", { ms: 5000 });
    logAll(c.id, { kind: "conn", text: `connection ${fatal ? "failed" : "lost"} — ${r.detail}`, ok: false, error: r.detail });
  }
};
export const checkHealth = async (eager) => { await Promise.allSettled(conns.map((c) => checkOne(c, eager))); };
export const startHealth = () => {
  if (healthTimer) return;
  setHealthTimer(setInterval(() => checkHealth(false), HEALTH_MS));
  const onOnline = () => { toast("Network is back — reconnecting…", "wifi", { ms: 2500 }); setTimeout(() => checkHealth(true), 800); };
  const onOffline = () => { let any = false; for (const c of conns) if (connStatus.get(c.id) === "live") { any = true; bumpGen(c.id); setConnStatus(c.id, "reconnecting"); } if (any) toast("Network offline — connections will resume automatically", "wifiOff", { ms: 3500 }); };
  const onVis = () => { if (!document.hidden) checkHealth(true); };
  window.addEventListener("online", onOnline); window.addEventListener("offline", onOffline); document.addEventListener("visibilitychange", onVis);
  disposers.push(() => { clearInterval(healthTimer); setHealthTimer(0); window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); document.removeEventListener("visibilitychange", onVis); });
};
// An operation failed: typed transport errors → reconnecting; auth/permission/policy → not a connection problem.
export const noteFailure = (tab, err) => {
  if (!tab || !tab.conn) return;
  const type = (err && err.type) || "";
  const msg = errMsg(err);
  const transport = type === "transport" || type === "outcome-unknown" || /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|not connected|Driver .* is not installed/i.test(msg);
  if (!transport && type !== "auth" && type !== "secret-locked" && type !== "driver-missing" && type !== "driver-broken") return;
  const fatal = type === "auth" || type === "secret-locked" || type === "driver-missing" || type === "driver-broken";
  const gen = bumpGen(tab.conn.id);
  setConnStatus(tab.conn.id, fatal ? "error" : "reconnecting", { gen });
  if (!fatal) setTimeout(() => checkHealth(true), 2500);
};
export const disconnectConn = async (c) => {
  desired.set(c.id, "off"); bumpGen(c.id);
  for (const t of tabsOf(c.id)) { if (t.session) { const sid = t.session; t.session = null; t.sessionTx = false; await atom().db.sessionClose(sid, { rollback: true }).catch(() => {}); } }
  await atom().db.disconnect(c.id).catch(() => {});
  setConnStatus(c.id, "off");
  for (const t of tabsOf(c.id)) syncSessionBadge(t);
  toast("Disconnected", "check");
};
export const markLive = (tab) => { if (!tab.conn) return; desired.set(tab.conn.id, "on"); setConnStatus(tab.conn.id, "live"); };
