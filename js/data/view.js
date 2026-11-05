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
import { playlists, COLLECTION, FAVORITES, PLAYBACK } from './playlists.js';
import { MOOD_TF, favourites } from './favourites.js';
import { versionsTF, parseVersions } from './versions.js';
import { player } from './player.js';

const HEAD_CHUNK = 1000;
export const TRACK_FIELDS = ['handle', 'title', 'artist', 'album', 'albumArtist', 'date', 'genre', 'duration', 'trackNumber', 'discNumber'];

const headCache = new Map(); // "kind|albumKey|group key" -> head, across playlists (session)

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
    // Tags edited (here or in foobar2000's Properties): regroup (an album or
    // artist name may have changed) and re-read the songs on screen.
    const changed = new Set();
    let everything = false;
    const onTags = debounce(async () => {
      const handles = [...changed];
      const all = everything;
      changed.clear();
      everything = false;
      // Our own heart clicks already updated the screen.
      if (!all && favourites.ownChange(handles)) return;
      this.#trackCache.clear();
      this.#sortCache = null;
      await this.load();
      this.emit('metadata');
    }, 350);
    on('metadb:changed', (d) => {
      if (d.truncated) everything = true;
      for (const h of d.handles || []) changed.add(h);
      onTags();
    });
    on('playlist:selectionChanged', debounce((d) => {
      if (this.playlist && d.playlist === this.playlist.index) this.syncSelection();
    }, 30));
    playlists.on('active', (pl) => {
      this.drill = null;
      this.backTo = null;
      this.filter = '';
      this.emit('filter', '');
      // Another playlist: the old one stays up until the new one is ready
      // (a few dozen ms), which reads as an instant switch.
      this.load();
    });
    store.subscribe((key) => {
      if (key === 'separateDiscs' || (key === 'hidePlaceholderArtists' && this.mode === 'artists')) this.load();
    });
  }

  get isLibrary() {
    return playlists.isSpecial(this.playlist);
  }

  get canEdit() {
    return !!this.playlist && !this.playlist.isAutoplaylist && !this.playlist.isLocked;
  }

  /** { load: false } when a playlist switch (which loads anyway) follows. */
  setMode(mode, { load = true } = {}) {
    if (mode !== 'nowplaying') store.set('view', mode);
    // Also when leaving an artist's or genre's page through its own tab:
    // back to the full list (which then returns to where it was scrolled).
    const regroup = (mode !== this.mode || !!this.drill) && mode !== 'nowplaying';
    this.mode = mode;
    this.drill = null;
    this.backTo = null;
    this.emit('mode', mode);
    // The old tab's tiles would otherwise show until the new ones are ready.
    if (regroup) this.#blank();
    // Re-sort only if this tab's sort isn't applied yet (load() checks the
    // remembered stamp); forcing it here rebuilt the library on every switch.
    if (regroup && load) this.load();
  }

  setFilter(text) {
    if (text === this.filter) return;
    this.filter = text;
    this.emit('filter', text);
    this.load();
  }

  openDrill(group) {
    this.drill = { kind: this.mode, key: group.key, label: group.key };
    this.backTo = null;
    this.#blank();
    this.load();
  }

  /**
   * Every artist or genre in the Collection: lower case -> the name as the
   * library writes it, for links that should only be clickable when there's
   * something to show (and in the library's spelling). Cached for a few
   * minutes.
   */
  libraryValues(kind) {
    const now = Date.now();
    const c = libraryCache[kind];
    if (c && now - c.at < 5 * 60 * 1000) return c.promise;
    const pl = playlists.byName(COLLECTION);
    const promise = !pl
      ? Promise.resolve(new Map())
      : tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns: [kind === 'genres' ? TF.genresMulti : TF.artistsMulti] }).then((res) => {
          const names = new Map();
          for (const r of res?.runs || []) for (const v of splitValues(r.key)) if (!names.has(v.toLowerCase())) names.set(v.toLowerCase(), v);
          return names;
        });
    libraryCache[kind] = { at: now, promise };
    return promise;
  }

  /**
   * Show an album (opened), an artist's or a genre's page from the
   * Collection, from anywhere: another playlist, Favourites, a search, Now
   * playing. `key` is an album key (see albumKeyOf) or an artist/genre name.
   */
  async goTo(kind, key) {
    let pl = playlists.byName(COLLECTION);
    if (!pl) {
      await playlists.ensureCollection(false);
      pl = playlists.byName(COLLECTION);
    }
    if (!pl || !key) return;
    // Switching playlists resets the page (see the 'active' handler), so
    // switch first and set the page after.
    if (playlists.activePlaylist?.guid !== pl.guid) {
      await new Promise((resolve) => {
        const off = playlists.on('active', () => (off?.(), resolve()));
        playlists.activate(pl.index);
        setTimeout(resolve, 1500);
      });
    }
    if (this.filter) {
      this.filter = '';
      this.emit('filter', '');
    }
    this.backTo = null;
    store.set('view', kind);
    this.mode = kind;
    if (kind === 'albums') {
      this.drill = null;
      this.returning = { expandedKey: key }; // the grid opens it once loaded
    } else this.drill = { kind, key, label: key };
    this.emit('mode', kind);
    this.#blank();
    this.load();
  }

  /** The album key (as tiles use) of a track, for goTo('albums', …). */
  async albumKeyOf(handle) {
    const res = await tryCall('titleformat.evalFields', { path: handle, fields: { k: store.get('separateDiscs') ? TF.albumDiscKey : TF.albumKey } });
    return res?.k || null;
  }

  /** Songs per album in the Collection (album key -> count), cached for a few minutes. */
  albumTotals() {
    const pattern = store.get('separateDiscs') ? TF.albumDiscKey : TF.albumKey;
    const c = libraryCache['albums:' + pattern];
    if (c && Date.now() - c.at < 5 * 60 * 1000) return c.promise;
    const pl = playlists.byName(COLLECTION);
    const promise = !pl
      ? Promise.resolve(new Map())
      : tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns: [pattern] }).then((res) => {
          const totals = new Map();
          for (const r of res?.runs || []) totals.set(r.key.toLowerCase(), (totals.get(r.key.toLowerCase()) || 0) + r.count);
          return totals;
        });
    libraryCache['albums:' + pattern] = { at: Date.now(), promise };
    return promise;
  }

  /** Is this the whole Collection, unfiltered (where every album is complete)? */
  get isFullCollection() {
    return this.playlist?.name === COLLECTION && !this.filter && !this.drill && this.mode === 'albums';
  }

  /** Jump to one artist's or genre's albums (from the expanded album's links). */
  showValue(kind, key, fromGroup) {
    this.backTo = { mode: this.mode, drill: this.drill, expandedKey: fromGroup?.key };
    store.set('view', kind);
    this.mode = kind;
    this.drill = { kind, key, label: key };
    // Don't leave the previous page's tiles up while this one loads.
    this.emit('mode', kind);
    this.#blank();
    this.load();
  }

  closeDrill() {
    // Came here from an album's artist/genre link: go back to that page.
    if (this.backTo) {
      const b = this.backTo;
      this.backTo = null;
      this.returning = b;
      store.set('view', b.mode);
      this.mode = b.mode;
      this.drill = b.drill;
      this.emit('mode', b.mode);
      this.#blank();
      this.load();
      return;
    }
    this.drill = null;
    this.#blank();
    this.load();
  }

  /** Empty the page (shown as loading) before loading another one. */
  #blank() {
    this.groups = [];
    this.rows = [];
    this.total = 0;
    this.loading = true;
    this.emit('loading', true);
    this.emit('change');
  }

  backTo = null; // { mode, drill, expandedKey } to return to from a link
  returning = null; // set while going back, for the view to restore its place

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
  #headsNs = '';
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
      groups = groupByValues(runs, kind === 'genres' ? UNKNOWN_GENRE : UNKNOWN_ARTIST, kind === 'artists' && store.get('hidePlaceholderArtists') ? isPlaceholderArtist : null);
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
    // Albums and artists seen in any playlist this session: their title and
    // art are known at once, so switching playlists draws covers straight
    // away instead of waiting for the details to be fetched again.
    const ns = `${kind === 'albums' || this.drill ? 'a' : kind}|${albumKey}|`;
    for (const g of groups) if (!g.head) g.head = headCache.get(ns + g.key);
    this.#headsNs = ns;
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
   * this only works for Fusion's own Collection and Favourites, whose queries
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
    const formats = { t: title, a: TF.albumArtist, y: TF.year, g: TF.genre, d: TF.date, b: TF.albumRaw, av: versionsTF('album'), aav: versionsTF('albumartist') };
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
        const f = t.formats;
        const head = { handle: t.handle, title: f.t, artist: f.a, year: f.y, genre: f.g, date: f.d };
        // Original / English / romanised versions, when tagged; `albumSuffix`
        // is what the title adds after the album name (" (Disc 2)").
        const album = parseVersions(f.av);
        const albumArtist = parseVersions(f.aav);
        if (album || albumArtist) {
          head.versions = { album, albumArtist };
          head.albumSuffix = f.b && f.t.startsWith(f.b) ? f.t.slice(f.b.length) : '';
        }
        head.vkey = (f.av || '') + (f.aav || '');
        // Same album, same details: keep the object, so nothing redraws.
        const old = chunk[n].head;
        chunk[n].head = old && old.handle === head.handle && old.title === head.title && old.year === head.year && old.date === head.date && old.genre === head.genre && old.artist === head.artist && old.vkey === head.vkey ? old : head;
        headCache.set(this.#headsNs + chunk[n].key, chunk[n].head);
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
          formats: { n: TF.trackNumber, ds: TF.discSubtitle, m: MOOD_TF, vt: versionsTF('title'), va: versionsTF('artist'), vl: versionsTF('album'), vd: versionsTF('discsubtitle'), ar: TF.artistsMulti, gn: TF.genre, vaa: versionsTF('albumartist'), cd: TF.codec, br: TF.bitrate, pc: TF.playCount, ad: TF.added },
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
    if (this.#sortedView()) return this.#playSorted(row);
    return call('playlist.playTrack', { playlist: this.playlist.index, index: row });
  }

  /** The songs view shows a locked playlist in an order of our own. */
  #sortedView() {
    return this.mode === 'songs' && this.playlist?.isLocked && Array.isArray(this.rows) && !this.playlist?.name?.startsWith(PLAYBACK);
  }

  #playbackKey = null; // what the playback playlist currently holds

  /**
   * Play from the songs view in the order shown: the rows are copied, in that
   * order, to a hidden "Fusion playback" playlist (reused while the list
   * hasn't changed) and played from there, so Next and the playback order
   * modes follow the list on screen.
   */
  async #playSorted(row) {
    const rows = this.rows;
    const at = rows.indexOf(row);
    if (at < 0) return call('playlist.playTrack', { playlist: this.playlist.index, index: row });
    const key = `${this.playlist.guid}|${this.playlist.trackCount}|${this.currentSortKey()}|${store.get('sortDescending')}|${this.filter}`;
    let pb = playlists.byName(PLAYBACK);
    if (!pb || this.#playbackKey !== key || pb.trackCount !== rows.length) {
      const t0 = performance.now();
      const handles = await this.handlesFor(rows);
      if (!pb) {
        await call('playlist.create', { name: PLAYBACK, position: playlists.list.length });
        await playlists.refresh();
        pb = playlists.byName(PLAYBACK);
        if (!pb) return;
      } else await call('playlist.clear', { playlistGuid: pb.guid });
      for (let i = 0; i < handles.length; i += 5000) await call('playlist.addHandles', { playlistGuid: pb.guid, handles: handles.slice(i, i + 5000) });
      this.#playbackKey = key;
      logInfo(`playback list: ${handles.length} songs in ${Math.round(performance.now() - t0)} ms`);
    }
    // Creating a playlist can activate it; keep the user where they are.
    const keep = this.playlist.guid;
    await call('playlist.playTrack', { playlistGuid: pb.guid, index: at });
    if (playlists.activePlaylist?.guid !== keep) tryCall('playlist.setActive', { playlistGuid: keep });
  }

  /** Is this playlist row of the current view the one playing? */
  isPlayingRow(row) {
    if (player.playingIndex < 0) return false;
    if (player.playingPlaylist === this.playlist?.index) return player.playingIndex === row;
    const pb = playlists.byName(PLAYBACK);
    if (pb && player.playingPlaylist === pb.index && this.#sortedView() && this.#playbackKey?.startsWith(this.playlist.guid + '|')) return this.rows[player.playingIndex] === row;
    return false;
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

const libraryCache = {}; // kind -> { at, promise: Set of lower-case values }
const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_GENRE = 'Unknown Genre';
const SEP = '|||';

/** Values of a multi-value key: split on the field separator and on ";". */
export function splitValues(key) {
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
/**
 * MusicBrainz's placeholder credits ("[unknown]", "[dialogue]",
 * "[traditional]"...): real tags, but not artists anyone browses to.
 */
export const isPlaceholderArtist = (name) => /^\[.+\]$/.test(name.trim());

function groupByValues(runs, unknown, hide = null) {
  const map = new Map();
  for (const r of runs) {
    let values = splitValues(r.key);
    if (!values.length) values.push(unknown);
    // Hidden values get no tile; a song credited only to them gets none either.
    else if (hide) values = values.filter((v) => !hide(v));
    const albums = (r.sub || []).map((s) => s.key.toLowerCase());
    for (const v of values) {
      const k = v.toLowerCase();
      let g = map.get(k);
      if (!g) map.set(k, (g = { key: v, ranges: [], albums: new Set() }));
      // "j-pop" and "J-Pop" are one tile; it takes the capitalised spelling.
      else if (g.key === k && v !== k) g.key = v;
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
