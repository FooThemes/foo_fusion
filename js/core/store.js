// Persistent settings. Stored as one JSON object in foo_ui_webview2's config
// store (inside the foobar2000 profile), so they survive foobar2000 updates and
// theme updates alike. Unknown keys from older versions are dropped on load.

import { call } from './bridge.js';
import { debounce } from './util.js';

const KEY = 'fusion.settings';

// Ties broken by album and track order.
const THEN = " | %album artist% | $if2(%album%,'Single(s)') | $num(%discnumber%,3) | $num(%tracknumber%,3) | %title%";

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
  length: { label: 'Length', pattern: '$num(%length_seconds%,6)' + THEN },
  path: { label: 'File path', pattern: '%path%' },
  // The Songs view's other columns (click a column's header to sort by it).
  trackartist: { label: 'Artist', pattern: "$if2(%artist%,'Unknown Artist')" + THEN },
  albumartist: { label: 'Album artist', pattern: "$if2(%album artist%,'Unknown Artist') | $if(%album%,%date%,'9999') | $if2(%album%,'Single(s)') | $num(%discnumber%,3) | $num(%tracknumber%,3) | %title%" },
  date: { label: 'Date', pattern: "$if2(%date%,'9999')" + THEN },
  track: { label: 'Track', pattern: '$num(%tracknumber%,3)' + THEN },
  disc: { label: 'Disc', pattern: '$num(%discnumber%,3)' + THEN },
  fav: { label: 'Favourite', pattern: "$if($stricmp(%mood%,Like it),0,$if($stricmp(%mood%,Hate it),2,1))" + THEN },
  codec: { label: 'Format', pattern: '[%codec%]' + THEN },
  bitrate: { label: 'Bitrate', pattern: '$num(%bitrate%,6)' + THEN },
  plays: { label: 'Plays', pattern: '$num(%play_count%,6)' + THEN },
};

// Which sort options each view offers, and which one it starts with.
export const VIEW_SORTS = {
  albums: ['album', 'artist', 'year', 'genre', 'added'],
  artists: ['artist'],
  genres: ['genre'],
  folders: ['path'],
  // Songs: every column (see songs.js), plus these two that aren't columns.
  songs: ['title', 'trackartist', 'album', 'albumartist', 'year', 'date', 'genre', 'track', 'disc', 'fav', 'length', 'codec', 'bitrate', 'plays', 'added', 'path'],
};

/** A sort by its key: one of SORTS, or a column of your own (Songs view). */
export function sortDef(key) {
  if (SORTS[key]) return SORTS[key];
  const c = (get('customColumns') || []).find((x) => x.id === key);
  return c ? { label: c.label, pattern: `${c.sort || c.pattern}${THEN}` } : null;
}

export const ACCENTS = [
  '#107C10', '#60A917', '#00ABA9', '#1BA1E2', '#0050EF', '#6A00FF', '#AA00FF',
  '#D80073', '#E51400', '#FA6800', '#F0A30A', '#825A2C', '#647687', '#76608A',
];

