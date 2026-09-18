/* AtomNano renderer — Workflow studio — the canvas: an SVG design surface with the five role nodes
 * (HTML cards in foreignObjects on a dotted grid) — the Orchestrator (the primary) and its four workers
 * Planner / Coder / Reviewer / Tester —, smooth cubic edges from the Orchestrator to every enabled role, a
 * sub-agent lane on every edge (band + orbs + the −/+ stepper, on any provider), pointer drag with an 8 px
 * snap persisted to workflow.layout, Fit, and the live layer: pulsing rings, streaming particles, each role's
 * sub-agents orbiting its node and fading check / cross badges when jobs finish. */
import { h, showContextMenu } from "../core/dom.js";
import { icon } from "../icons.js";
import { toggle } from "../settings/controls.js";
import { PRIMARY, ROLES, ROLE_ORDER, S, WORKERS, accessOf, activeSessionId, activeWorkflow, clampAgents, edit, effectiveProvider, effortName, isOpen, laneOf, nodeModelLine, openJobTab, runRole, selectRole, setWorkflowEnabled } from "./model.js";
import { CANVAS_H, CANVAS_W, DEFAULT_LAYOUT, NODE_SIZE, cloneLayout } from "./presets.js";
import { BADGE_MS, addTicker, agentHue, boardStats, fmtSpan, jobElapsedMs, liveSubAgentsFor, pausedLabel, primaryLive, primaryStage, reducedMotion, roleAgentStats, roleLive } from "./live.js";

export const NS = "http://www.w3.org/2000/svg";
export const XHTML = "http://www.w3.org/1999/xhtml";
export const GRID = 8;
export const PARTICLES = 7;

/* ----------------------------- helpers ----------------------------- */
export function sv(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v); else e.setAttribute(k, String(v)); }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
export const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const snap = (v) => Math.round(v / GRID) * GRID;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function nodeRect(role, wf = activeWorkflow()) {
  const size = NODE_SIZE[role], d = DEFAULT_LAYOUT[role];
  const l = (wf.layout && wf.layout[role]) || {};
  const x = num(l.x, d.x), y = num(l.y, d.y);
  return { x, y, w: size.w, h: size.h, cx: x + size.w / 2, cy: y + size.h / 2 };
}
// Orchestrator → role: leaves the orchestrator's right port (left when the role sits to its left), enters the role's facing port.
export function edgeGeom(from, to) {
  const leftward = to.cx < from.cx;
  const x1 = leftward ? from.x : from.x + from.w, y1 = from.cy;
  const x2 = leftward ? to.x + to.w : to.x, y2 = to.cy;
  const dx = Math.max(70, Math.abs(x2 - x1) * 0.5) * (leftward ? -1 : 1);
  const p0 = [x1, y1], p1 = [x1 + dx, y1], p2 = [x2 - dx, y2], p3 = [x2, y2];
  return { p0, p1, p2, p3, d: `M ${x1} ${y1} C ${p1[0]} ${p1[1]}, ${p2[0]} ${p2[1]}, ${x2} ${y2}` };
}
export function bez(g, t) {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [a * g.p0[0] + b * g.p1[0] + c * g.p2[0] + d * g.p3[0], a * g.p0[1] + b * g.p1[1] + c * g.p2[1] + d * g.p3[1]];
}
export function viewBoxStr() { const v = S.view || { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }; return `${v.x} ${v.y} ${v.w} ${v.h}`; }
export function svgPoint(e) {
  const svg = S.canvas && S.canvas.svg; if (!svg) return { x: e.clientX, y: e.clientY };
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : { x: e.clientX, y: e.clientY };
}

