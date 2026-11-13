// Listening stats: what you play most, and how your listening and library
// have grown. Read from the whole Collection (every song's play count, dates
// and, when foo_enhanced_playcount is installed, the time of every play).
//
// Play counts and dates come from foo_playcount, or Playcount 2003. Plays
// over time and by hour need the time of each play, which only Enhanced
// Playback Statistics (foo_enhanced_playcount) records; without it the page
// says so and shows the library's growth instead.

import { el, plural, formatDuration, debounce } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall, call, on } from '../core/bridge.js';
import { TF } from '../data/patterns.js';
import { playlists, COLLECTION } from '../data/playlists.js';
import { bindArt } from '../data/artwork.js';
import { view } from '../data/view.js';

const TOP = 10;
const FORGOTTEN_DAYS = 182;
// Every play's time, from foo_enhanced_playcount (its own plays, and the
// scrobbles it fetched from Last.fm). Empty without that component.
const TIMES = '[%played_times_js%]';
const LASTFM_TIMES = '[%lastfm_played_times_js%]';

let cache = null; // { key, data }

/** A play time from Enhanced Playback Statistics: ms, seconds or a date. */
function toMs(v) {
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}

function parseTimes(text) {
  if (!text || text[0] !== '[') return [];
  try {
    return JSON.parse(text).map(toMs).filter(Boolean);
  } catch {
    return [];
  }
}

const FORMATS = { ar: TF.artistsMulti, aa: TF.albumArtist, al: TF.albumTitle, k: TF.albumKey, gn: TF.genre, c: TF.playCountAny, l: TF.lastPlayedAny, a: TF.addedAny, pt: TIMES, lt: LASTFM_TIMES };
const FIELDS = ['handle', 'title', 'duration'];

function toTrack(t) {
  const f = t.formats || {};
  // Its own plays and Last.fm's, once each (the same play in both counts once).
  const own = parseTimes(f.pt);
  const lfm = parseTimes(f.lt).filter((x) => !own.some((o) => Math.abs(o - x) < 120000));
  const times = own.concat(lfm);
  return {
    row: t.index,
    handle: t.handle,
    title: t.title,
    duration: t.duration || 0,
    artists: (f.ar || '').split('|||').filter(Boolean),
    albumArtist: f.aa,
    album: f.al,
    albumKey: f.k,
    genres: (f.gn || '').split('|||').filter(Boolean),
    // The play counter, or every play known (with Last.fm's history the
    // times can go back further than the counter does).
    plays: Math.max(parseInt(f.c, 10) || 0, times.length),
    last: f.l || '',
    added: f.a || '',
    times,
  };
}

async function readAll(pl, onProgress, fresh = false) {
  const key = `${pl.guid}|${pl.trackCount}`;
  if (cache?.key === key && !fresh) return cache.data;
  const formats = FORMATS;
  const tracks = [];
  for (let from = 0; from < pl.trackCount; from += 2000) {
    const rows = Array.from({ length: Math.min(2000, pl.trackCount - from) }, (_, i) => from + i);
    const res = await tryCall('playlist.getTracksAt', { playlist: pl.index, rows, fields: FIELDS, formats });
    if (!res) return null;
    for (const t of res.tracks) tracks.push(toTrack(t));
    onProgress?.(Math.min(1, (from + 2000) / pl.trackCount));
  }
  cache = { key, at: Date.now(), data: tracks };
  return tracks;
}

const PERIODS = [
  ['all', 'All time', 0],
  ['year', 'Past year', 365],
  ['month', 'Past 30 days', 30],
];

export class StatsPage {
  constructor(scroller) {
    this.wrap = el('div.stats');
    this.period = 'all';
    this.scroller = scroller;
    scroller.append(this.wrap);
    // Played or retagged songs: only those are read again, and the page
    // redrawn where it is (not read from scratch).
    const changed = new Set();
    const refresh = debounce(() => {
      const handles = [...changed];
      changed.clear();
      this.#refresh(handles);
    }, 1500);
    this.offTags = on('metadb:changed', (d) => {
      for (const h of d.handles || []) changed.add(h);
      if (changed.size) refresh();
    });
    this.load();
  }

