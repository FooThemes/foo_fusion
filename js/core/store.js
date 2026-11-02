// Persistent settings. Stored as one JSON object in foo_ui_webview2's config
// store (inside the foobar2000 profile), so they survive foobar2000 updates and
// theme updates alike. Unknown keys from older versions are dropped on load.

import { call } from './bridge.js';
import { debounce } from './util.js';

const KEY = 'fusion.settings';

export const SORTS = {
  album: {
    label: 'Album',
    pattern: "$if2(%album%,'Single(s)') | %album artist% | $if(%album%,%date%,'9999') | $num(%discnumber%,3) | $num(%tracknumber%,3) | %title%",
  },
  artist: {
    label: 'Artist',
    pattern: "$if2(%album artist%,'Unknown Artist') | $if(%album%,%date%,'9999') | $if2(%album%,'Single(s)') | $num(%discnumber%,3) | $num(%tracknumber%,3) | %title%",
  },
  year: {
    label: 'Year',
    pattern: "$if2(%date%,'9999') | %album artist% | $if2(%album%,'Single(s)') | $num(%discnumber%,3) | $num(%tracknumber%,3) | %title%",
  },
  genre: {
    label: 'Genre',
    pattern: "$if2(%genre%,'Unknown Genre') | %album artist% | $if(%album%,%date%,'9999') | $if2(%album%,'Single(s)') | $num(%discnumber%,3) | $num(%tracknumber%,3) | %title%",
  },
  added: {
    label: 'Date added',
    pattern: "$if2(%added%,0) | %album artist% | $if2(%album%,'Single(s)') | $num(%discnumber%,3) | $num(%tracknumber%,3)",
  },
  title: { label: 'Title', pattern: '%title% | %artist%' },
  length: { label: 'Length', pattern: '$num(%length_seconds%,6)' },
  path: { label: 'File path', pattern: '%path%' },
};

// Which sort options each view offers, and which one it starts with.
export const VIEW_SORTS = {
  albums: ['album', 'artist', 'year', 'genre', 'added'],
  artists: ['artist'],
  genres: ['genre'],
  songs: ['title', 'artist', 'album', 'year', 'genre', 'length', 'added', 'path'],
};

export const ACCENTS = [
  '#107C10', '#A4C400', '#60A917', '#008A00', '#00ABA9', '#1BA1E2', '#0050EF', '#6A00FF',
  '#AA00FF', '#F472D0', '#D80073', '#A20025', '#E51400', '#FA6800', '#F0A30A', '#E3C800',
  '#825A2C', '#6D8764', '#647687', '#76608A', '#87794E',
];

const DEFAULTS = {
  version: 2,
  dark: false,
  accent: '#107C10',
  view: 'albums', // albums | artists | genres | songs
  sort: { albums: 'album', artists: 'artist', genres: 'genre', songs: 'title' },
  sortDescending: false,
  sidebarWidth: 250,
  sidebarCollapsed: false, // icons only
  sidebarHidden: false, // gone entirely (Ctrl+M, like the original's playlist manager toggle)
  separateDiscs: false, // one tile per album; discs are split inside the expanded list
  tileSize: 150, // minimum tile width in px
  artistTileSize: 130,
  showAlbumYear: true,
  showTrackCounts: false,
  showPlaylistCounts: false,
  listBackground: 'blur', // blur | color | plain
  listArtLeft: true,
  largeNowPlayingArt: false,
  infoPanel: false,
  selectionBar: true,
  smoothScroll: true,
  sortOnOpen: true, // sort Collection/Favorites by the view's sort when opened
  favouritesQuery: 'MOOD IS "Like it"',
  appliedSort: {}, // playlist GUID -> sort applied by Fusion, so it isn't redone needlessly
};

const listeners = new Set();
let data = structuredClone(DEFAULTS);

const save = debounce(() => {
  call('config.set', { key: KEY, value: data }).catch(() => {});
}, 400);

export async function load() {
  try {
    const res = await call('config.get', { key: KEY });
    if (res.found && res.value && typeof res.value === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        if (k in res.value) data[k] = res.value[k];
      }
      data.sort = { ...DEFAULTS.sort, ...(res.value.sort || {}) };
      // v2: discs are handled inside the album list, so stop splitting tiles
      // by disc unless the user turns it back on.
      if ((res.value.version || 1) < 2) data.separateDiscs = false;
      data.version = DEFAULTS.version;
    }
  } catch {
    // First run, or the store is unavailable: defaults are fine.
  }
  return data;
}

export function get(key) {
  return data[key];
}

export function set(key, value) {
  if (data[key] === value) return;
  data[key] = value;
  save();
  for (const fn of listeners) fn(key, value);
}

export function update(key, patch) {
  set(key, { ...data[key], ...patch });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reset() {
  data = structuredClone(DEFAULTS);
  save();
  for (const k of Object.keys(data)) for (const fn of listeners) fn(k, data[k]);
}