/* ----------------------------- build ----------------------------- */
export function buildCanvas() {
  const svg = sv("svg", { class: "wf-svg", viewBox: viewBoxStr(), preserveAspectRatio: "xMidYMid meet", "aria-label": "Workflow canvas" });
  const defs = sv("defs", {},
    sv("pattern", { id: "wfGrid", width: 24, height: 24, patternUnits: "userSpaceOnUse" }, sv("circle", { class: "wf-grid-dot", cx: 1.2, cy: 1.2, r: 1.2 })),
    sv("filter", { id: "wfGlow", x: "-40%", y: "-40%", width: "180%", height: "180%" }, sv("feGaussianBlur", { stdDeviation: 12 })));
  const layers = {};
  // "lanectl" (the −/+ steppers) sits above every lane band and edge: with five nodes the bands of neighbouring
  // lanes run under another role's stepper, and a band painted later would swallow its clicks (2026-09-17).
  for (const k of ["bg", "lane", "edges", "lanectl", "particles", "nodes", "orbs", "badges"]) layers[k] = sv("g", { class: "wf-l-" + k });
  layers.bg.append(sv("rect", { class: "wf-grid-bg", x: -4000, y: -4000, width: 9000, height: 9000, fill: "url(#wfGrid)" }));
  svg.append(defs, ...Object.values(layers));
  svg.addEventListener("pointerdown", (e) => { const t = e.target; if (t === svg || (t.classList && t.classList.contains("wf-grid-bg"))) { if (S.selected) selectRole(null); } });
  const root = h("div", { class: "wf-canvas" }, svg,
    h("div", { class: "wf-canvas-hint", text: "Drag a node to move it · click to configure · right-click for actions" }),
    h("div", { class: "wf-offbar hidden", role: "status" }),
    h("div", { class: "wf-tools" },
      h("button", { class: "wf-tool", title: "Fit the canvas to the nodes  F", html: icon("maximize", 13) + "<span>Fit</span>", onclick: () => fitView() }),
      h("button", { class: "wf-tool", title: "Put the nodes back to the default layout", html: icon("refresh", 13) + "<span>Reset layout</span>", onclick: () => { S.view = null; edit({ layout: cloneLayout() }); } })),
    legend());
  root.addEventListener("contextmenu", (e) => e.preventDefault());
  S.canvas = { root, svg, layers, nodes: {}, edges: {}, lanes: {}, particles: new Map(), orbs: new Map(), badges: new Map(), ticker: null };
  return root;
}
export function legend() {
  return h("div", { class: "wf-legend" }, ...ROLE_ORDER.map((r) => h("button", { class: `wf-legend-item ${r}`, title: `Configure the ${ROLES[r].name}`, onclick: () => selectRole(r) }, h("i"), h("span", { text: ROLES[r].name }))));
}

/* ----------------------------- render ----------------------------- */
export function renderCanvas() {
  const C = S.canvas; if (!C || !isOpen()) return;
  const wf = activeWorkflow();
  for (const k of ["lane", "edges", "lanectl", "particles", "nodes", "orbs", "badges"]) C.layers[k].innerHTML = "";
  C.nodes = {}; C.edges = {}; C.lanes = {}; C.particles.clear(); C.orbs.clear(); C.badges.clear();
  const rects = {}; for (const r of ROLE_ORDER) rects[r] = nodeRect(r, wf);
  for (const r of WORKERS) {
    if (wf.roles[r].enabled === false) continue;
    const geom = edgeGeom(rects[PRIMARY], rects[r]);
    const base = sv("path", { class: `wf-edge-base ${r}`, d: geom.d }), flow = sv("path", { class: `wf-edge-flow ${r}`, d: geom.d });
    C.layers.edges.append(base, flow);
    C.edges[r] = { base, flow, geom };
    renderLane(r, geom, wf.roles[r]);   // every role has its own sub-agent lane (2026-09-17)
  }
  for (const r of ROLE_ORDER) C.layers.nodes.append(nodeGroup(r, rects[r], wf));
  C.root.classList.toggle("off", !wf.enabled);
  C.svg.setAttribute("viewBox", viewBoxStr());
  updateOffBar(wf);
  S.sid = activeSessionId();
  applyLive();
}
export function updateOffBar(wf) {
  const bar = S.canvas && S.canvas.root.querySelector(".wf-offbar"); if (!bar) return;
  bar.classList.toggle("hidden", !!wf.enabled);
  bar.innerHTML = "";
  if (wf.enabled) return;
  bar.append(h("span", { html: icon("info", 13) }), h("span", { text: "Workflow off — the chat runs solo. Turn it on and the model you chat with becomes the Orchestrator that drives these roles." }),
    h("button", { class: "wf-btn sm primary", text: "Turn on", onclick: () => setWorkflowEnabled(true) }));   // asks first when solo sub-agents are on (they turn off)
}

