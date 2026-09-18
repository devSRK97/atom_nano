"use strict";
/* A minimal DOM for the renderer suites that run WHOLE UI modules in a vm (scripts/test-workflow-ui.js runs
 * workflow/model.js + workflow/studio.js and the real h() / modalShell() / closeModal() / confirmDialog() of
 * core/dom.js against it). Enough of Element / Text / Document / Event for those: a tree (append / prepend /
 * insertBefore / removeChild / replaceChildren / remove), classList, dataset (`data-*` attributes read and write
 * it), attributes, textContent / innerHTML (an HTML string is STORED, not parsed — textContent strips its tags),
 * value / checked / disabled, querySelector(All) / matches / closest over a small selector grammar (tag, #id,
 * .class, [attr], [attr=value] with " ' or bare values and ~= ^= $= *=, :checked, :disabled, :not(...),
 * descendant and > combinators, comma lists), addEventListener / removeEventListener / dispatchEvent with
 * capture + bubble phases and on<event> handler properties, focus / blur / click / select. Not a browser: no
 * layout (getBoundingClientRect is zeros, offsetParent is the parent), no CSS, no HTML parsing. Unsupported
 * selector syntax throws, so a test that leans on it fails loudly instead of matching nothing. */

class FakeEvent {
  constructor(type, init = {}) {
    this.type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
    this.defaultPrevented = false; this.target = null; this.currentTarget = null;
    this._stop = false; this._stopNow = false;
    for (const k of ["key", "code", "ctrlKey", "metaKey", "altKey", "shiftKey", "clientX", "clientY", "button"]) if (init[k] !== undefined) this[k] = init[k];
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
}

class FakeEventTarget {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn, opts) {
    if (typeof fn !== "function") return;
    const cap = opts === true || !!(opts && opts.capture);
    const list = this._listeners.get(type) || [];
    if (list.some((l) => l.fn === fn && l.cap === cap)) return;
    list.push({ fn, cap }); this._listeners.set(type, list);
  }
  removeEventListener(type, fn, opts) {
    const cap = opts === true || !!(opts && opts.capture);
    const list = this._listeners.get(type); if (!list) return;
    this._listeners.set(type, list.filter((l) => !(l.fn === fn && l.cap === cap)));
  }
  _invoke(ev, capture) {
    ev.currentTarget = this;
    for (const l of [...(this._listeners.get(ev.type) || [])]) {
      if (l.cap !== capture) continue;
      l.fn.call(this, ev);
      if (ev._stopNow) return;
    }
    if (!capture) { const handler = this["on" + ev.type]; if (typeof handler === "function") handler.call(this, ev); }
  }
  dispatchEvent(ev) {
    if (!(ev instanceof FakeEvent)) throw new Error("fake-dom: dispatchEvent needs an Event");
    if (!ev.target) ev.target = this;
    const path = []; for (let n = this.parentNode; n; n = n.parentNode) path.push(n);   // nearest first, the document last
    for (let i = path.length - 1; i >= 0; i--) { path[i]._invoke(ev, true); if (ev._stop) return !ev.defaultPrevented; }
    this._invoke(ev, true); if (!ev._stopNow) this._invoke(ev, false);
    if (ev.bubbles && !ev._stop) for (const n of path) { n._invoke(ev, false); if (ev._stop) break; }
    return !ev.defaultPrevented;
  }
}

