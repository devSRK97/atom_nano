/* Settings — the shared controls every category is built from: a row (label + hint on the
 * left, the control on the right), section headers, switches, segmented pickers, steppers.
 * `field()` keeps the `.field > label` shape other code and the smoke tests rely on. */
import { h } from "../core/dom.js";
import { atom, state } from "../core/state.js";
import { icon } from "../icons.js";

// One settings row. `wide` stacks the control under the text (swatches, lists, editors).
// `keywords` is extra text the settings search matches (synonyms the label doesn't say).
export function field(label, control, hint, opts = {}) {
  const el = h("div", { class: "field" + (opts.wide ? " wide" : "") + (opts.cls ? " " + opts.cls : "") },
    h("label", { text: label }), control, hint ? h("div", { class: "hint", text: hint }) : null);
  if (opts.keywords) el.dataset.keywords = opts.keywords;
  return el;
}
export function section(label, ic) {
  return h("div", { class: "set-section" }, ic ? h("span", { html: icon(ic, 14) }) : null, h("span", { text: label }));
}
// A short line of secondary text inside a control column.
export function note(text, cls) { return h("div", { class: "hint" + (cls ? " " + cls : ""), style: "margin:0", text }); }

export function segmented(values, current, onPick, labels = {}) {
  const seg = h("div", { class: "segmented" });
  const buttons = new Map();
  for (const v of values) {
    const btn = h("button", { class: current === v ? "active" : "", text: labels[v] || v, onclick: () => {
      buttons.forEach((b, key) => b.classList.toggle("active", key === v));
      onPick(v);
    } });
    buttons.set(v, btn);
    seg.append(btn);
  }
  seg._set = (v) => buttons.forEach((b, key) => b.classList.toggle("active", key === v));
  return seg;
}
export function inlineSelect(items, current, onPick) {
  const wrap = h("div", { class: "segmented wrap" });
  const draw = (cur) => {
    wrap.innerHTML = "";
    for (const it of items) wrap.append(h("button", { class: it.id === cur ? "active" : "", text: it.name, onclick: () => { onPick(it.id); draw(it.id); } }));
  };
  draw(current);
  wrap._set = draw;
  return wrap;
}

// An on/off switch (role=switch). `onChange(bool)` fires on every flip.
export function toggle(on, onChange, { label } = {}) {
  const b = h("button", { class: "sw" + (on ? " on" : ""), role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label || "Toggle" }, h("span", { class: "sw-knob" }));
  b._set = (v) => { b.classList.toggle("on", !!v); b.setAttribute("aria-checked", v ? "true" : "false"); };
  b.addEventListener("click", () => { const v = !b.classList.contains("on"); b._set(v); onChange(v); });
  return b;
}
// A switch bound to one boolean setting: flips state.settings[key], persists it, then `apply(v)`.
// `def` is the value an unset key means (most SDK gates default to on).
export function boolSetting(key, { def = false, apply, label } = {}) {
  const s = state.settings;
  const cur = s[key] === undefined || s[key] === null ? def : !!s[key];
  return toggle(cur, (v) => { s[key] = v; atom.settings.set({ [key]: v }).catch(() => {}); if (apply) apply(v); }, { label: label || key });
}

// − value + [Reset] — `format(n)` renders the value; `onChange(n)` receives the clamped number.
export function stepper({ value, min = 0, max = 100, step = 1, format = (n) => String(n), onChange, resetTo, labels = {} }) {
  let cur = value;
  const val = h("span", { class: "step-val", text: format(cur) });
  const set = (n) => { cur = Math.max(min, Math.min(max, n)); val.textContent = format(cur); onChange(cur); };
  const minus = h("button", { class: "btn btn-ghost btn-sm", text: "−", title: labels.minus || "Less", "aria-label": labels.minus || "Less", onclick: () => set(cur - step) });
  const plus = h("button", { class: "btn btn-ghost btn-sm", text: "+", title: labels.plus || "More", "aria-label": labels.plus || "More", onclick: () => set(cur + step) });
  const el = h("div", { class: "stepper" }, minus, val, plus, resetTo !== undefined ? h("button", { class: "btn btn-ghost btn-sm", text: "Reset", onclick: () => set(resetTo) }) : null);
  el._set = (n) => { cur = n; val.textContent = format(n); };
  el._plus = plus;
  return el;
}
// A key → value grid (read-only facts: paths, versions, counts).
export function kvGrid(rows) {
  return h("div", { class: "st-kv" }, ...rows.filter(Boolean).map(([k, v, opts]) => h("div", { class: "st-kv-row" }, h("span", { class: "st-kv-k", text: k }), h("span", { class: "st-kv-v" + (opts && opts.mono ? " mono" : "") + (opts && opts.onclick ? " link" : ""), text: v, title: v, onclick: opts && opts.onclick }))));
}