/* ----------------------------- the sub-agent lanes (one per role) ----------------------------- */
export function laneT(i, n) { return n <= 1 ? 0.5 : 0.16 + (0.68 * i) / (n - 1); }
// The Orchestrator → role edge carries that role's OWN lane: a band, one orb per sub-agent and the −/+ stepper.
// The lane counts on EVERY provider (Claude: the Task tool; Codex: its multi-agent feature) — 2026-09-17: it
// used to be drawn empty and labelled "Claude only" on Codex / Custom roles, which silently ignored the number.
export function renderLane(role, geom, cfg) {
  const C = S.canvas; const n = clampAgents(cfg.agents);
  const band = sv("path", { class: `wf-lane-band ${role}` + (n ? "" : " empty"), d: geom.d });
  const orbs = sv("g", { class: `wf-lane-orbs ${role}` });
  for (let i = 0; i < n; i++) { const [x, y] = bez(geom, laneT(i, n)); orbs.append(sv("circle", { class: "wf-lane-orb", cx: x.toFixed(1), cy: y.toFixed(1), r: 4.5, style: `--ag-h:${agentHue(i + 1)}` })); }
  const fo = sv("foreignObject", { class: `wf-lane-fo ${role}`, width: 210, height: 36 });
  fo.append(laneControl(role, n, cfg));
  C.layers.lane.append(band, orbs);
  C.layers.lanectl.append(fo);   // every stepper above every band (see buildCanvas)
  C.lanes[role] = { band, orbs, fo, geom, n };
  placeLaneControl(role);
}
export function placeLaneControl(role) {
  const L = S.canvas && S.canvas.lanes && S.canvas.lanes[role]; if (!L) return;
  const [mx, my] = bez(L.geom, 0.5);
  L.fo.setAttribute("x", (mx - 105).toFixed(1)); L.fo.setAttribute("y", (my + 14).toFixed(1));
}
export function laneControl(role, n, cfg) {
  const name = ROLES[role].name;
  const input = h("input", { class: "wf-lane-num", type: "number", min: "0", max: "20", step: "1", value: String(n), "aria-label": `Sub-agents of the ${name}`, title: "0 = solo · 1–20 sub-agents" });
  input.addEventListener("change", () => setAgents(role, +input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  const ctl = h("div", { class: `wf-lane-ctl wf-nodrag ${role}` + (cfg && cfg.enabled === false ? " off" : ""), title: `Sub-agents the ${name} may fan out to (0 = it works alone), on any provider. It is told to use as many as the task allows, in parallel.` },
    h("button", { class: "wf-lane-btn wf-lane-minus", type: "button", "aria-label": `Fewer ${name} sub-agents`, html: icon("minus", 12), onclick: () => setAgents(role, n - 1) }),
    input,
    h("button", { class: "wf-lane-btn wf-lane-plus", type: "button", "aria-label": `More ${name} sub-agents`, html: icon("plus", 12), onclick: () => setAgents(role, n + 1) }),
    h("span", { class: "wf-lane-label", text: n === 0 ? "solo" : n === 1 ? "sub-agent" : "sub-agents" }));
  ctl.setAttribute("xmlns", XHTML);
  return ctl;
}
export function setAgents(role, n) { return edit({ roles: { [role]: { agents: clampAgents(n) } } }); }

/* ----------------------------- nodes ----------------------------- */
export function nodeGroup(role, rc, wf) {
  const C = S.canvas; const cfg = wf.roles[role]; const isPrimary = role === PRIMARY; const on = isPrimary || cfg.enabled !== false;
  const g = sv("g", { class: `wf-nodeg ${role}` + (isPrimary ? " primary" : "") + (on ? "" : " off") + (S.selected === role ? " selected" : ""), transform: `translate(${rc.x} ${rc.y})`, "data-role": role });
  const glow = sv("rect", { class: "wf-glow", x: -4, y: -4, width: rc.w + 8, height: rc.h + 8, rx: 20, filter: "url(#wfGlow)" });
  const ring = sv("rect", { class: "wf-ring", x: -3.5, y: -3.5, width: rc.w + 7, height: rc.h + 7, rx: 17 });
  const fo = sv("foreignObject", { x: 0, y: 0, width: rc.w, height: rc.h });
  const card = nodeCard(role, cfg, wf, on);
  fo.append(card);
  g.append(glow, ring, fo);
  bindNodeDrag(g, card, role);
  C.nodes[role] = { g, glow, ring, fo, card, rc: { ...rc } };
  return g;
}
export function chipEl(cls, ic, text, title) { return h("span", { class: "wf-chip-sm " + cls, title: title || text }, h("span", { class: "wf-chip-sm-ic", html: icon(ic, 11) }), h("span", { class: "wf-chip-sm-text", text })); }
export function nodeCard(role, cfg, wf, on) {
  const meta = ROLES[role]; const isPrimary = role === PRIMARY; const prov = effectiveProvider(role, cfg); const line = nodeModelLine(role, cfg); const acc = accessOf(cfg.access);
  const card = h("div", { class: `wf-node ${role}` + (isPrimary ? " primary" : "") + (on ? "" : " off"), tabindex: "0", role: "button", "aria-label": `${meta.name} — ${line}` },
    h("div", { class: "wf-node-head" },
      h("span", { class: "wf-node-ic", html: icon(meta.icon, isPrimary ? 18 : 15) }),
      h("span", { class: "wf-node-name", text: meta.name }),
      isPrimary ? h("span", { class: "wf-tag", text: "primary" }) : null,
      h("span", { class: "wf-node-spacer" }),
      isPrimary ? null : toggle(on, (v) => edit({ roles: { [role]: { enabled: v } } }), { label: `${meta.name} enabled` })),
    h("div", { class: "wf-node-model", text: line, title: line }),
    h("div", { class: "wf-node-chips" },
      chipEl("effort", "gauge", effortName(prov, cfg.effort), `Effort: ${effortName(prov, cfg.effort)}`),
      chipEl("access " + cfg.access, acc.icon, acc.short, `${acc.name} — ${acc.help}`),
      // every worker role has its own lane, on any provider (Claude: the Task tool · Codex: its multi-agent feature).
      // "up to N" is the LANE (the cap); the live counters below say how many run now and how many were used.
      isPrimary ? null : chipEl("agents", "agents", laneOf(role, cfg) > 0 ? `up to ${cfg.agents}` : "solo", laneOf(role, cfg) > 0 ? `Sub-agent lane: up to ${cfg.agents} in parallel — the role is told to use as many as the task divides into` : "Works alone"),
      role === "tester" && cfg.command ? chipEl("cmd mono", "terminal", cfg.command) : null),
    // the live counters ("N running" · "M used" so far in this session) and the role's live sub-agents, numbered
    // like the composer strip's chips (filled by applyLive → syncNodeAgents)
    isPrimary ? null : h("div", { class: "wf-node-agents" }),
    h("div", { class: "wf-node-status" }, h("span", { class: "wf-status-dot" }), h("span", { class: "wf-status-text", text: isPrimary ? (wf.enabled ? "the model you chat with" : "workflow off — the chat runs solo") : on ? "idle" : "off" })));
  card.setAttribute("xmlns", XHTML);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRole(role); } });
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); nodeMenu(role, e.clientX, e.clientY); });
  return card;
}
// Pointer drag with an 8 px snap. A press without movement selects the node; a drop persists the layout.
export function bindNodeDrag(g, card, role) {
  let st = null;
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, input, select, textarea, a, .wf-nodrag")) return;
    const pt = svgPoint(e); const rc = S.canvas.nodes[role] ? S.canvas.nodes[role].rc : nodeRect(role);
    st = { id: e.pointerId, px: pt.x, py: pt.y, ox: rc.x, oy: rc.y, x: rc.x, y: rc.y, moved: false };
    try { card.setPointerCapture(e.pointerId); } catch { /* */ }
    e.preventDefault();
  });
  card.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    const pt = svgPoint(e); const dx = pt.x - st.px, dy = pt.y - st.py;
    if (!st.moved) { if (Math.hypot(dx, dy) < 3) return; st.moved = true; g.classList.add("dragging"); S.canvas.root.classList.add("dragging"); }
    const size = NODE_SIZE[role];
    // the canvas edge is a snapped bound too, so a node pushed against it still lands on the 8 px grid
    st.x = clamp(snap(st.ox + dx), 0, Math.floor((CANVAS_W - size.w) / GRID) * GRID); st.y = clamp(snap(st.oy + dy), 0, Math.floor((CANVAS_H - size.h) / GRID) * GRID);
    g.setAttribute("transform", `translate(${st.x} ${st.y})`);
    const N = S.canvas.nodes[role]; if (N) N.rc = { x: st.x, y: st.y, w: size.w, h: size.h, cx: st.x + size.w / 2, cy: st.y + size.h / 2 };
    relayoutEdges();
  });
  const finish = (e) => {
    if (!st || e.pointerId !== st.id) return;
    const d = st; st = null;
    g.classList.remove("dragging"); S.canvas.root.classList.remove("dragging");
    try { card.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (!d.moved) { selectRole(role); return; }
    if (d.x !== d.ox || d.y !== d.oy) edit({ layout: { [role]: { x: d.x, y: d.y } } }, { canvas: false });   // the canvas already shows the new spot
  };
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
}
// Re-path the edges, the lane and the badges from the nodes' current rects (during a drag).
export function relayoutEdges() {
  const C = S.canvas; if (!C || !C.nodes[PRIMARY]) return;
  const P = C.nodes[PRIMARY].rc;
  for (const r of WORKERS) {
    const E = C.edges[r], N = C.nodes[r]; if (!E || !N) continue;
    E.geom = edgeGeom(P, N.rc); E.base.setAttribute("d", E.geom.d); E.flow.setAttribute("d", E.geom.d);
    const L = C.lanes && C.lanes[r];
    if (L) {
      L.geom = E.geom; L.band.setAttribute("d", E.geom.d);
      const orbs = L.orbs.children;
      for (let i = 0; i < orbs.length; i++) { const [x, y] = bez(E.geom, laneT(i, orbs.length)); orbs[i].setAttribute("cx", x.toFixed(1)); orbs[i].setAttribute("cy", y.toFixed(1)); }
      placeLaneControl(r);
    }
  }
  for (const [role, B] of C.badges) { const N = C.nodes[role]; if (N) B.g.setAttribute("transform", `translate(${N.rc.x + N.rc.w - 4} ${N.rc.y + 4})`); }
}
export function nodeMenu(role, x, y) {
  const wf = activeWorkflow(); const cfg = wf.roles[role]; const isPrimary = role === PRIMARY; const sid = activeSessionId();
  const live = isPrimary ? primaryLive(sid) : roleLive(role, sid);
  const items = [{ label: "Configure", icon: "settings", onClick: () => selectRole(role) }];
  if (!isPrimary) items.push({ label: `Run ${ROLES[role].name}…`, icon: "send", onClick: () => runRole(role) });
  const job = (live.running && live.running[0]) || live.last || null;
  if (job && job.sessionId) items.push({ label: job.status === "running" ? "Open the running job's tab" : "Open the last job's tab", icon: "external", onClick: () => openJobTab(job) });
  if (!isPrimary) items.push({ sep: true }, { label: cfg.enabled === false ? `Enable ${ROLES[role].name}` : `Disable ${ROLES[role].name}`, icon: cfg.enabled === false ? "check" : "x", onClick: () => edit({ roles: { [role]: { enabled: cfg.enabled === false } } }) });
  items.push({ sep: true }, { label: "Reset position", icon: "refresh", onClick: () => edit({ layout: { [role]: { ...DEFAULT_LAYOUT[role] } } }) });
  showContextMenu(x, y, items);
}

