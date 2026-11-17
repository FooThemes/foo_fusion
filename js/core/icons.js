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
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
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
  // A pushpin: keep the window on top.
  pin: '<path d="M16 3H8v2h1v5l-3 3v2h5v6l1 1 1-1v-6h5v-2l-3-3V5h1z" fill="currentColor" stroke="none"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  // Equaliser bars; they bounce (CSS) while something is playing.
  nowPlaying: '<path class="eq eq1" d="M5 18v-5"/><path class="eq eq2" d="M9 18V8"/><path class="eq eq3" d="M13 18V5"/><path class="eq eq4" d="M17 18v-7"/>',
  stats: '<path d="M4 4.5V19.5h16"/><path d="M7.5 15l3.5-4 3 2.5 5-6"/><circle cx="7.5" cy="15" r=".9" fill="currentColor"/><circle cx="11" cy="11" r=".9" fill="currentColor"/><circle cx="14" cy="13.5" r=".9" fill="currentColor"/><circle cx="19" cy="7.5" r=".9" fill="currentColor"/>',
  collection: '<path d="M5 5v14M9 5v14"/><path d="M13 5.5l3.2-.8 3.6 14.3-3.2.8z"/>',
  playlist: '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 18V10l3-1"/><circle cx="16.5" cy="18" r="1.5"/>',
  autoplaylist: '<path d="M4 7h11M4 12h7M4 17h7"/><path d="M17 11l1 2.2 2.3.3-1.7 1.6.4 2.4-2-1.2-2 1.2.4-2.4-1.7-1.6 2.3-.3z"/>',
  library: '<path d="M4 20V4M8 20V4M12 20V7M16.5 20l-3-13 2.9-.7 3 13z"/>',
  mini: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><rect x="12" y="12" width="6" height="4" rx=".5"/>',
  minimise: '<path d="M6 12h12"/>',
  open: '<path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7A1.5 1.5 0 0 1 20 9v1H8l-4 8z"/><path d="M4 18l3-8h15l-3 8z"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
  folderOpen: '<path d="M4 17.5V7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7A1.5 1.5 0 0 1 20 9v1.5"/><path d="M4 17.5l2.4-6a1.5 1.5 0 0 1 1.4-1h13l-2.6 7.1a1.5 1.5 0 0 1-1.4.9H5.5A1.5 1.5 0 0 1 4 17.5z"/>',
  folder: '<path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
  // Playlist icons (Change icon…): each reads at 18px in the left panel.
  plStar: '<path d="M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z"/>',
  plNote: '<path d="M9 18V6.5l10-2V16"/><circle cx="6.8" cy="18" r="2.2"/><circle cx="16.8" cy="16" r="2.2"/>',
  plHeadphones: '<path d="M4.5 16v-3a7.5 7.5 0 0 1 15 0v3"/><rect x="3.5" y="14" width="4" height="6" rx="1.2"/><rect x="16.5" y="14" width="4" height="6" rx="1.2"/>',
  plVinyl: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 6.5a5.5 5.5 0 0 0-5.5 5.5"/>',
  plGuitar: '<path d="M14.5 9.5l5-5M17.5 3.5l3 3"/><path d="M13 11c-1.6-1.6-4.3-1.4-5.4.6-.5.9-1.4 1.2-2.4 1.4-2 .5-2.4 3.2-.8 4.8l1.3 1.3c1.6 1.6 4.3 1.2 4.8-.8.2-1 .5-1.9 1.4-2.4 2-1.1 2.2-3.8.6-5.4z"/><circle cx="10" cy="14" r="1.2"/>',
  plPiano: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M8 5.5v13M12 5.5v13M16 5.5v13"/><path d="M6.5 5.5v7h3v-7M14.5 5.5v7h3v-7" fill="currentColor"/>',
  plMic: '<rect x="9" y="3.5" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6"/>',
  plRadio: '<rect x="3.5" y="8.5" width="17" height="11" rx="1.5"/><path d="M7 8.5l9-4.5"/><circle cx="15.5" cy="14" r="2.5"/><path d="M6.5 12.5h4M6.5 15.5h4"/>',
  plCar: '<path d="M4.5 15.5v-3l2-4.5a1.5 1.5 0 0 1 1.4-1h8.2a1.5 1.5 0 0 1 1.4 1l2 4.5v3a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/><path d="M4.5 12.5h15"/><circle cx="8" cy="14.5" r=".8" fill="currentColor"/><circle cx="16" cy="14.5" r=".8" fill="currentColor"/><path d="M6.5 16.5v2M17.5 16.5v2"/>',
  plPlane: '<path d="M10.5 13.5l-6-2 1-1.5 7 .5 4-4.5c.8-.8 2.2-.8 2.6-.3.5.4.5 1.8-.3 2.6l-4.5 4 .5 7-1.5 1-2-6-3 2.5v2.5l-1.2.8-1.3-2.8-2.8-1.3.8-1.2H8z"/>',
  plMoon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  plSun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  plCoffee: '<path d="M5 10h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 11.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 4.5c-.6.8.6 1.7 0 2.5M11.5 4.5c-.6.8.6 1.7 0 2.5"/>',
  plFlame: '<path d="M12 20.5c-3.6 0-6-2.4-6-5.6 0-3.9 3.4-5.4 3.8-9.4 2.6 1.6 3.4 4.4 3 6.2 1-.4 1.8-1.4 2-2.8 1.8 1.4 3.2 3.7 3.2 6 0 3.2-2.4 5.6-6 5.6z"/>',
  plLeaf: '<path d="M5 19c0-8 5-13.5 14-14 .4 9-5 14-12 14z"/><path d="M5 19c3-4 6-6.5 9-8"/>',
  plBolt: '<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z"/>',
  plDumbbell: '<path d="M7 7.5v9M4.5 9.5v5M17 7.5v9M19.5 9.5v5M7 12h10"/>',
  plBook: '<path d="M12 6.5c-1.8-1.3-4.5-2-7.5-2v13c3 0 5.7.7 7.5 2 1.8-1.3 4.5-2 7.5-2v-13c-3 0-5.7.7-7.5 2z"/><path d="M12 6.5v13"/>',
  plHome: '<path d="M4.5 11L12 4.5l7.5 6.5"/><path d="M6.5 9.5v10h11v-10"/><path d="M10 19.5v-5h4v5"/>',
  plCloud: '<path d="M7.5 18a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.1A3.5 3.5 0 0 1 17 18z"/>',
  plRain: '<path d="M7.5 14a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.1A3.5 3.5 0 0 1 17 14z"/><path d="M8.5 17l-1 2.5M12.5 17l-1 2.5M16.5 17l-1 2.5"/>',
  plSnow: '<path d="M12 3.5v17M4.6 7.75l14.8 8.5M4.6 16.25l14.8-8.5"/><path d="M10 5l2 1.5 2-1.5M10 19l2-1.5 2 1.5"/>',
  plSparkle: '<path d="M10 4l1.6 4.4L16 10l-4.4 1.6L10 16l-1.6-4.4L4 10l4.4-1.6z"/><path d="M17.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  plClock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  plBriefcase: '<rect x="3.5" y="7.5" width="17" height="11.5" rx="1.5"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17"/>',
  plGamepad: '<path d="M7.5 8h9a4 4 0 0 1 3.9 4.9l-.8 3.4a2 2 0 0 1-3.4.9L14.5 15h-5l-1.7 2.2a2 2 0 0 1-3.4-.9l-.8-3.4A4 4 0 0 1 7.5 8z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="15.5" cy="11" r=".8" fill="currentColor"/><circle cx="17" cy="13" r=".8" fill="currentColor"/>',
  plParty: '<path d="M4.5 19.5l4-11 7 7z"/><path d="M13 5.5c.5-1 1.5-1.5 2.5-1M17 9c1-.6 2.2-.6 3 0M14.5 8.5l2-2"/><circle cx="19" cy="5" r=".8" fill="currentColor"/>',
  plCrown: '<path d="M4.5 17.5l-1-9 5 4 3.5-6 3.5 6 5-4-1 9z"/><path d="M4.5 20h15"/>',
  plGlobe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.2 2.2 3.3 4.9 3.3 8s-1.1 5.8-3.3 8c-2.2-2.2-3.3-4.9-3.3-8S9.8 6.2 12 4z"/>',
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