  destroy() {
    this.dead = true;
    this.offTags?.();
    this.wrap.remove();
  }

  /** The page's own redraw (the content area calls this after scrolling). */
  render() {
    if (this.tracks) this.#draw();
  }

  async #refresh(handles) {
    if (this.dead || !this.tracks || !handles.length) return;
    const byHandle = new Map(this.tracks.map((t, i) => [t.handle, i]));
    const idx = handles.map((h) => byHandle.get(h)).filter((i) => i != null);
    if (!idx.length) return;
    const res = await tryCall('playlist.getTracksAt', { playlist: this.pl.index, rows: idx.map((i) => this.tracks[i].row), fields: FIELDS, formats: FORMATS });
    if (this.dead || !res) return;
    for (const t of res.tracks) {
      const i = byHandle.get(t.handle);
      if (i != null) this.tracks[i] = toTrack(t);
    }
    this.hasTimes = this.tracks.some((t) => t.times.length);
    const top = this.scroller.scrollTop;
    this.#draw();
    this.scroller.scrollTop = top;
  }

  async load() {
    const pl = playlists.byName(COLLECTION);
    if (!pl) return this.wrap.replaceChildren(el('p.stats-note', { text: 'Listening stats are worked out from the Collection, which isn’t there yet.' }));
    const bar = el('div.stats-progress', null, el('span'));
    this.wrap.replaceChildren(el('p.stats-note', { text: `Reading ${pl.trackCount.toLocaleString()} songs…` }), bar);
    const tracks = await readAll(pl, (f) => (bar.firstChild.style.width = `${Math.round(f * 100)}%`));
    if (this.dead) return;
    if (!tracks) return this.wrap.replaceChildren(el('p.stats-note', { text: 'Couldn’t read the Collection.' }));
    this.pl = pl;
    this.tracks = tracks;
    this.hasTimes = tracks.some((t) => t.times.length);
    this.#draw();
    // Shown from what was read last time; read again quietly if that was a
    // while ago (songs played meanwhile), and redrawn in place.
    if (Date.now() - cache.at > 60000) {
      const again = await readAll(pl, null, true);
      if (this.dead || !again) return;
      this.tracks = again;
      this.hasTimes = again.some((t) => t.times.length);
      const top = this.scroller.scrollTop;
      this.#draw();
      this.scroller.scrollTop = top;
    }
  }

  /** Plays of a song in the chosen period (all of them without play times). */
  #plays(t) {
    const days = PERIODS.find((p) => p[0] === this.period)[2];
    if (!days || !this.hasTimes) return t.plays;
    const from = Date.now() - days * 864e5;
    return t.times.filter((x) => x >= from).length;
  }

  #draw() {
    const tracks = this.tracks;
    const plays = new Map(tracks.map((t) => [t, this.#plays(t)]));
    const total = [...plays.values()].reduce((a, b) => a + b, 0);
    const seconds = tracks.reduce((s, t) => s + plays.get(t) * t.duration, 0);
    const played = tracks.filter((t) => plays.get(t) > 0);
    const any = tracks.some((t) => t.plays || t.last);

    const add = (map, key, n, extra) => {
      if (!key) return;
      const e = map.get(key) || { key, n: 0, ...extra };
      e.n += n;
      map.set(key, e);
    };
    const artists = new Map();
    const albums = new Map();
    const genres = new Map();
    for (const t of played) {
      const n = plays.get(t);
      for (const a of t.artists) add(artists, a, n);
      add(albums, t.albumKey, n, { title: t.album, artist: t.albumArtist, handle: t.handle, row: t.row });
      for (const g of t.genres) add(genres, g, n);
    }
    const top = (m) => [...m.values()].sort((a, b) => b.n - a.n).slice(0, TOP);

    const head = el(
      'div.stats-head',
      null,
      this.hasTimes
        ? el(
            'div.stats-periods',
            { role: 'tablist' },
            ...PERIODS.map(([id, label]) => el('button.stats-period' + (id === this.period ? '.on' : ''), { role: 'tab', 'aria-selected': String(id === this.period), onclick: () => ((this.period = id), this.#draw()) }, label)),
          )
        : null,
    );

    const tiles = el(
      'div.stats-tiles',
      null,
      tile(total.toLocaleString(), total === 1 ? 'play' : 'plays'),
      tile(formatHours(seconds), 'listening'),
      tile(played.length.toLocaleString(), `of ${tracks.length.toLocaleString()} songs played`),
      tile(artists.size.toLocaleString(), artists.size === 1 ? 'artist played' : 'artists played'),
    );

    const sections = [];
    if (!any) {
      sections.push(
        el('p.stats-note', { text: 'No play counts found. Install foo_playcount (Playback Statistics) or Playcount 2003 and your plays will show up here as you listen.' }),
      );
    } else {
      sections.push(
        el('div.stats-cols', null, barList('Top artists', top(artists), (e) => openValue('artists', e.key)), barList('Top genres', top(genres), (e) => openValue('genres', e.key))),
        this.#albums(top(albums)),
        this.#songs(played.sort((a, b) => plays.get(b) - plays.get(a)).slice(0, TOP), plays),
      );
    }
    sections.push(this.#timeline());
    if (this.hasTimes) sections.push(this.#hours());
    if (any) sections.push(this.#forgotten());
    this.wrap.replaceChildren(head, tiles, ...sections);
  }

  #albums(list) {
    if (!list.length) return el('div');
    return el(
      'section.stats-section',
      null,
      el('h3', { text: 'Top albums' }),
      el(
        'div.stats-albums',
        null,
        ...list.map((a, i) => {
          const img = el('img', { alt: '', decoding: 'async' });
          bindArt(img, a.handle, 120, ['front']);
          return el(
            'button.stats-album',
            { title: `Open ${a.title}`, onclick: async () => view.goTo('albums', await view.albumKeyOf(a.handle)) },
            el('span.stats-rank', { text: String(i + 1) }),
            el('div.art.ph-album', null, img),
            el('span.stats-album-t1.ellipsis', { text: a.title }),
            el('span.stats-album-t2.ellipsis', { text: `${a.artist} · ${plural(a.n, 'play')}` }),
          );
        }),
      ),
    );
  }

  /** The most played songs: click one to play it. */
  #songs(list, plays) {
    if (!list.length) return el('div');
    const max = Math.max(1, ...list.map((t) => plays.get(t)));
    return el(
      'section.stats-section',
      null,
      el('h3', { text: 'Top songs' }),
      el(
        'div.stats-bars',
        null,
        ...list.map((t) =>
          el(
            'button.stats-bar.stats-bar-song',
            { title: `Play ${t.title}`, onclick: () => call('playlist.playTrack', { playlist: this.pl.index, index: t.row }) },
            el('span.stats-bar-name.ellipsis', null, el('span', { text: t.title }), el('span.dim', { text: ` · ${t.artists.join(', ')}` })),
            el('span.stats-bar-track', null, el('span.stats-bar-fill', { style: { width: `${(plays.get(t) / max) * 100}%` } })),
            el('span.stats-bar-n', { text: plays.get(t).toLocaleString() }),
          ),
        ),
      ),
    );
  }

  /** Plays per month with play times; else albums added per month. */
  #timeline() {
    const months = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), n: 0 });
    }
    const at = new Map(months.map((m) => [m.key, m]));
    let title;
    let unit;
    let note = null;
    if (this.hasTimes) {
      title = 'Plays by month';
      unit = 'play';
      for (const t of this.tracks)
        for (const x of t.times) {
          const d = new Date(x);
          const m = at.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
          if (m) m.n++;
        }
    } else {
      title = 'Library growth';
      unit = 'album';
      const seen = new Set();
      for (const t of this.tracks) {
        if (!t.added || seen.has(t.albumKey)) continue;
        seen.add(t.albumKey);
        const m = at.get(t.added.slice(0, 7));
        if (m) m.n++;
      }
      note = el('p.stats-note', { text: 'Albums added each month. For plays over time, install Enhanced Playback Statistics (foo_enhanced_playcount): it keeps the time of every play, and can fetch your Last.fm history.' });
    }
    return el('section.stats-section', null, el('h3', { text: title }), columns(months, unit), note);
  }

  #hours() {
    const hours = Array.from({ length: 24 }, (_, h) => ({ label: String(h), n: 0, tip: `${String(h).padStart(2, '0')}:00` }));
    const days = PERIODS.find((p) => p[0] === this.period)[2];
    const from = days ? Date.now() - days * 864e5 : 0;
    for (const t of this.tracks) for (const x of t.times) if (x >= from) hours[new Date(x).getHours()].n++;
    return el('section.stats-section', null, el('h3', { text: 'Time of day' }), columns(hours, 'play', 3));
  }

  /** Songs played a lot, but not for half a year. */
  #forgotten() {
    const cut = new Date(Date.now() - FORGOTTEN_DAYS * 864e5).toISOString().slice(0, 10);
    const list = this.tracks
      .filter((t) => t.plays >= 5 && t.last && t.last.slice(0, 10) < cut)
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 12);
    if (!list.length) return el('div');
    return el(
      'section.stats-section',
      null,
      el('h3', { text: 'Forgotten favourites' }),
      el('p.stats-sub', { text: 'Songs you played often, but not in the last six months' }),
      el(
        'div.stats-songs',
        null,
        ...list.map((t) =>
          el(
            'button.stats-song',
            { title: 'Play', onclick: () => call('playlist.playTrack', { playlist: this.pl.index, index: t.row }) },
            icon('play'),
            el('span.ellipsis', { text: t.title }),
            el('span.ellipsis.dim', { text: t.artists.join(', ') }),
            el('span.dim', { text: `${plural(t.plays, 'play')} · last ${t.last.slice(0, 10)}` }),
          ),
        ),
      ),
    );
  }
}