/* ----------------------------- view ----------------------------- */
export function fitView() {
  const C = S.canvas; if (!C) return;
  const rs = ROLE_ORDER.map((r) => (C.nodes[r] ? C.nodes[r].rc : nodeRect(r)));
  const minX = Math.min(...rs.map((r) => r.x)) - 70, minY = Math.min(...rs.map((r) => r.y)) - 70;
  const maxX = Math.max(...rs.map((r) => r.x + r.w)) + 70, maxY = Math.max(...rs.map((r) => r.y + r.h)) + 90;
  const bw = maxX - minX, bh = maxY - minY;
  const w = Math.max(CANVAS_W * 0.75, bw), hh = Math.max(CANVAS_H * 0.75, bh);
  S.view = { x: Math.round(minX - (w - bw) / 2), y: Math.round(minY - (hh - bh) / 2), w: Math.round(w), h: Math.round(hh) };
  C.svg.setAttribute("viewBox", viewBoxStr());
}
export function resetView() { S.view = null; if (S.canvas) S.canvas.svg.setAttribute("viewBox", viewBoxStr()); }

/* ----------------------------- live layer ----------------------------- */
export function applyLive() {
  const C = S.canvas; if (!C || !isOpen()) return;
  const sid = activeSessionId(); const wf = activeWorkflow(); const now = Date.now();
  let animate = false;
  for (const r of ROLE_ORDER) {
    const N = C.nodes[r]; if (!N) continue;
    const on = r === PRIMARY || wf.roles[r].enabled !== false;
    const live = r === PRIMARY ? primaryLive(sid) : roleLive(r, sid);
    const running = live.status === "running";
    N.g.classList.toggle("running", running);
    N.g.classList.toggle("paused", running && !!live.paused);
    N.g.classList.toggle("queued", live.status === "queued");
    N.g.classList.toggle("done", live.status === "done");
    N.g.classList.toggle("error", live.status === "error");
    N.g.classList.toggle("stopped", live.status === "stopped");
    setStatus(N, r, live, on, sid);
    if (r !== PRIMARY) syncNodeAgents(r, live, sid);
    const E = C.edges[r]; if (E) { E.flow.classList.toggle("running", running && !live.paused); E.base.classList.toggle("running", running); }
    syncParticles(r, running && !live.paused && !!E);
    syncBadge(r, live, now);
    if (running) animate = true;
  }
  syncOrbs(sid);
  if (animate || C.particles.size || C.orbs.size) startTicker();
}
export function setStatus(N, role, live, on, sid) {
  const el = N.card.querySelector(".wf-status-text"); if (!el) return;
  el.classList.remove("wf-elapsed"); delete el.dataset.from; delete el.dataset.prefix;
  const withElapsed = (prefix, from) => { el.classList.add("wf-elapsed"); el.dataset.from = String(from); el.dataset.prefix = prefix; el.textContent = prefix + fmtSpan(Date.now() - from); };
  if (role === PRIMARY) {
    // Workflow off: there is no orchestrator — the chat runs solo (the node used to say "thinking…" whenever the tab ran).
    if (!activeWorkflow().enabled) { el.textContent = "workflow off — the chat runs solo"; return; }
    if (live.status === "running") { const st = primaryStage(sid); if (st && st.stage === PRIMARY && st.status === "running" && st.at) withElapsed("thinking · ", st.at); else el.textContent = "thinking…"; return; }
    // Idle: the board's live picture travels on the orchestrator's line — what is being worked on and what is left.
    const b = boardStats(sid); const tail = b && b.total ? ` · ${b.ongoing.length} ongoing · ${b.remaining.length} to do` : "";
    el.textContent = (live.status === "done" ? "turn finished" : live.status === "error" ? "turn failed" : "the model you chat with") + tail;
    return;
  }
  if (!on) { el.textContent = "off"; return; }
  // the agent numbers live in the counter chips (syncNodeAgents); the status line keeps state + elapsed
  if (live.status === "running") { withElapsed(`${live.paused ? `paused · ${pausedLabel(live.paused)}` : "running"}${live.running && live.running.length > 1 ? ` ×${live.running.length}` : ""} · `, live.startedAt || Date.now()); return; }
  if (live.status === "queued") { el.textContent = "queued"; return; }
  if (live.status === "done") { el.textContent = "done · " + fmtSpan(jobElapsedMs(live.last)); return; }
  if (live.status === "error") { el.textContent = "failed" + (live.last && live.last.error ? " · " + live.last.error : ""); return; }
  if (live.status === "stopped") { el.textContent = "stopped"; return; }
  el.textContent = "idle";
}
export function syncParticles(role, on) {
  const C = S.canvas; const cur = C.particles.get(role);
  if (!on) { if (cur) { cur.g.remove(); C.particles.delete(role); } return; }
  if (cur || reducedMotion()) return;
  const g = sv("g", { class: `wf-particles ${role}` }); const list = [];
  for (let i = 0; i < PARTICLES; i++) { const el = sv("circle", { class: "wf-particle", r: (2 + Math.random() * 1.5).toFixed(1) }); g.append(el); list.push({ el, t: i / PARTICLES, speed: 0.2 + Math.random() * 0.14 }); }
  C.layers.particles.append(g);
  C.particles.set(role, { g, list });
}
export function syncBadge(role, live, now) {
  const C = S.canvas; const N = C.nodes[role]; const cur = C.badges.get(role);
  const end = live.endedAt || 0;
  const show = N && (live.status === "done" || live.status === "error" || live.status === "stopped") && end && now - end < BADGE_MS;
  const key = show ? `${live.status}:${end}` : "";
  if (cur && cur.key === key) return;
  if (cur) { cur.g.remove(); C.badges.delete(role); }
  if (!show) return;
  const ok = live.status === "done";
  const g = sv("g", { class: `wf-badge ${live.status}`, transform: `translate(${N.rc.x + N.rc.w - 4} ${N.rc.y + 4})`, style: `animation-delay:-${now - end}ms` },
    sv("circle", { r: 11 }),
    ok ? sv("path", { d: "M -4.5 0.5 L -1.5 3.5 L 4.5 -3.5" }) : sv("path", { d: "M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" }));
  C.layers.badges.append(g);
  C.badges.set(role, { g, key });
  setTimeout(() => { const b = C.badges.get(role); if (b && b.g === g) { g.remove(); C.badges.delete(role); } }, BADGE_MS - (now - end) + 60);
}
// A role's live row: two counters — how many sub-agents work right now and how many the role has used so far
// in this session (user request 2026-09-18) — then its live sub-agents as chips, numbered like the composer
// strip's, with what each one is doing (the records main keeps on the job, or the child tab's registry when open).
export function syncNodeAgents(role, live, sid) {
  const N = S.canvas.nodes[role]; if (!N) return;
  const host = N.card.querySelector(".wf-node-agents"); if (!host) return;
  const name = ROLES[role].name;
  const st = roleAgentStats(role, sid);
  const agents = live.status === "running" ? liveSubAgentsFor(role, sid) : [];
  host.innerHTML = ""; host.classList.remove("hidden");
  // skills attached to the role (Planner / Coder / Reviewer) — every job of the role runs with them
  const skills = activeWorkflow().roles[role] && Array.isArray(activeWorkflow().roles[role].skills) ? activeWorkflow().roles[role].skills : [];
  if (skills.length) host.append(h("span", { class: "wf-count-chip skills on", title: `${skills.length} skill${skills.length === 1 ? "" : "s"} attached — every ${name} job runs with them (Skills in the header)` }, h("span", { class: "wf-count-ic", html: icon("sparkle", 10) }), h("span", { text: `${skills.length} skill${skills.length === 1 ? "" : "s"}` })));
  host.append(
    h("span", { class: "wf-count-chip running" + (st.running ? " on" : ""), title: `${st.running} sub-agent${st.running === 1 ? "" : "s"} of the ${name} working right now` },
      st.running ? h("span", { class: "ag-orbit sm", "aria-hidden": "true" }, h("i"), h("i"), h("i")) : h("span", { class: "wf-count-dot" }),
      h("span", { text: `${st.running} running` })),
    h("span", { class: "wf-count-chip used" + (st.used ? " on" : ""), title: `${st.used} sub-agent${st.used === 1 ? "" : "s"} used so far in this session by the ${name} · ${st.jobs} job${st.jobs === 1 ? "" : "s"}` },
      h("span", { class: "wf-count-ic", html: icon("history", 10) }),
      h("span", { text: `${st.used} used` })));
  for (const a of agents.slice(0, 3)) host.append(h("span", { class: "wf-agent-chip st-" + a.status, style: `--ag-h:${agentHue(a.n)}`, title: [a.description, a.progress].filter(Boolean).join(" — ") || `Sub-agent #${a.n}` }, h("span", { class: "agent-num", text: `#${a.n}` }), h("span", { class: "wf-agent-chip-text", text: a.progress || a.description || (a.status === "running" ? "working" : a.status) })));
  if (agents.length > 3) host.append(h("span", { class: "wf-agent-chip more", text: `+${agents.length - 3}`, title: `${agents.length} sub-agents running` }));
}
// Every role's live sub-agents as numbered orbs around ITS node (records of the child tab, the job's live list, else placeholders).
export function syncOrbs(sid) {
  const C = S.canvas; const want = new Map();
  for (const r of WORKERS) { if (!C.nodes[r]) continue; for (const a of liveSubAgentsFor(r, sid)) want.set(`${r}:${a.n}`, { ...a, role: r }); }
  for (const [k, O] of C.orbs) if (!want.has(k)) { O.g.remove(); C.orbs.delete(k); }
  let i = 0;
  for (const [k, a] of want) {
    i++;
    const waiting = a.status !== "running";
    if (C.orbs.has(k)) { C.orbs.get(k).g.classList.toggle("waiting", waiting); continue; }
    const g = sv("g", { class: `wf-orb ${a.role}` + (waiting ? " waiting" : ""), style: `--ag-h:${agentHue(a.n)}` }, sv("title", {}, a.description || `Sub-agent #${a.n}`), sv("circle", { r: 9 }), sv("text", { "text-anchor": "middle", dy: 3.5 }, String(a.n)));
    C.layers.orbs.append(g);
    C.orbs.set(k, { g, role: a.role, phase: (i * 2 * Math.PI) / Math.max(1, want.size), speed: 0.5 + (i % 3) * 0.09 });
  }
  if (C.orbs.size && reducedMotion()) placeOrbs(0);   // static placement — no motion
}
export function placeOrbs(now) {
  const C = S.canvas;
  for (const [, O] of C.orbs) {
    const rc = C.nodes[O.role] && C.nodes[O.role].rc; if (!rc) continue;
    const R = Math.hypot(rc.w, rc.h) / 2 + 8, a = O.phase + (now / 1000) * O.speed;
    O.g.setAttribute("transform", `translate(${(rc.cx + Math.cos(a) * R).toFixed(1)} ${(rc.cy + Math.sin(a) * R * 0.6).toFixed(1)})`);
  }
}
export function startTicker() { const C = S.canvas; if (!C || C.ticker || reducedMotion()) return; C.ticker = (dt, now) => tick(dt, now); addTicker(C.ticker); }
// One animation frame: particles stream along the running edges, orbs circle their role's node. Returns false when idle.
export function tick(dt, now) {
  const C = S.canvas;
  if (!C || !isOpen()) { if (C) C.ticker = null; return false; }
  let busy = false;
  for (const [role, P] of C.particles) {
    const E = C.edges[role]; if (!E) continue; busy = true;
    for (const p of P.list) {
      p.t += (p.speed * dt) / 1000; if (p.t >= 1) p.t -= 1;
      const [x, y] = bez(E.geom, p.t);
      p.el.setAttribute("cx", x.toFixed(1)); p.el.setAttribute("cy", y.toFixed(1));
      p.el.setAttribute("opacity", (0.2 + 0.8 * Math.sin(Math.PI * p.t)).toFixed(2));
    }
  }
  if (C.orbs.size) { busy = true; placeOrbs(now); }
  if (!busy) { C.ticker = null; return false; }
  return true;
}
