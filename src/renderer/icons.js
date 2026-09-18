/* Inline SVG icon set (stroke = currentColor). */
const P = {
  atom: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(45 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-45 12 12)"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2H19.5A1.5 1.5 0 0 1 21 8.7V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>',
  folderOpen: '<path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4L10.5 7.5H19a1.5 1.5 0 0 1 1.5 1.5v1H6.2a1.5 1.5 0 0 0-1.45 1.1L3 18z"/><path d="M3 18l1.75-6.4A1.5 1.5 0 0 1 6.2 10.5H21l-2 7.5z"/>',
  file: '<path d="M6 3h7l5 5v12.5A1.5 1.5 0 0 1 16.5 22h-10A1.5 1.5 0 0 1 5 20.5v-16A1.5 1.5 0 0 1 6.5 3z"/><path d="M13 3v5h5"/>',
  fileCode: '<path d="M6 3h7l5 5v12.5A1.5 1.5 0 0 1 16.5 22h-10A1.5 1.5 0 0 1 5 20.5v-16A1.5 1.5 0 0 1 6.5 3z"/><path d="M13 3v5h5"/><path d="M10.5 12.5 9 14l1.5 1.5M13.5 12.5 15 14l-1.5 1.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  restore: '<rect x="7" y="7" width="12" height="12" rx="1.5"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-2.7.65 1.6 1.6 0 0 0-1.06 1.46V22a2 2 0 0 1-4 0v-.07A1.6 1.6 0 0 0 7.6 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 3 15a1.6 1.6 0 0 0-1.46-1.06H2a2 2 0 0 1 0-4h.07A1.6 1.6 0 0 0 4.6 7.6a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 3a1.6 1.6 0 0 0 1-.46V2a2 2 0 0 1 4 0v.07A1.6 1.6 0 0 0 16.4 4.6a1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 21 9v.07A1.6 1.6 0 0 0 22 12a2 2 0 0 1 0 4z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  send: '<path d="M4 12l16-8-6 16-3.5-6.5z"/><path d="M10.5 13.5 14 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 8 18a2.5 2.5 0 0 0 4 .5 2.5 2.5 0 0 0 4-.5 3 3 0 0 0 3-5.2A3 3 0 0 0 18 7a3 3 0 0 0-3-3 2.5 2.5 0 0 0-3 .8A2.5 2.5 0 0 0 9 4z"/><path d="M12 5v14"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5C8 19.2 5 15.5 5 11V6z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  external: '<path d="M14 5h5v5"/><path d="M19 5l-9 9"/><path d="M19 13v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V7a1.5 1.5 0 0 1 1.5-1.5H11"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v4h-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20L18 7"/>',
  pencil: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  db: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5V12c0 1.66 3.58 3 8 3s8-1.34 8-3V5.5"/><path d="M4 12v6.5c0 1.66 3.58 3 8 3s8-1.34 8-3V12"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  filter: '<path d="M3 4h18l-7 8v6l-4 2v-8z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  folderPlus: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2H19.5A1.5 1.5 0 0 1 21 8.7V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/><path d="M12 11v5M9.5 13.5h5"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  moreVert: '<circle cx="12" cy="5.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l2 2M14 9l2 2"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.1A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5z"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  caseUpper: '<path d="M4 18 8 6l4 12M5.2 14h5.6"/><path d="M15 18l3-9 3 9M16 15h4"/>',
  caseLower: '<path d="M4 18 7 9l3 9M5 15h4"/><path d="M20 11v7M20 13a3 3 0 1 0 0 4"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  upload: '<path d="M12 21V9"/><path d="M7 13l5-5 5 5"/><path d="M4 5h16"/>',
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  commit: '<circle cx="12" cy="12" r="3.2"/><line x1="3" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="21" y2="12"/>',
  pull: '<path d="M12 3v11"/><path d="M7.5 9.5 12 14l4.5-4.5"/><path d="M5 19a7 7 0 0 0 14 0"/>',
  push: '<path d="M12 14V3"/><path d="M7.5 7.5 12 3l4.5 4.5"/><path d="M5 19a7 7 0 0 0 14 0"/>',
  git: '<circle cx="6" cy="18" r="2.6"/><circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="9.5" r="2.6"/><path d="M6 8.6v6.8M8.5 6.5 15.5 8.5M6 12h9.4"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.22-8.56" opacity="0.95"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8.3 12.3 11 15l4.7-5.4"/>',
  cloudUp: '<path d="M7 19a4.2 4.2 0 0 1-.6-8.36A6 6 0 0 1 18 8.5a3.6 3.6 0 0 1-.4 9.5"/><path d="M12 22v-7M9.4 17.4 12 14.8l2.6 2.6"/>',
  cloudDown: '<path d="M7 18a4.2 4.2 0 0 1-.6-8.36A6 6 0 0 1 18 7.5a3.6 3.6 0 0 1-.4 9.5"/><path d="M12 11v7M9.4 15.4 12 18l2.6-2.6"/>',
  minus: '<path d="M5 12h14"/>',
  undo: '<path d="M3 8h6"/><path d="M3 8V2.8"/><path d="M3.2 13.5a8 8 0 1 0 2-8.2L3 8"/>',
  gitCompare: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M11 6h4a3 3 0 0 1 3 3v6"/><path d="M13 18H9a3 3 0 0 1-3-3V9"/><path d="M9 9 6 6 9 3"/><path d="M15 15l3 3-3 3"/>',
  merge: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="8.5" r="2.6"/><path d="M6 8.6v6.8"/><path d="M6 12a8 8 0 0 0 8-8"/><path d="M18 11v3a8 8 0 0 1-8 8"/>',
  splitV: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  splitH: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M8.5 16.2a6 6 0 0 1 7 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/>',
  wifiOff: '<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M8.5 16.2a6 6 0 0 1 7 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/><line x1="2" y1="2" x2="22" y2="22"/>',
  // Letter / brace monogram icons — JetBrains-style frameless glyphs. Bare
  // letters in currentColor (the ft-* class applies the type colour). Sized
  // and weighted to read at tab + tree row scales without a surrounding box.
  jsLetters:   '<text x="12" y="17" font-size="13" font-weight="900" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" fill="currentColor" stroke="none" text-anchor="middle" letter-spacing="-0.2">JS</text>',
  tsLetters:   '<text x="12" y="17" font-size="13" font-weight="900" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" fill="currentColor" stroke="none" text-anchor="middle" letter-spacing="-0.2">TS</text>',
  jsonBraces:  '<text x="12" y="17" font-size="14" font-weight="900" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" fill="currentColor" stroke="none" text-anchor="middle" letter-spacing="-0.4">{ }</text>',
  // Sub-agents: a robot head (antenna, eyes, mouth) — the worker agents (user request 2026-09-17).
  agents: '<rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 8V5.4"/><circle cx="12" cy="4" r="1.3"/><circle cx="9.2" cy="13" r="1.25" fill="currentColor" stroke="none"/><circle cx="14.8" cy="13" r="1.25" fill="currentColor" stroke="none"/><path d="M9.5 16.3h5"/><path d="M3 12.5v3M21 12.5v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  gauge: '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4.5-4.5"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
};

export function icon(name, size = 18, extraClass = "") {
  const body = P[name] || P.dot;
  return `<svg class="icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function iconEl(name, size = 18, extraClass = "") {
  const span = document.createElement("span");
  span.className = "icon-wrap";
  span.innerHTML = icon(name, size, extraClass);
  return span;
}