/** An artist's or genre's page in the Collection (Back returns here). */
async function openValue(kind, key) {
  if (playlists.activePlaylist?.name !== COLLECTION) await playlists.ensureCollection(true);
  view.showValue(kind, key);
}

function tile(value, label) {
  return el('div.stats-tile', null, el('div.stats-value', { text: value }), el('div.stats-label', { text: label }));
}

function formatHours(seconds) {
  if (seconds < 3600) return formatDuration(seconds);
  const h = Math.round(seconds / 3600);
  return h >= 48 ? `${Math.round(h / 24).toLocaleString()} days` : `${h} hours`;
}

/** A ranked list with a bar each (one colour: the accent). */
function barList(title, list, open) {
  const max = Math.max(1, ...list.map((e) => e.n));
  return el(
    'section.stats-section',
    null,
    el('h3', { text: title }),
    el(
      'div.stats-bars',
      null,
      ...list.map((e) =>
        el(
          'button.stats-bar',
          { title: `${e.key}: ${plural(e.n, 'play')}`, onclick: () => open(e) },
          el('span.stats-bar-name.ellipsis', { text: e.key }),
          el('span.stats-bar-track', null, el('span.stats-bar-fill', { style: { width: `${(e.n / max) * 100}%` } })),
          el('span.stats-bar-n', { text: e.n.toLocaleString() }),
        ),
      ),
    ),
  );
}

/** Vertical bars over time; labels every `every`th column. */
function columns(items, unit, every = 3) {
  const max = Math.max(1, ...items.map((m) => m.n));
  return el(
    'div.stats-cols-chart',
    null,
    ...items.map((m, i) =>
      el(
        'div.stats-col',
        { title: `${m.tip || m.label}: ${plural(m.n, unit)}` },
        el('span.stats-col-bar', { style: { height: `${(m.n / max) * 100}%` } }),
        el('span.stats-col-label', { text: i % every === 0 ? m.label : '' }),
      ),
    ),
  );
}
