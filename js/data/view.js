// The main area's data: the active playlist, grouped for the current view.
//
// Fusion always shows the *active playlist* (like the original skin): the
// Collection autoplaylist for the library, or any other playlist. Grouping is
// done by foobar2000 (playlist.getGroupRuns), off the UI thread and without
// copying every track over the bridge. Only what is on screen is fetched.

import { call, tryCall, on, onAny } from '../core/bridge.js';
import { logInfo } from '../core/log.js';
import { Emitter } from '../core/emitter.js';
import { debounce, serialize } from '../core/util.js';
import * as store from '../core/store.js';
import { SORTS } from '../core/store.js';
import { TF, searchQuery } from './patterns.js';
import { playlists, COLLECTION, FAVORITES } from './playlists.js';
import { MOOD_TF } from './favourites.js';

const HEAD_CHUNK = 1000;
export const TRACK_FIELDS = ['handle', 'title', 'artist', 'album', 'albumArtist', 'date', 'genre', 'duration', 'trackNumber', 'discNumber'];

class View extends Emitter {
  playlist = null; // PlaylistInfo of the active playlist
  mode = 'albums'; // albums | artists | genres | songs | nowplaying
  filter = '';
  drill = null; // { kind: 'artists' | 'genres', key, label }
  groups = []; // { key, start, count, rows?, sub?, head? }
  rows = null; // songs view: row indices (null = every row)
  total = 0; // rows shown (after filtering)
  loading = false;
  reversed = false; // descending order shown for a locked (auto)playlist
  selection = new Set();
  #trackCache = new Map(); // row -> track
  #generation = 0;
  #ownSortUntil = 0;