const DEFAULTS = {
  artVersion: 0, // bumped by "Refresh artwork" (see artwork.js)
  version: 2,
  dark: false,
  accent: '#107C10',
  view: 'albums', // albums | artists | genres | songs
  sort: { albums: 'album', artists: 'artist', genres: 'genre', songs: 'title', folders: 'path' },
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
  infoTab: 'details',
  lyricsHideCredits: true, // "Lyrics by：…" and "Title - Artist" lines some sources add
  // Where lyric files are, one title formatting pattern a line, without the
  // extension (.lrc, then .txt): beside the song, then foo_openlyrics' default.
  lyricsFiles: '$directory_path(%path%)\\%filename%\n%profile%\\lyrics\\$replace([%artist% - ][%title%],/,-,\\,-,<,-,>,-,:,-,",-,|,-,?,-,*,-)',
  selectionBar: true,
  smoothScroll: true,
  waveformSeekbar: false,
  releaseOnPause: true, // pausing on an ASIO output stops it (freeing the driver), keeping the place
  volumeFollowsWindows: true, // the volume slider is Windows' volume; foobar2000's follows it on exclusive/ASIO outputs
  artistInfoFolder: '', // Kodi-style artist folders (artist.nfo, artist.jpg, fanart.jpg), e.g. E:\\Music\\_Artists
  showRemaining: false, // player bar shows -time remaining instead of the length
  // Original / English / romanised versions (see data/versions.js).
  // Which version leads ('orig' | 'en' | 'rom'), and what follows it dimmed
  // ('auto' | 'orig' | 'en' | 'rom' | 'all' | 'none'), per kind of text.
  leadAlbums: 'en',
  leadDiscs: 'en',
  leadTitles: 'orig',
  leadArtists: 'orig',
  thenAlbums: 'auto',
  thenDiscs: 'auto',
  thenTitles: 'auto',
  thenArtists: 'auto',
  versionTooltips: true, // list every version in tooltips
  gifCovers: 'large', // animate GIF covers: 'large' (open album, Now Playing), 'everywhere' or 'never'
  artistNoPicture: 'cover', // artists without a picture: 'cover' (an album's), 'placeholder' (coloured silhouette) or 'plain'
  customColumns: [], // your own Songs view columns: [{ id, label, pattern, sort, right }] (sort: optional, how it sorts)
  playlistIcons: {}, // icons picked for playlists: { [guid]: icon name } (see ui/plicon.js)
  songColumns: null, // Songs view columns in order (null: the defaults, see songs.js)
  songColumnWidths: {}, // Songs view column -> width in px (sized by hand)
  genreInfoFolder: '', // one folder per genre: genre.nfo, folder.jpg, fanart.jpg
  genreSplit: ';', // characters that separate genres in one tag ("; , /": "Pop/Rock" is two)
  genreTiles: 'wide', // genre tiles: 'wide' (2:1, as the original) or 'square'
  artistScript: '', // path of tools/fusion-artist-info.py, to run it from Settings > Artists
  homeShelves: true, // rows of albums above the Collection's album grid
  shelves: [
    ['added', true],
    ['played', true],
    ['forgotten', true],
    ['most', false],
    ['unplayed', false],
    ['random', false],
  ], // [shelf, shown], in order (see ui/shelves.js)
  miniOnTop: true, // the mini player stays above other windows
  diagnostics: false, // Settings > More: timings and details in fusion.log
  hidePlaceholderArtists: true, // no tiles for [unknown], [dialogue]…
  dimEditionTags: true, // grey out '(Single)', '(Deluxe Edition)'… at the end of titles
  dimWords: 'Single, EP, Deluxe, Edition, Remaster, Remastered, Live, Bonus, Expanded, Anniversary, Reissue, Demo, Acoustic, Instrumental, Mono, Version, Remix, Radio Edit',
  sortOnOpen: true, // sort Collection/Favourites by the view's sort when opened
  favouritesQuery: 'MOOD IS "Like it"',
  folders: [], // [{ id, name, collapsed, items: [playlist GUID] }]
  autoplaylists: {}, // GUID -> { query, sort, keepSorted } for autoplaylists made or edited in Fusion
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
      // Language settings were two choices ("leadTracks" covered song titles
      // and artists) plus one "otherVersion" for everything.
      const old = res.value;
      if (old.leadTracks && !('leadTitles' in old)) data.leadTitles = data.leadArtists = old.leadTracks;
      if (old.leadAlbums && !('leadDiscs' in old)) data.leadDiscs = old.leadAlbums;
      if (old.otherVersion && old.otherVersion !== 'beside' && !('thenTitles' in old)) {
        data.thenAlbums = data.thenDiscs = data.thenTitles = data.thenArtists = 'none';
        data.versionTooltips = old.otherVersion === 'tooltip';
      }
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

/** Default value of a setting (e.g. for a "Defaults" button). */
export function defaultOf(key) {
  return structuredClone(DEFAULTS[key]);
}
