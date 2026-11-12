// Fusion's icon set: simple line icons drawn for this project (MIT, like the
// rest of the theme). 24x24 grid, drawn with currentColor so CSS sets colour.

const P = {
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M6 6v12" /><path d="M18.5 6v12L9 12z" fill="currentColor" stroke="none"/>',
  next: '<path d="M18 6v12" /><path d="M5.5 6v12L15 12z" fill="currentColor" stroke="none"/>',
  stop: '<path d="M7 7h10v10H7z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10"/>',
  mute: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  shuffle: '<path d="M4 7h3.5c4.5 0 4.5 10 9 10H20M4 17h3.5c1.4 0 2.4-.9 3.1-2.1M13.4 9.1C14.1 7.9 15.1 7 16.5 7H20"/><path d="M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5"/>',
  repeat: '<path d="M5 12V9.5A2.5 2.5 0 0 1 7.5 7H19M19 12v2.5a2.5 2.5 0 0 1-2.5 2.5H5"/><path d="M16.5 4.5 19 7l-2.5 2.5M7.5 19.5 5 17l2.5-2.5"/>',
  repeatOne: '<path d="M5 12V9.5A2.5 2.5 0 0 1 7.5 7H19M19 12v2.5a2.5 2.5 0 0 1-2.5 2.5H5"/><path d="M16.5 4.5 19 7l-2.5 2.5M7.5 19.5 5 17l2.5-2.5"/><path d="M11.5 10.5l1-.8v4.6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="M14.5 14.5 20 20"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  heart: '<path d="M12 19.5s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.2c0 5.4-7.5 10-7.5 10z"/>',
  heartFill: '<path d="M12 19.5s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.2c0 5.4-7.5 10-7.5 10z" fill="currentColor"/>',
  // Two filled halves with a zigzag crack, pushed apart. Plain paths (no
  // clip-path/mask ids), so every copy renders even inside hidden rows.
  heartBroken: '<path d="M12 7.8A4.2 4.2 0 0 0 4.5 10c0 5.4 7.5 10 7.5 10L10.6 16.4l2.6-3-3-2.4z" fill="currentColor" stroke="none" transform="rotate(-7 12 20) translate(-1.1 0)"/><path d="M12 7.8a4.2 4.2 0 0 1 7.5 2.2c0 5.4-7.5 10-7.5 10L10.6 16.4l2.6-3-3-2.4z" fill="currentColor" stroke="none" transform="rotate(7 12 20) translate(1.1 0)"/>',
  // Cog: eight teeth around a ring with a hub.
  settings: '<path d="M10.3 3.5h3.4l.5 2.4 1.6.9 2.3-.8 1.7 2.9-1.8 1.6v1.9l1.8 1.6-1.7 2.9-2.3-.8-1.6.9-.5 2.4h-3.4l-.5-2.4-1.6-.9-2.3.8-1.7-2.9 1.8-1.6v-1.9L3.7 8.9l1.7-2.9 2.3.8 1.6-.9z"/><circle cx="12" cy="12" r="2.6"/>',
  palette: '<path d="M12 4a8 8 0 1 0 0 16c1.1 0 1.6-.7 1.6-1.5 0-1-.9-1.4-.9-2.3 0-.9.7-1.4 1.6-1.4h1.9A3.8 3.8 0 0 0 20 11c0-3.9-3.6-7-8-7z"/><circle cx="8" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.8" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="7.8" r="1" fill="currentColor" stroke="none"/>',
  link: '<path d="M14 5h5v5M19 5l-8 8M17 14v4.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H10"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2-4.9M19 4.5V8h-3.5"/>',
  reset: '<path d="M5 12a7 7 0 1 0 2-4.9M5 4.5V8h3.5"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevronDown: '<path d="M7 10l5 5 5-5"/>',
  chevronRight: '<path d="M10 7l5 5-5 5"/>',
  sortAsc: '<path d="M8 18V6M5 9l3-3 3 3M14 7h5M14 12h4M14 17h3"/>',
  sortDesc: '<path d="M8 6v12M5 15l3 3 3-3M14 7h3M14 12h4M14 17h5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  delete: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  rename: '<path d="M5 19h4L19 9l-4-4L5 15z"/><path d="M13 7l4 4"/>',
  lyrics: '<path d="M4 6h10M4 10h10M4 14h6"/><circle cx="16.5" cy="17" r="2.5"/><path d="M19 17V6.5l2 1"/>',
  queue: '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M15 14.5v5l4-2.5z" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.5"/>',
  note: '<path d="M9 17V6l10-2v11"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="15" r="2"/>',
  person: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5"/>',
  disc: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>',
  tag: '<path d="M4 4h7.5L20 12.5 12.5 20 4 11.5z"/><circle cx="8" cy="8" r="1.2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  // Equaliser bars; they bounce (CSS) while something is playing.
  nowPlaying: '<path class="eq eq1" d="M5 18v-5"/><path class="eq eq2" d="M9 18V8"/><path class="eq eq3" d="M13 18V5"/><path class="eq eq4" d="M17 18v-7"/>',
  collection: '<path d="M5 5v14M9 5v14"/><path d="M13 5.5l3.2-.8 3.6 14.3-3.2.8z"/>',
  playlist: '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 18V10l3-1"/><circle cx="16.5" cy="18" r="1.5"/>',
  autoplaylist: '<path d="M4 7h11M4 12h7M4 17h7"/><path d="M17 11l1 2.2 2.3.3-1.7 1.6.4 2.4-2-1.2-2 1.2.4-2.4-1.7-1.6 2.3-.3z"/>',
  library: '<path d="M4 20V4M8 20V4M12 20V7M16.5 20l-3-13 2.9-.7 3 13z"/>',
  minimise: '<path d="M6 12h12"/>',
  open: '<path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7A1.5 1.5 0 0 1 20 9v1H8l-4 8z"/><path d="M4 18l3-8h15l-3 8z"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
  folder: '<path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon' + (cls ? ' ' + cls : '');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

export function setIcon(span, name) {
  const svg = span.querySelector('svg');
  if (svg) svg.innerHTML = P[name] || '';
}