  async init() {
    this.mode = store.get('view');
    const reload = debounce(() => this.load(), 120);
    const reloadIfActive = (d) => {
      if (performance.now() < this.#ownSortUntil) return;
      if (!this.playlist || d.playlist == null || d.playlist === this.playlist.index) reload();
    };
    onAny(['playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReordered', 'playlist:itemsReplaced'], reloadIfActive);
    on('metadb:changed', debounce(() => this.refreshHeads(), 600));
    on('playlist:selectionChanged', debounce((d) => {
      if (this.playlist && d.playlist === this.playlist.index) this.syncSelection();
    }, 30));
    playlists.on('active', () => {
      this.drill = null;
      this.filter = '';
      this.emit('filter', '');
      this.load();
    });
    store.subscribe((key) => {
      if (key === 'separateDiscs') this.load();
    });
  }

  get isLibrary() {
    return playlists.isSpecial(this.playlist);
  }

  get canEdit() {
    return !!this.playlist && !this.playlist.isAutoplaylist && !this.playlist.isLocked;
  }

  setMode(mode) {
    if (mode !== 'nowplaying') store.set('view', mode);
    const regroup = mode !== this.mode && mode !== 'nowplaying';
    this.mode = mode;
    this.drill = null;
    this.emit('mode', mode);
    // Re-sort only if this tab's sort isn't applied yet (load() checks the
    // remembered stamp); forcing it here rebuilt the library on every switch.
    if (regroup) this.load();
  }

  setFilter(text) {
    if (text === this.filter) return;
    this.filter = text;
    this.emit('filter', text);
    this.load();
  }

  openDrill(group) {
    this.drill = { kind: this.mode, key: group.key, label: group.key };
    this.load();
  }

  closeDrill() {
    this.drill = null;
    this.load();
  }

  async setSort(sortKey, descending = store.get('sortDescending')) {
    const mode = this.mode === 'nowplaying' ? 'albums' : this.mode;
    store.update('sort', { [mode]: sortKey });
    store.set('sortDescending', descending);
    await this.load({ sort: true });
  }

  currentSortKey() {
    const mode = this.mode === 'nowplaying' ? 'albums' : this.mode;
    return store.get('sort')[mode];
  }

  /** Re-read the active playlist and regroup it. */
  #headsFor = '';
  #sortCache = null; // { guid, count, pattern, rows }

  /**
   * Row order for the songs view of a locked playlist, sorted here: runs of
   * the sort key come from foobar2000 (off the UI thread) and are sorted with
   * a natural, case-insensitive compare. Cached until the playlist changes.
   */
  async #sortedRows(pl, pattern, desc) {
    const c = this.#sortCache;
    let rows = c && c.guid === pl.guid && c.count === pl.trackCount && c.pattern === pattern ? c.rows : null;
    if (!rows) {
      const res = await tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns: [pattern] });
      if (!res) return null;
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      const runs = res.runs.slice().sort((a, b) => collator.compare(a.key, b.key) || a.start - b.start);
      rows = [];
      for (const r of runs) for (let i = 0; i < r.count; i++) rows.push(r.start + i);
      this.#sortCache = { guid: pl.guid, count: pl.trackCount, pattern, rows };
    }
    return desc ? rows.slice().reverse() : rows;
  }

  load = serialize(async (opts = {}) => {
    const gen = ++this.#generation;
    const t0 = performance.now();
    this.loading = true;
    this.emit('loading', true);
    await playlists.refresh();
    const pl = playlists.activePlaylist;
    this.playlist = pl;
    this.#trackCache.clear();

    if (!pl) {
      this.groups = [];
      this.rows = [];
      this.total = 0;
      return this.#done(gen);
    }

    // The original skin sorted the library playlist into the view's order every
    // time it was shown. We sort when asked, and when a library playlist's
    // order doesn't match the view's sort yet (remembered across sessions).
    const sortKey = this.currentSortKey();
    const desc = !!store.get('sortDescending');
    const pattern = (SORTS[sortKey] || SORTS.album).pattern;
    // Remember the pattern itself, so a changed pattern (in an update) re-sorts.
    const stamp = pattern + (pl.isLocked ? '' : desc ? ':desc' : '');
    // Artist and genre tiles are listed alphabetically whatever the playlist
    // order, so switching to those tabs never re-sorts (re-sorting a library
    // autoplaylist means foobar2000 rebuilds it, which takes a while).
    const valueView = (this.mode === 'artists' || this.mode === 'genres') && !this.drill;
    // Songs in an autoplaylist are sorted here instead (see #sortedRows), so
    // going between Songs and Albums doesn't rebuild the library either.
    const clientSongs = this.mode === 'songs' && pl.isLocked;
    const wantSort = !clientSongs && (opts.sort || (!valueView && store.get('sortOnOpen') && this.isLibrary && store.get('appliedSort')[pl.guid] !== stamp));
    this.reversed = false;
    if (wantSort && pl.trackCount > 0 && this.canSort(pl)) {
      this.#ownSortUntil = performance.now() + 30000;
      if (!pl.isLocked) {
        await tryCall('playlist.sort', { playlist: pl.index, pattern, descending: desc });
        store.update('appliedSort', { [pl.guid]: stamp });
        this.#ownSortUntil = performance.now() + 600;
      } else {
        // foobar2000 refills a re-created autoplaylist in the background; let
        // its change events trigger the reload instead of ignoring them.
        this.#ownSortUntil = 0;
        const t0 = performance.now();
        const before = pl.trackCount;
        const ok = await this.#resortAutoplaylist(pl, pattern);
        if (ok) {
          store.update('appliedSort', { [pl.guid]: stamp });
          // Wait (briefly) for foobar2000 to refill it, checking often,
          // instead of showing it half full or waiting on fixed timers.
          while (performance.now() - t0 < 3000) {
            await new Promise((r) => setTimeout(r, 50));
            await playlists.refresh();
            const now = playlists.activePlaylist;
            if (!now || now.guid !== pl.guid || now.trackCount >= before) break;
          }
          // In case it was still filling when we gave up.
          setTimeout(() => this.load(), 1500);
        }
        logInfo(`re-sorted ${pl.name} (${before} tracks) by ${sortKey} in ${Math.round(performance.now() - t0)} ms`);
      }
    }
    // Autoplaylists are locked against reordering, so "descending" is applied
    // to what we show rather than to the playlist itself.
    this.reversed = pl.isLocked && desc;

    let matched = null;
    const q = this.filter ? searchQuery(this.filter) : '';
    if (q) {
      const res = await tryCall('playlist.getMatchingRows', { playlist: pl.index, query: q });
      matched = res ? res.items : [];
    }
    if (gen !== this.#generation) return;

    if (this.mode === 'songs' || this.mode === 'nowplaying') {
      this.groups = [];
      if (clientSongs) {
        const sorted = await this.#sortedRows(pl, pattern, desc);
        if (gen !== this.#generation) return;
        if (sorted) {
          const keep = matched && new Set(matched);
          this.rows = keep ? sorted.filter((r) => keep.has(r)) : sorted;
          this.total = this.rows.length;
          await this.syncSelection(false);
          return this.#done(gen);
        }
      }
      this.rows = this.reversed ? (matched || Array.from({ length: pl.trackCount }, (_, i) => i)).reverse() : matched;
      this.total = matched ? matched.length : pl.trackCount;
      await this.syncSelection(false);
      return this.#done(gen);
    }

    // foobar2000 finds runs of adjacent rows with the same key (fast, off the
    // UI thread). Runs with the same key are then merged, so an album or artist
    // shows once however the playlist is sorted, and multi-value fields
    // (ARTISTS, GENRE: "A; B") put a song under each of its values.
    const albumKey = store.get('separateDiscs') ? TF.albumDiscKey : TF.albumKey;
    const kind = this.drill?.kind || this.mode;
    const parentKey = kind === 'genres' ? TF.genresMulti : TF.artistsMulti;
    const patterns = kind === 'albums' ? [albumKey] : [parentKey, albumKey];
    const res = await tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns });
    if (gen !== this.#generation) return;
    const runs = res?.runs || [];

    let groups;
    if (kind === 'albums') {
      groups = mergeRuns(runs.map((r) => ({ key: r.key, start: r.start, count: r.count })));
    } else if (this.drill) {
      // Albums of one artist/genre: the album runs inside every run that lists it.
      const want = this.drill.key.toLowerCase();
      const subs = runs.filter((r) => splitValues(r.key).some((v) => v.toLowerCase() === want)).flatMap((r) => r.sub || []);
      groups = mergeRuns(subs);
    } else {
      groups = groupByValues(runs, kind === 'genres' ? UNKNOWN_GENRE : UNKNOWN_ARTIST);
    }
    if (matched) groups = intersect(groups, matched);
    // Artist/genre tiles are alphabetical, so "descending" flips them directly.
    const valueTiles = kind !== 'albums' && !this.drill;
    if (valueTiles ? store.get('sortDescending') : this.reversed) groups.reverse();
    // Keep what we already know about each group (title, art path), so tiles
    // that only moved don't blank out until the heads are fetched again.
    if (this.groups.length && this.#headsFor === `${pl.guid}|${kind}|${this.drill?.key || ''}|${albumKey}`) {
      const old = new Map(this.groups.map((g) => [g.key, g.head]));
      for (const g of groups) if (!g.head && old.get(g.key)) g.head = old.get(g.key);
    }
    this.#headsFor = `${pl.guid}|${kind}|${this.drill?.key || ''}|${albumKey}`;
    this.groups = groups;
    this.total = groups.reduce((n, g) => n + g.count, 0);
    this.rows = null;
    await this.syncSelection(false);
    this.#done(gen);
    this.#loadHeads(gen);
  });

  /** Sorting needs an unlocked playlist, or one of Fusion's own autoplaylists. */
  canSort(pl = this.playlist) {
    return !!pl && (!pl.isLocked || (pl.isAutoplaylist && playlists.isSpecial(pl)));
  }

  /**
   * Autoplaylists can't be reordered, but their sort pattern can be set when
   * they are created. foobar2000 doesn't expose an autoplaylist's query, so
   * this only works for Fusion's own Collection and Favorites, whose queries
   * we know.
   */
  async #resortAutoplaylist(pl, pattern) {
    const query = pl.name === COLLECTION ? 'ALL' : pl.name === FAVORITES ? store.get('favouritesQuery') : null;
    if (!query) return false;
    const released = await tryCall('playlist.removeAutoplaylist', { playlist: pl.index });
    if (!released || released.source === 'dui') {
      console.warn('[fusion] could not release autoplaylist for sorting:', released);
      return false;
    }
    const res = await tryCall('playlist.convertToAutoplaylist', { playlist: pl.index, query, sort: pattern, keepSorted: true });
    if (!res) console.warn('[fusion] could not re-create autoplaylist', pl.name);
    return !!res;
  }

  #done(gen) {
    if (gen !== this.#generation) return;
    this.loading = false;
    this.emit('loading', false);
    this.emit('change');
  }

  /** Fetch display text + art path for each group's first row, in chunks. */
  async #loadHeads(gen) {
    const title = store.get('separateDiscs') ? TF.albumDiscTitle : TF.albumTitle;
    const formats = { t: title, a: TF.albumArtist, y: TF.year, g: TF.genre };
    for (let i = 0; i < this.groups.length; i += HEAD_CHUNK) {
      const chunk = this.groups.slice(i, i + HEAD_CHUNK);
      const res = await tryCall('playlist.getTracksAt', {
        playlist: this.playlist.index,
        rows: chunk.map((g) => firstRow(g)),
        fields: ['handle'],
        formats,
      });
      if (gen !== this.#generation || !res) return;
      res.tracks.forEach((t, n) => {
        chunk[n].head = { handle: t.handle, title: t.formats.t, artist: t.formats.a, year: t.formats.y, genre: t.formats.g };
      });
      this.emit('heads', { from: i, to: i + chunk.length });
    }
  }

  refreshHeads() {
    if (this.mode === 'songs') {
      this.#trackCache.clear();
      this.emit('change');
    } else this.#loadHeads(this.#generation);
  }

  /** Row indices of a group (expanded list, play, selection). */
  groupRows(g) {
    if (g.rows) return g.rows;
    return Array.from({ length: g.count }, (_, i) => g.start + i);
  }

  /** Row index for position n in the songs view. */
  rowAt(n) {
    return this.rows ? this.rows[n] : n;
  }

  /** Fetch track data for playlist rows, with a per-load cache. */
  async tracks(rows) {
    const missing = rows.filter((r) => !this.#trackCache.has(r));
    if (missing.length && this.playlist) {
      const gen = this.#generation;
      for (let i = 0; i < missing.length; i += 500) {
        const res = await tryCall('playlist.getTracksAt', {
          playlist: this.playlist.index,
          rows: missing.slice(i, i + 500),
          fields: TRACK_FIELDS,
          formats: { n: TF.trackNumber, ds: TF.discSubtitle, m: MOOD_TF },
        });
        if (gen !== this.#generation) return rows.map(() => null);
        res?.tracks.forEach((t) => this.#trackCache.set(t.index, t));
      }
    }
    return rows.map((r) => this.#trackCache.get(r) || null);
  }

  cachedTrack(row) {
    return this.#trackCache.get(row) || null;
  }

  // --- selection (mirrors the foobar2000 playlist selection) ---------------

  async syncSelection(emit = true) {
    if (!this.playlist) return;
    const res = await tryCall('playlist.getSelection', { playlist: this.playlist.index });
    this.selection = new Set(res?.items || []);
    if (emit) this.emit('selection', this.selection);
  }

  async select(rows, { add = false, focus } = {}) {
    if (!this.playlist) return;
    if (add) rows.forEach((r) => this.selection.add(r));
    else this.selection = new Set(rows);
    this.emit('selection', this.selection);
    await tryCall('playlist.setSelection', { playlist: this.playlist.index, indices: [...this.selection], clearOthers: true });
    if (focus != null) await tryCall('playlist.setFocusedTrack', { playlist: this.playlist.index, index: focus });
  }

  async toggle(row) {
    if (this.selection.has(row)) this.selection.delete(row);
    else this.selection.add(row);
    await this.select([...this.selection], { focus: row });
  }

  clearSelection() {
    return this.select([]);
  }

  // --- actions -------------------------------------------------------------

  play(row) {
    if (!this.playlist) return;
    return call('playlist.playTrack', { playlist: this.playlist.index, index: row });
  }

  playGroup(g) {
    return this.play(firstRow(g));
  }

  queueRows(rows) {
    return call('queue.add', { playlist: this.playlist.index, tracks: rows });
  }

  async removeRows(rows) {
    if (!this.canEdit || !rows.length) return;
    await call('playlist.removeTracks', { playlist: this.playlist.index, items: rows });
    this.selection.clear();
  }

  async handlesFor(rows) {
    const out = [];
    for (let i = 0; i < rows.length; i += 2000) {
      const res = await tryCall('playlist.getTracksAt', { playlist: this.playlist.index, rows: rows.slice(i, i + 2000), fields: ['handle'] });
      res?.tracks.forEach((t) => out.push(t.handle));
    }
    return out;
  }

  async addRowsTo(targetIndex, rows) {
    const handles = await this.handlesFor(rows);
    if (handles.length) await call('playlist.addHandles', { playlist: targetIndex, handles });
    return handles.length;
  }
}

export function firstRow(g) {
  return g.rows ? g.rows[0] : g.start;
}

/** Keep only matched rows inside each group; drop groups left empty. */
function intersect(groups, matched) {
  const out = [];
  const set = new Set(matched);
  for (const g of groups) {
    let rows;
    if (g.rows) rows = g.rows.filter((r) => set.has(r));
    else {
      const lo = lowerBound(matched, g.start);
      const hi = lowerBound(matched, g.start + g.count);
      rows = matched.slice(lo, hi);
    }
    if (rows.length) out.push({ ...g, rows, count: rows.length });
  }
  return out;
}

const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_GENRE = 'Unknown Genre';
const SEP = '|||';

/** Values of a multi-value key: split on the field separator and on ";". */
function splitValues(key) {
  const out = [];
  const seen = new Set();
  for (const part of key.split(SEP)) {
    for (const v of part.split(';')) {
      const t = v.trim();
      if (t && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        out.push(t);
      }
    }
  }
  return out;
}

/** Merge runs with the same key (case-insensitive) into one group each. */
function mergeRuns(runs) {
  const map = new Map();
  for (const r of runs) {
    const k = r.key.toLowerCase();
    let g = map.get(k);
    if (!g) map.set(k, (g = { key: r.key, ranges: [] }));
    g.ranges.push([r.start, r.count]);
  }
  return [...map.values()].map(finishGroup);
}

/** Artists/genres: a group per value, holding every run that lists it. */
function groupByValues(runs, unknown) {
  const map = new Map();
  for (const r of runs) {
    const values = splitValues(r.key);
    if (!values.length) values.push(unknown);
    const albums = (r.sub || []).map((s) => s.key.toLowerCase());
    for (const v of values) {
      const k = v.toLowerCase();
      let g = map.get(k);
      if (!g) map.set(k, (g = { key: v, ranges: [], albums: new Set() }));
      g.ranges.push([r.start, r.count]);
      albums.forEach((a) => g.albums.add(a));
    }
  }
  const unknownKey = unknown.toLowerCase();
  return [...map.values()]
    .map((g) => ({ ...finishGroup(g), albumCount: g.albums.size }))
    .sort((a, b) => {
      // "Unknown ..." (blank tag) is pinned first, the rest alphabetical.
      const ua = a.key.toLowerCase() === unknownKey;
      const ub = b.key.toLowerCase() === unknownKey;
      if (ua !== ub) return ua ? -1 : 1;
      return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' });
    });
}

/** One range stays {start, count}; several become an explicit row list. */
function finishGroup(g) {
  if (g.ranges.length === 1) return { key: g.key, start: g.ranges[0][0], count: g.ranges[0][1] };
  const rows = [];
  for (const [start, count] of g.ranges.sort((a, b) => a[0] - b[0])) for (let i = 0; i < count; i++) rows.push(start + i);
  return { key: g.key, rows, count: rows.length };
}

function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const view = new View();
