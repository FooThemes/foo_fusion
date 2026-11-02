// The main area's data: the active playlist, grouped for the current view.
//
// Fusion always shows the *active playlist* (like the original skin): the
// Collection autoplaylist for the library, or any other playlist. Grouping is
// done by foobar2000 (playlist.getGroupRuns), off the UI thread and without
// copying every track over the bridge. Only what is on screen is fetched.

import { call, tryCall, on, onAny } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';
import { debounce, serialize } from '../core/util.js';
import * as store from '../core/store.js';
import { SORTS } from '../core/store.js';
import { TF, searchQuery } from './patterns.js';
import { playlists, COLLECTION, FAVORITES } from './playlists.js';

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
    if (regroup) this.load({ sort: this.isLibrary });
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
  load = serialize(async (opts = {}) => {
    const gen = ++this.#generation;
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
    const applied = store.get('appliedSort')[pl.guid];
    const wantSort = opts.sort || (store.get('sortOnOpen') && this.isLibrary && applied !== sortKey + (pl.isLocked ? '' : desc ? ':desc' : ''));
    this.reversed = false;
    if (wantSort && pl.trackCount > 0 && this.canSort(pl)) {
      const pattern = (SORTS[sortKey] || SORTS.album).pattern;
      this.#ownSortUntil = performance.now() + 30000;
      if (!pl.isLocked) {
        await tryCall('playlist.sort', { playlist: pl.index, pattern, descending: desc });
        store.update('appliedSort', { [pl.guid]: sortKey + (desc ? ':desc' : '') });
      } else if (await this.#resortAutoplaylist(pl, pattern)) {
        store.update('appliedSort', { [pl.guid]: sortKey });
      }
      this.#ownSortUntil = performance.now() + 600;
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
      this.rows = this.reversed ? (matched || Array.from({ length: pl.trackCount }, (_, i) => i)).reverse() : matched;
      this.total = matched ? matched.length : pl.trackCount;
      await this.syncSelection(false);
      return this.#done(gen);
    }

    const albumKey = store.get('separateDiscs') ? TF.albumDiscKey : TF.albumKey;
    const parentKey = (this.drill?.kind || this.mode) === 'genres' ? TF.genreKey : TF.artistKey;
    const patterns = this.mode === 'albums' && !this.drill ? [albumKey] : [parentKey, albumKey];
    const res = await tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns });
    if (gen !== this.#generation) return;
    let runs = res?.runs || [];

    if (this.drill) {
      // Albums of one artist/genre. The playlist is sorted by that field, so
      // its rows are adjacent; merge every run with the same key just in case.
      const k = this.drill.key.toLowerCase();
      runs = runs.filter((r) => r.key.toLowerCase() === k).flatMap((r) => r.sub || []);
    }

    let groups = runs.map((r) => ({ key: r.key, start: r.start, count: r.count, sub: r.sub }));
    if (matched) groups = intersect(groups, matched);
    if (this.reversed) groups.reverse();
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
    if (!released || released.source === 'dui') return false;
    const res = await tryCall('playlist.convertToAutoplaylist', { playlist: pl.index, query, sort: pattern, keepSorted: false });
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
          formats: { n: TF.trackNumber },
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
  for (const g of groups) {
    const lo = lowerBound(matched, g.start);
    const hi = lowerBound(matched, g.start + g.count);
    if (hi > lo) {
      const rows = matched.slice(lo, hi);
      const sub = g.sub ? intersect(g.sub, rows) : undefined;
      out.push({ ...g, rows, count: rows.length, sub });
    }
  }
  return out;
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