class FakeText {
  constructor(doc, text) { this.ownerDocument = doc; this.nodeType = 3; this.nodeName = "#text"; this.nodeValue = String(text); this.parentNode = null; }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
  get isConnected() { return isConnected(this); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const isConnected = (node) => { for (let n = node; n; n = n.parentNode) if (n.nodeType === 9) return true; return false; };
const walk = (root, fn) => { for (const c of root.childNodes || []) { if (c.nodeType === 1) { fn(c); walk(c, fn); } } };

class FakeElement extends FakeEventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc; this.nodeType = 1; this.localName = String(tag).toLowerCase(); this.tagName = this.nodeName = this.localName.toUpperCase();
    this.childNodes = []; this.parentNode = null;
    this._attrs = new Map(); this._classes = new Set(); this._html = null;
    this.dataset = {}; this.style = {}; this.value = ""; this.checked = false;
    this.offsetWidth = 0; this.offsetHeight = 0; this.scrollTop = 0; this.scrollHeight = 0;
    const self = this;
    this.classList = {
      add: (...c) => { for (const x of c) if (x) self._classes.add(String(x)); },
      remove: (...c) => { for (const x of c) self._classes.delete(String(x)); },
      toggle: (c, force) => { const on = force === undefined ? !self._classes.has(c) : !!force; if (on) self._classes.add(c); else self._classes.delete(c); return on; },
      contains: (c) => self._classes.has(c),
      get length() { return self._classes.size; },
      toString: () => [...self._classes].join(" "),
    };
  }
  /* ---- attributes / reflected properties ---- */
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get id() { return this._attrs.get("id") || ""; }
  set id(v) { this._attrs.set("id", String(v)); }
  get type() { return this._attrs.get("type") || (this.localName === "input" ? "text" : ""); }
  set type(v) { this._attrs.set("type", String(v)); }
  get disabled() { return this._attrs.has("disabled"); }
  set disabled(v) { if (v) this._attrs.set("disabled", ""); else this._attrs.delete("disabled"); }
  get title() { return this._attrs.get("title") || ""; }
  set title(v) { this._attrs.set("title", String(v)); }
  get placeholder() { return this._attrs.get("placeholder") || ""; }
  set placeholder(v) { this._attrs.set("placeholder", String(v)); }
  get hidden() { return this._attrs.has("hidden"); }
  set hidden(v) { if (v) this._attrs.set("hidden", ""); else this._attrs.delete("hidden"); }
  setAttribute(k, v) {
    k = String(k); v = String(v);
    if (k === "class") this.className = v;
    else if (k.startsWith("data-")) this.dataset[camel(k.slice(5))] = v;
    else this._attrs.set(k, v);
  }
  getAttribute(k) {
    k = String(k);
    if (k === "class") return this._classes.size ? this.className : (this._attrs.has("class") ? "" : null);
    if (k.startsWith("data-")) { const d = this.dataset[camel(k.slice(5))]; return d === undefined ? null : String(d); }
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { k = String(k); if (k === "class") this._classes.clear(); else if (k.startsWith("data-")) delete this.dataset[camel(k.slice(5))]; else this._attrs.delete(k); }
  /* ---- tree ---- */
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; }
  get isConnected() { return isConnected(this); }
  get offsetParent() { return this.isConnected ? this.parentElement : null; }
  _adopt(node) {
    if (node == null || typeof node !== "object") node = this.ownerDocument.createTextNode(String(node));
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this; return node;
  }
  append(...nodes) { for (const n of nodes) this.childNodes.push(this._adopt(n)); }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) { this.childNodes.unshift(...nodes.map((n) => this._adopt(n))); }
  insertBefore(node, ref) {
    if (!ref) { this.append(node); return node; }
    const i = this.childNodes.indexOf(ref); if (i < 0) throw new Error("fake-dom: insertBefore — the reference is not a child");
    this.childNodes.splice(i, 0, this._adopt(node)); return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node); if (i < 0) throw new Error("fake-dom: removeChild — not a child");
    this.childNodes.splice(i, 1); node.parentNode = null; return node;
  }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this._html = null; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  /* ---- content ---- */
  get textContent() { return (this._html != null ? this._html.replace(/<[^>]*>/g, "") : "") + this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.replaceChildren(); if (v != null && v !== "") this.childNodes.push(this._adopt(this.ownerDocument.createTextNode(String(v)))); }
  get innerHTML() { return (this._html != null ? this._html : "") + this.childNodes.map((c) => (c.nodeType === 1 ? c.outerHTML : c.nodeValue)).join(""); }
  set innerHTML(v) { this.replaceChildren(); this._html = v == null || v === "" ? null : String(v); }
  get outerHTML() {
    const attrs = [];
    if (this._classes.size) attrs.push(`class="${this.className}"`);
    for (const [k, v] of this._attrs) attrs.push(v === "" ? k : `${k}="${v}"`);
    for (const [k, v] of Object.entries(this.dataset)) attrs.push(`data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}="${v}"`);
    return `<${this.localName}${attrs.length ? " " + attrs.join(" ") : ""}>${this.innerHTML}</${this.localName}>`;
  }
  /* ---- queries ---- */
  querySelectorAll(sel) { const list = parseSelectorList(sel); const out = []; walk(this, (n) => { if (matchesList(n, list)) out.push(n); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return matchesList(this, parseSelectorList(sel)); }
  closest(sel) { const list = parseSelectorList(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesList(n, list)) return n; return null; }
  /* ---- behaviour ---- */
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  select() { /* text selection is not modelled */ }
  click() { this.dispatchEvent(new FakeEvent("click", { bubbles: true, cancelable: true })); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  scrollIntoView() { /* no layout */ }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.nodeType = 9; this.nodeName = "#document"; this.parentNode = null; this.ownerDocument = this;
    this.documentElement = new FakeElement(this, "html"); this.documentElement.parentNode = this;
    this.head = new FakeElement(this, "head"); this.body = new FakeElement(this, "body");
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
    this.childNodes = [this.documentElement];
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(_ns, tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(this, text); }
  getElementById(id) { let found = null; walk(this.documentElement, (n) => { if (!found && n.id === String(id)) found = n; }); return found; }
  querySelectorAll(sel) { const list = parseSelectorList(sel); const out = []; if (matchesList(this.documentElement, list)) out.push(this.documentElement); walk(this.documentElement, (n) => { if (matchesList(n, list)) out.push(n); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
}

/* ---- selectors ---- */
const cache = new Map();
function parseSelectorList(sel) {
  if (cache.has(sel)) return cache.get(sel);
  const list = splitTop(String(sel), ",").map((s) => parseComplex(s.trim()));
  cache.set(sel, list); return list;
}
// Split on `sep` outside [...] and (...) and quotes.
function splitTop(s, sep) {
  const out = []; let depth = 0, quote = null, cur = "";
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(") depth++; else if (ch === "]" || ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
// "A > B C" → [{ compound: A }, { comb: ">", compound: B }, { comb: " ", compound: C }]
function parseComplex(s) {
  if (!s) throw new Error("fake-dom: empty selector");
  const parts = []; let i = 0, comb = null;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t") { if (parts.length && !comb) comb = " "; i++; continue; }
    if (ch === ">") { comb = ">"; i++; continue; }
    let j = i, depth = 0, quote = null;
    for (; j < s.length; j++) {
      const c = s[j];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "[" || c === "(") depth++; else if (c === "]" || c === ")") depth--;
      else if ((c === " " || c === "\t" || c === ">") && depth === 0) break;
    }
    parts.push({ comb: parts.length ? comb || " " : null, compound: parseCompound(s.slice(i, j)) });
    comb = null; i = j;
  }
  return parts;
}
const TOKEN = /^(?:#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]|:not\(((?:[^()]|\([^)]*\))*)\)|:([\w-]+))/;
function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [], nots: [], pseudos: [] };
  const t = /^(\*|[a-zA-Z][\w-]*)/.exec(s); let rest = s;
  if (t) { c.tag = t[1] === "*" ? null : t[1].toLowerCase(); rest = s.slice(t[0].length); }
  while (rest) {
    const m = TOKEN.exec(rest); if (!m) throw new Error("fake-dom: unsupported selector syntax at " + JSON.stringify(rest) + " in " + JSON.stringify(s));
    if (m[1]) c.id = m[1];
    else if (m[2]) c.classes.push(m[2]);
    else if (m[3]) c.attrs.push({ name: m[3], op: m[4] || null, value: m[5] !== undefined ? m[5] : m[6] !== undefined ? m[6] : m[7] !== undefined ? m[7] : null });
    else if (m[8] !== undefined) c.nots.push(parseSelectorList(m[8]));
    else if (m[9]) { if (!["checked", "disabled", "enabled", "empty", "first-child", "last-child"].includes(m[9])) throw new Error("fake-dom: unsupported pseudo-class :" + m[9]); c.pseudos.push(m[9]); }
    rest = rest.slice(m[0].length);
  }
  return c;
}
function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el._classes.has(k)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
  }
  for (const n of c.nots) if (matchesList(el, n)) return false;
  for (const p of c.pseudos) {
    if (p === "checked" && el.checked !== true) return false;
    if (p === "disabled" && !el.disabled) return false;
    if (p === "enabled" && el.disabled) return false;
    if (p === "empty" && el.childNodes.length) return false;
    if (p === "first-child" && !(el.parentNode && el.parentNode.children[0] === el)) return false;
    if (p === "last-child" && !(el.parentNode && el.parentNode.children.slice(-1)[0] === el)) return false;
  }
  return true;
}
function matchAt(el, parts, i) {
  if (!el || el.nodeType !== 1 || !matchCompound(el, parts[i].compound)) return false;
  if (i === 0) return true;
  if (parts[i].comb === ">") return matchAt(el.parentNode, parts, i - 1);
  for (let a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) if (matchAt(a, parts, i - 1)) return true;
  return false;
}
const matchesList = (el, list) => list.some((parts) => matchAt(el, parts, parts.length - 1));

function createDocument() { return new FakeDocument(); }
module.exports = { createDocument, Event: FakeEvent, Element: FakeElement, Text: FakeText, Document: FakeDocument };
