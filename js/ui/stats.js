// Listening stats: what you play most, and how your listening and library
// have grown. Read from the whole Collection (every song's play count, dates
// and, when foo_enhanced_playcount is installed, the time of every play).
//
// Play counts and dates come from foo_playcount, or Playcount 2003. Plays
// over time and by hour need the time of each play, which only Enhanced
// Playback Statistics (foo_enhanced_playcount) records; without it the page
// says so and shows the library's growth instead.

import { el, plural, formatDuration } from '../core/util.js';
import { icon } from '../core/icons.js';
import { playlists, COLLECTION } from '../data/playlists.js';
import { bindArt } from '../data/artwork.js';
import { view } from '../data/view.js';
import { listening, listeningData, knownData, playSong, currentRows } from '../data/listening.js';
import { InlineAlbum } from './inlinealbum.js';
import { contextMenu, refreshAlbums } from './menus.js';
import { loadLocale, formatHour, formatMonth, formatMonthLong, formatDay } from '../core/locale.js';
import { tabBar } from './tabs.js';
import { albumCard } from './tipcards.js';

const TOP = 10;
const TOP_ALBUMS_MAX = 40; // ten or more: enough to fill the last row
const FORGOTTEN_DAYS = 182;

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
    // Top albums open in place, as albums do in the Collection.
    this.album = new InlineAlbum({ scroller, className: 'stats-album-panel' });
    this.groups = new Map(); // album key -> its group (rows in the Collection)
    scroller.append(this.wrap);
    this.resize = new ResizeObserver(() => (this.album.layout(), this.#fitAlbums()));
    this.resize.observe(this.wrap);
    // Played or retagged songs are read again on their own (listening.js):
    // the page is redrawn where it is.
    this.offChange = listening.on('change', () => this.#update());
    this.load();
  }

  destroy() {
    this.dead = true;
    this.offChange();
    this.resize.disconnect();
    this.album.destroy();
    this.wrap.remove();
  }

  refreshPlaying() {
    this.album.refreshPlaying();
  }

  refreshSelection() {
    this.album.refreshSelection();
  }

  /** The page's own redraw (the content area calls this after scrolling). */
  render() {
    if (this.tracks) this.#draw();
  }

  #update() {
    if (this.dead || !this.pl) return;
    const tracks = knownData(this.pl);
    if (!tracks) return;
    this.tracks = tracks;
    this.hasTimes = tracks.some((t) => t.times.length);
    const top = this.scroller.scrollTop;
    this.#draw();
    this.scroller.scrollTop = top;
  }

  async load() {
    const pl = playlists.byName(COLLECTION);
    if (!pl) return this.wrap.replaceChildren(el('p.stats-note', { text: 'Listening stats are worked out from the Collection, which isn’t there yet.' }));
    this.pl = pl;
    await loadLocale(); // dates and times as Windows has them
    if (this.dead) return;
    let tracks = knownData(pl);
    if (!tracks) {
      const bar = el('div.stats-progress', null, el('span'));
      this.wrap.replaceChildren(
        el('p.stats-note', { text: `Reading ${pl.trackCount.toLocaleString()} songs… The first time takes a while; after that it’s kept, and only new or played songs are read again.` }),
        bar,
      );
      tracks = await listeningData(pl, (f) => (bar.firstChild.style.width = `${Math.round(f * 100)}%`));
    }
    if (this.dead) return;
    if (!tracks) return this.wrap.replaceChildren(el('p.stats-note', { text: 'Couldn’t read the Collection.' }));
    this.tracks = tracks;
    this.hasTimes = tracks.some((t) => t.times.length);
    this.#draw();
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
      add(albums, t.albumKey, n, { title: t.album, artist: t.albumArtist, handle: t.handle });
      for (const g of t.genres) add(genres, g, n);
    }
    const top = (m, n = TOP) => [...m.values()].sort((a, b) => b.n - a.n).slice(0, n);

    const head = el(
      'div.stats-head',
      null,
      this.hasTimes
        ? tabBar(
            PERIODS.map(([id, label]) => [id, label]),
            { className: 'small', label: 'Period', picked: this.period, onPick: (id) => ((this.period = id), this.#draw()) },
          ).node
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
        this.#albums(top(albums, TOP_ALBUMS_MAX)),
        this.#songs(played.sort((a, b) => plays.get(b) - plays.get(a)).slice(0, TOP), plays),
      );
    }
    sections.push(this.#timeline());
    if (this.hasTimes) sections.push(this.#hours());
    if (any) sections.push(this.#forgotten());
    this.plays = plays;
    this.wrap.replaceChildren(head, tiles, ...sections);
    this.#fitAlbums();
  }

  /**
   * The most played albums: click one to open it right there, right-click
   * for its menu. At least ten, and the last row filled (see #fitAlbums).
   * Kept as it is when a redraw doesn't change them, so an open album stays
   * open (no flicker).
   */
  #albums(list) {
    if (!list.length) return el('div');
    const sig = list.map((a) => `${a.key}:${a.n}`).join('|');
    if (sig === this.albumsSig && this.albumsNode) return this.albumsNode;
    this.albumsSig = sig;
    const grid = el('div.stats-albums');
    const reopen = this.album.key;
    this.album.close({ animate: false });
    list.forEach((a, i) => {
      const img = el('img', { alt: '', decoding: 'async' });
      bindArt(img, a.handle, 160, ['front']);
      const tile = el(
        'button.stats-album',
        { dataset: { key: a.key, tip: `${a.title}\n${a.artist}\n${plural(a.n, 'play')}` }, onclick: () => this.#openAlbum(a, tile), oncontextmenu: (e) => this.#albumMenu(e, a) },
        el('span.stats-rank', { text: String(i + 1) }),
        el('div.art.ph-album', null, img),
        el('span.stats-album-t1.ellipsis', { text: a.title }),
        el('span.stats-album-t2.ellipsis', { text: `${a.artist} · ${plural(a.n, 'play')}` }),
      );
      tile.tipCard = () => this.#albumCard(a);
      grid.append(tile);
    });
    this.albumGrid = grid;
    this.albumList = list;
    this.albumsNode = el('section.stats-section', null, el('h3', { text: 'Top albums' }), grid);
    // Open before the redraw (one of its songs played): open again at once,
    // before the page is shown, so it doesn't flicker shut.
    if (reopen) this.pendingOpen = reopen;
    return this.albumsNode;
  }

  /** An album tile's hover card: its plays, songs and when it was last played. */
  #albumCard(a) {
    const songs = this.#songsOf(a);
    const last = songs.reduce((m, t) => (t.last > m ? t.last : m), '');
    return albumCard({
      title: a.title,
      artist: a.artist,
      handle: a.handle,
      facts: [songs[0]?.genres.slice(0, 3).join(', '), plural(songs.length, 'song')],
      notes: [`${plural(a.n, 'play')}${this.period === 'all' ? '' : ' in this period'}`, last ? `Last played ${formatDay(last)}` : null],
    });
  }

  /** Show at least ten albums, and as many more as fill the last row. */
  #fitAlbums() {
    const grid = this.albumGrid;
    if (!grid?.isConnected) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const want = Math.max(TOP, Math.ceil(TOP / cols) * cols);
    const tiles = [...grid.querySelectorAll('.stats-album')];
    tiles.forEach((t, i) => (t.hidden = i >= want));
    if (this.pendingOpen) {
      const key = this.pendingOpen;
      this.pendingOpen = null;
      const i = this.albumList.findIndex((a) => a.key === key);
      if (i >= 0 && !tiles[i].hidden) this.#openAlbum(this.albumList[i], tiles[i], { animate: false });
      return;
    }
    // Still under its row (the columns may have changed)?
    const open = this.album.tile;
    if (!open) return;
    if (open.hidden) return this.album.close({ animate: false });
    const end = this.#rowEnd(open);
    if (this.album.box.previousElementSibling !== end) {
      const a = this.albumList.find((x) => x.key === this.album.key);
      if (a) this.#openAlbum(a, open, { animate: false, force: true });
    }
  }

  /** The last tile shown in a tile's row. */
  #rowEnd(tile) {
    return [...this.albumGrid.querySelectorAll('.stats-album')].filter((t) => !t.hidden && t.offsetTop === tile.offsetTop).pop();
  }

  /** Open (or close) an album under its row of tiles. */
  #openAlbum(a, tile, { animate = true, force = false } = {}) {
    if (this.album.tile === tile && !force) return this.album.close();
    // Read before (the album was open): at once, with this redraw's plays.
    const known = this.groups.get(a.key);
    if (known) return this.#showAlbum(this.#withPlays(known, a), tile, animate);
    this.#group(a).then((group) => group && !this.dead && tile.isConnected && this.#showAlbum(group, tile, animate));
  }

  #showAlbum(group, tile, animate) {
    this.album.open(tile, group, this.#rowEnd(tile), { animate });
  }

  /** The album's songs here, in disc and track order. */
  #songsOf(a) {
    return this.tracks
      .filter((t) => t.albumKey === a.key)
      .sort((x, y) => (x.discKey || '').localeCompare(y.discKey || '') || (parseInt(x.number, 10) || 0) - (parseInt(y.number, 10) || 0));
  }

  /** Each song's plays (in the period shown) for the album panel. */
  #withPlays(group, a) {
    group.plays = new Map(this.#songsOf(a).map((t) => [t.handle, this.plays.get(t) || 0]));
    group.playsTotal = a.n;
    return group;
  }

  /**
   * An album as the Collection's album list has it: its songs' rows (in disc
   * and track order) and what its heading shows. The album list reads the
   * songs from the Collection, so that's the list the page has open.
   */
  async #group(a) {
    if (!(await collectionView(this.pl))) return null;
    const rows = await currentRows(this.pl, this.#songsOf(a));
    if (!rows.length) return null;
    // The heading's year and genre come from the songs once they're read.
    const group = { key: a.key, start: rows[0], count: rows.length, rows, head: { title: a.title, artist: a.artist, handle: a.handle }, partialHead: true };
    this.groups.set(a.key, group);
    return this.#withPlays(group, a);
  }

  /** An album tile's menu: foobar2000's for its songs, as the Collection's tiles have. */
  #albumMenu(e, a) {
    e.preventDefault();
    const songs = this.#songsOf(a);
    if (!songs.length) return;
    const tile = e.currentTarget;
    tile.classList.add('menu-open');
    const extra = [
      { label: 'Show in the Collection', run: () => goToAlbum(a.handle) },
      {
        label: 'Refresh album information',
        run: async () => {
          if (await collectionView(this.pl)) refreshAlbums(await currentRows(this.pl, songs));
        },
      },
    ];
    Promise.resolve(contextMenu({ mode: 'handles', handles: songs.map((t) => t.handle) }, extra)).finally(() => tile.classList.remove('menu-open'));
  }

  /** A song's menu (Top songs, Forgotten favourites): play it, go to its album or artist, and foobar2000's own. */
  #songMenu(e, t) {
    e.preventDefault();
    const row = e.currentTarget;
    row.classList.add('menu-open');
    const artists = t.artists.length ? t.artists : [t.albumArtist].filter(Boolean);
    const artistItems = artists.map((name) => ({ label: name, run: () => openValue('artists', name) }));
    const extra = [
      { label: 'Play', run: () => playSong(this.pl, t) },
      '-',
      { label: 'Go to album', run: () => goToAlbum(t.handle) },
      artistItems.length === 1 ? { label: 'Go to artist', run: artistItems[0].run } : artistItems.length ? { label: 'Go to artist', submenu: artistItems } : null,
      t.genres.length === 1 ? { label: 'Go to genre', run: () => openValue('genres', t.genres[0]) } : t.genres.length ? { label: 'Go to genre', submenu: t.genres.map((g) => ({ label: g, run: () => openValue('genres', g) })) } : null,
    ];
    Promise.resolve(contextMenu({ mode: 'handles', handles: [t.handle] }, extra)).finally(() => row.classList.remove('menu-open'));
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
            { title: `Play ${t.title}`, onclick: () => playSong(this.pl, t), oncontextmenu: (e) => this.#songMenu(e, t) },
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
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: formatMonth(d), tip: formatMonthLong(d), n: 0 });
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
    const hours = Array.from({ length: 24 }, (_, h) => ({ label: formatHour(h), n: 0, tip: formatHour(h) }));
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
            { title: 'Play', onclick: () => playSong(this.pl, t), oncontextmenu: (e) => this.#songMenu(e, t) },
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

/**
 * Make the Collection the list the page has open (it stays on Listening
 * stats): an album opened here reads, selects and plays its songs there.
 */
function collectionView(pl) {
  const ready = () => view.playlist?.guid === pl.guid && !view.loading;
  if (ready()) return Promise.resolve(true);
  if (playlists.activePlaylist?.guid !== pl.guid) playlists.activate(pl.index);
  return new Promise((resolve) => {
    const done = (ok) => {
      off();
      clearTimeout(timer);
      resolve(ok);
    };
    const off = view.on('change', () => ready() && done(true));
    const timer = setTimeout(() => done(ready()), 4000);
  });
}

/** An album, opened in the Collection. */
async function goToAlbum(handle) {
  view.goTo('albums', await view.albumKeyOf(handle));
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
