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
  #quickCache = new Map(); // row -> track without the titleformat extras (see quickTracks)
  #generation = 0;
  #ownSortUntil = 0;
  // The last groups of each page (tab, artist, genre…), shown straight away
  // when it's opened again while the real load runs, instead of a blank
  // "Loading…" page. The load then replaces them (usually with the same).
  #snapshots = new Map();

  // foobar2000's group runs per playlist and patterns, kept until the
  // playlist's songs change: an artist's or genre's page is cut from the runs
  // the Artists / Genres tab already fetched (the same patterns), so opening
  // one needs no pass over the whole library.
  #contentVersion = 0;
  #warmTimer = 0;
  #trackCacheKey = '';
  #runsCache = new Map();

  async #groupRuns(pl, patterns) {
    const key = [pl.guid, pl.trackCount, this.#contentVersion, ...patterns].join('|');
    let p = this.#runsCache.get(key);
    if (!p) {
      p = tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns }).then((res) => (res ? res.runs || [] : null));
      this.#runsCache.set(key, p);
      p.then((r) => r || this.#runsCache.delete(key));
      while (this.#runsCache.size > 8) this.#runsCache.delete(this.#runsCache.keys().next().value);
    }
    return p;
  }

  /** Fetch (in the background) what the Artists and Genres pages are cut from. */
  warmGroupRuns() {
    const pl = playlists.byName(COLLECTION);
    if (!pl) return;
    const albumKey = store.get('separateDiscs') ? TF.albumDiscKey : TF.albumKey;
    const songsSort = SORTS[store.get('sort').songs || 'title'] || SORTS.title;
    this.#groupRuns(pl, [TF.artistsMulti, albumKey])
      .then(() => this.#groupRuns(pl, [TF.genresMulti, albumKey]))
      // The Songs tab's order too (it's sorted here, from runs of its key).
      .then(() => pl.isLocked && songsSort && this.#sortedRows(pl, songsSort.pattern, false));
  }

  #snapshotKey() {
    const pl = playlists.activePlaylist;
    return pl ? [pl.guid, pl.trackCount, this.mode, this.drill?.kind || '', this.drill?.key || '', this.filter, store.get('separateDiscs'), this.currentSortKey(), store.get('sortDescending')].join('|') : '';
  }

  async init() {
    // The playback copy grows as playback gets near its ends (see #playSorted).
    player.on('track', () => this.#extendPlayback());
    player.on('order', (o) => SHUFFLED.has(o) && this.#extendPlayback(true));
    this.mode = store.get('view');
    const reload = debounce(() => this.load(), 120);
    const reloadIfActive = (d) => {
      this.#contentVersion++; // rows moved or changed: cached runs are stale
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
      this.#contentVersion++;
      this.#trackCache.clear();
    this.#quickCache.clear();
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
      // Another playlist: shown at once as it was last time (when it was),
      // else the old one stays up until the new one is ready.
      const snap = this.mode !== 'songs' && this.mode !== 'nowplaying' ? this.#snapshots.get(this.#snapshotKey()) : null;
      if (snap) {
        this.playlist = pl;
        this.groups = snap.groups;
        this.rows = null;
        this.total = snap.total;
        this.emit('change');
      }
      this.load();
    });
    store.subscribe((key) => {
      if (key === 'genreSplit') delete libraryCache.genres;
      if (key === 'separateDiscs' || (key === 'hidePlaceholderArtists' && this.mode === 'artists') || (key === 'genreSplit' && this.mode === 'genres')) this.load();
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
          for (const r of res?.runs || []) for (const v of splitValues(r.key, kind)) if (!names.has(v.toLowerCase())) names.set(v.toLowerCase(), v);
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
      this.returning = { expandedKey: key, jump: true }; // the grid opens it once loaded
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
    const snap = this.mode !== 'songs' && this.mode !== 'nowplaying' ? this.#snapshots.get(this.#snapshotKey()) : null;
    this.groups = snap ? snap.groups : [];
    this.rows = snap ? null : [];
    this.total = snap ? snap.total : 0;
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
    return store.get('sort')[mode] || (mode === 'folders' ? 'path' : undefined);
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
    let rows = c && c.guid === pl.guid && c.count === pl.trackCount && c.version === this.#contentVersion && c.pattern === pattern ? c.rows : null;
    if (!rows) {
      const res = await tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns: [pattern] });
      if (!res) return null;
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      const runs = res.runs.slice().sort((a, b) => collator.compare(a.key, b.key) || a.start - b.start);
      rows = [];
      for (const r of runs) for (let i = 0; i < r.count; i++) rows.push(r.start + i);
      this.#sortCache = { guid: pl.guid, count: pl.trackCount, version: this.#contentVersion, pattern, rows };
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
    // Songs read before stay valid while the playlist's rows are unchanged
    // (switching tabs and back needs no new reads).
    const tk = `${pl?.guid}|${pl?.trackCount}|${this.#contentVersion}`;
    if (tk !== this.#trackCacheKey) {
      this.#trackCacheKey = tk;
      this.#trackCache.clear();
      this.#quickCache.clear();
    }

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
    const valueView = ((this.mode === 'artists' || this.mode === 'genres') && !this.drill) || this.mode === 'folders';
    // Songs in an autoplaylist are sorted here instead (see #sortedRows), so
    // going between Songs and Albums doesn't rebuild the library either.
    const clientSongs = this.mode === 'songs' && pl.isLocked;
    // An artist's or genre's page of an autoplaylist (the Collection) puts its
    // few albums in order itself, instead of having foobar2000 rebuild the
    // whole library in another order (and back again for the Albums tab).
    const clientGroups = !!this.drill && pl.isLocked;
    const wantSort = !clientSongs && !clientGroups && (opts.sort || (!valueView && store.get('sortOnOpen') && this.isLibrary && store.get('appliedSort')[pl.guid] !== stamp));
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
    this.reversed = pl.isLocked && desc && !clientGroups;

    let matched = null;
    const q = this.filter ? searchQuery(this.filter) : '';
    if (q) {
      const res = await tryCall('playlist.getMatchingRows', { playlist: pl.index, query: q });
      matched = res ? res.items : [];
    }
    if (gen !== this.#generation) return;

    // Folders: the playlist's songs as a folder tree (see folderTree).
    if (this.mode === 'folders') {
      const runs = await this.#groupRuns(pl, [TF.dirKey]);
      if (gen !== this.#generation || !runs) return;
      this.tree = folderTree(runs, matched && new Set(matched));
      this.groups = [];
      this.rows = null;
      this.total = this.tree.count;
      await this.syncSelection(false);
      return this.#done(gen);
    }

    if (this.mode === 'songs' || this.mode === 'nowplaying') {
      this.groups = [];
      if (clientSongs) {
        const sorted = await this.#sortedRows(pl, pattern, desc);
        if (gen !== this.#generation) return;
        if (sorted) {
          const keep = matched && new Set(matched);
          this.rows = keep ? sorted.filter((r) => keep.has(r)) : sorted;
          // Searching: the best matches first (see rankScore).
          if (this.filter && this.rows.length <= 8000) {
            this.rows = await this.#rankRows(pl, this.rows, ['%title%', '%artist%', '%album%', '%album artist%']);
            if (gen !== this.#generation) return;
          }
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
    const runs = await this.#groupRuns(pl, patterns);
    if (gen !== this.#generation || !runs) return;

    let groups;
    if (kind === 'albums') {
      groups = mergeRuns(runs.map((r) => ({ key: r.key, start: r.start, count: r.count })));
    } else if (this.drill) {
      // Albums of one artist/genre: the album runs inside every run that lists it.
      const want = this.drill.key.toLowerCase();
      const subs = runs.filter((r) => splitValues(r.key, kind).some((v) => v.toLowerCase() === want)).flatMap((r) => r.sub || []);
      groups = mergeRuns(subs);
    } else {
      groups = groupByValues(runs, kind, kind === 'genres' ? UNKNOWN_GENRE : UNKNOWN_ARTIST, kind === 'artists' && store.get('hidePlaceholderArtists') ? isPlaceholderArtist : null);
    }
    if (matched) groups = intersect(groups, matched);
    // Searching: albums, artists and genres that match best come first
    // ("Ado": Ado, Adolf, Adolescent, then Fluorescent Adolescent).
    if (this.filter && groups.length > 1) {
      groups = await this.#rankGroups(pl, groups, kind);
      if (gen !== this.#generation) return;
    }
    if (clientGroups && groups.length > 1) {
      groups = await this.#sortGroups(pl, groups, pattern, desc);
      if (gen !== this.#generation) return;
    }
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
    const snapKey = this.#snapshotKey();
    this.#snapshots.delete(snapKey);
    this.#snapshots.set(snapKey, { groups, total: this.total });
    if (this.#snapshots.size > 16) this.#snapshots.delete(this.#snapshots.keys().next().value);
    await this.syncSelection(false);
    // An artist's or genre's page: its first albums' covers and titles before
    // it's shown (no page of blank placeholders first).
    if (this.drill && groups.slice(0, HEAD_CHUNK).some((g) => !g.head)) {
      await this.#loadHeads(gen, 1);
      if (gen !== this.#generation) return;
    }
    this.#done(gen);
    this.#loadHeads(gen);
  });

  /** Groups by how well they match the search (ties keep their order). */
  async #rankGroups(pl, groups, kind) {
    const q = this.filter.trim().toLowerCase();
    let texts;
    if (kind === 'artists' || kind === 'genres') texts = groups.map((g) => [g.key]);
    else {
      texts = [];
      for (let i = 0; i < groups.length; i += 1000) {
        const chunk = groups.slice(i, i + 1000);
        const res = await tryCall('playlist.getTracksAt', { playlist: pl.index, rows: chunk.map((g) => firstRow(g)), fields: ['handle'], formats: { b: '[%album%]', a: TF.albumArtist } });
        chunk.forEach((g, n) => texts.push([res?.tracks?.[n]?.formats?.b || '', res?.tracks?.[n]?.formats?.a || '']));
      }
    }
    return rankBy(groups, texts, q);
  }

  /** Rows by how well their title / artist / album match the search. */
  async #rankRows(pl, rows, fields) {
    const q = this.filter.trim().toLowerCase();
    const texts = [];
    const formats = Object.fromEntries(fields.map((f, i) => ['f' + i, `[${f}]`]));
    for (let i = 0; i < rows.length; i += 2000) {
      const chunk = rows.slice(i, i + 2000);
      const res = await tryCall('playlist.getTracksAt', { playlist: pl.index, rows: chunk, fields: ['handle'], formats });
      chunk.forEach((r, n) => texts.push(fields.map((f, k) => res?.tracks?.[n]?.formats?.['f' + k] || '')));
    }
    return rankBy(rows, texts, q);
  }

  /** Groups in the order of a sort pattern (evaluated on each one's first song). */
  async #sortGroups(pl, groups, pattern, desc) {
    const keys = [];
    for (let i = 0; i < groups.length; i += 500) {
      const chunk = groups.slice(i, i + 500);
      const res = await tryCall('playlist.getTracksAt', { playlist: pl.index, rows: chunk.map((g) => firstRow(g)), fields: ['handle'], formats: { s: pattern } });
      chunk.forEach((g, n) => keys.push(res?.tracks?.[n]?.formats?.s ?? ''));
    }
    const order = groups.map((g, i) => [g, keys[i]]);
    order.sort((a, b) => groupCollator.compare(a[1], b[1]));
    if (desc) order.reverse();
    return order.map(([g]) => g);
  }

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
    // Albums shown: get the Artists/Genres runs ready in a quiet moment.
    clearTimeout(this.#warmTimer);
    if (this.mode === 'albums' && !this.drill && this.playlist?.name === COLLECTION) this.#warmTimer = setTimeout(() => this.warmGroupRuns(), 1500);
    this.loading = false;
    this.emit('loading', false);
    this.emit('change');
  }

  /** Fetch display text + art path for each group's first row, in chunks. */
  async #loadHeads(gen, chunks = Infinity) {
    const title = store.get('separateDiscs') ? TF.albumDiscTitle : TF.albumTitle;
    const formats = { t: title, a: TF.albumArtist, y: TF.year, g: TF.genre, d: TF.date, b: TF.albumRaw, av: versionsTF('album'), aav: versionsTF('albumartist') };
    for (let i = 0, n = 0; i < this.groups.length && n < chunks; i += HEAD_CHUNK, n++) {
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
    this.#quickCache.clear();
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
    return this.#trackCache.get(row) || this.#quickCache.get(row) || null;
  }

  /** Has this row its full track data (versions, codec … not just the tags)? */
  hasFullTrack(row) {
    return this.#trackCache.has(row);
  }

  /**
   * Plain fields only (title, artist, album …: no titleformat), which
   * foobar2000 returns many times faster: the Songs list shows these at once
   * while scrolling, and the full data replaces them a moment later.
   */
  async quickTracks(rows) {
    const missing = rows.filter((r) => !this.#trackCache.has(r) && !this.#quickCache.has(r));
    if (!missing.length || !this.playlist) return;
    const gen = this.#generation;
    for (let i = 0; i < missing.length; i += 2000) {
      const res = await tryCall('playlist.getTracksAt', { playlist: this.playlist.index, rows: missing.slice(i, i + 2000), fields: TRACK_FIELDS });
      if (gen !== this.#generation) return;
      res?.tracks.forEach((t) => this.#trackCache.has(t.index) || this.#quickCache.set(t.index, { ...t, quick: true }));
    }
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
  #playbackFrom = 0; // rows[] index of its first song
  #playbackTo = 0; // rows[] index after its last song
  #playbackRows = null; // the list it was cut from
  #playbackBusy = null; // Promise of an extension in progress

  /**
   * Play from the songs view in the order shown. foobar2000 can only play
   * playlists in their own order, so the songs around the clicked one (a few
   * dozen before it, a few hundred after) are copied, in the order shown, to a
   * hidden "Fusion playback" playlist and played from there; more are added
   * as playback gets near either end. Only the shuffle orders need the whole
   * list (to pick from all of it); it is then filled in the background.
   */
  async #playSorted(row) {
    const rows = this.rows;
    const at = rows.indexOf(row);
    if (at < 0) return call('playlist.playTrack', { playlist: this.playlist.index, index: row });
    const key = `${this.playlist.guid}|${this.playlist.trackCount}|${this.currentSortKey()}|${store.get('sortDescending')}|${this.filter}`;
    const keep = this.playlist.guid;
    let pb = playlists.byName(PLAYBACK);
    if (pb && this.#playbackKey === key && at >= this.#playbackFrom && at < this.#playbackTo) {
      await call('playlist.playTrack', { playlistGuid: pb.guid, index: at - this.#playbackFrom });
    } else {
      const from = Math.max(0, at - 50);
      const to = Math.min(rows.length, at + 300);
      const handles = await this.handlesFor(rows.slice(from, to));
      if (!pb) {
        await call('playlist.create', { name: PLAYBACK, position: playlists.list.length });
        await playlists.refresh();
        pb = playlists.byName(PLAYBACK);
        if (!pb) return;
      } else await call('playlist.clear', { playlistGuid: pb.guid });
      await call('playlist.addHandles', { playlistGuid: pb.guid, handles });
      this.#playbackKey = key;
      this.#playbackRows = rows;
      this.#playbackFrom = from;
      this.#playbackTo = from + handles.length;
      await call('playlist.playTrack', { playlistGuid: pb.guid, index: at - from });
    }
    if (SHUFFLED.has(player.order)) this.#extendPlayback(true);
    // Creating a playlist can activate it; keep the user where they are.
    if (playlists.activePlaylist?.guid !== keep) tryCall('playlist.setActive', { playlistGuid: keep });
  }

  /**
   * Near an end of the copy (or with a shuffle order: everything): add the
   * next songs after it and the ones before it, a few hundred at a time.
   */
  #extendPlayback(all = false) {
    if (this.#playbackBusy || !this.#playbackKey) return this.#playbackBusy;
    const pb = playlists.byName(PLAYBACK);
    const rows = this.#playbackRows;
    if (!pb || !rows || player.playingPlaylist !== pb.index) return null;
    const key = this.#playbackKey;
    const stale = () => this.#playbackKey !== key;
    const job = (async () => {
      const pause = () => new Promise((r) => setTimeout(r, 40));
      try {
        while (!stale()) {
          const cur = this.#playbackFrom + Math.max(0, player.playingIndex);
          const after = this.#playbackTo < rows.length && (all || this.#playbackTo - cur < 100);
          const before = this.#playbackFrom > 0 && (all || cur - this.#playbackFrom < 20);
          if (!after && !before) break;
          if (after) {
            const end = Math.min(rows.length, this.#playbackTo + (all ? 1000 : 300));
            const handles = await this.handlesFor(rows.slice(this.#playbackTo, end));
            if (stale()) return;
            await call('playlist.addHandles', { playlistGuid: pb.guid, handles });
            this.#playbackTo += handles.length;
          } else {
            const start = Math.max(0, this.#playbackFrom - (all ? 1000 : 100));
            const handles = await this.handlesFor(rows.slice(start, this.#playbackFrom));
            if (stale()) return;
            await call('playlist.insertTracks', { playlistGuid: pb.guid, position: 0, handles });
            this.#playbackFrom -= handles.length;
          }
          await pause();
        }
      } catch (e) {
        if (!stale()) this.#playbackKey = null; // build it again next time
        logInfo(`playback list: ${e.message}`);
      }
    })();
    // (Set after: a job with nothing to do finishes before this line.)
    this.#playbackBusy = job;
    job.finally(() => this.#playbackBusy === job && (this.#playbackBusy = null));
    return job;
  }

  /** Is this playlist row of the current view the one playing? */
  isPlayingRow(row) {
    if (player.playingIndex < 0) return false;
    if (player.playingPlaylist === this.playlist?.index) return player.playingIndex === row;
    const pb = playlists.byName(PLAYBACK);
    // From the playback copy: the same song (rows there shift while it fills).
    if (pb && player.playingPlaylist === pb.index && this.#sortedView() && this.#playbackKey?.startsWith(this.playlist.guid + '|')) {
      const t = this.#trackCache.get(row);
      return t && player.track ? t.handle === player.track.handle : this.#playbackRows?.[player.playingIndex + this.#playbackFrom] === row;
    }
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

/**
 * How well a text matches the search: the whole of it (Ado) beats its start
 * (Adolf, then the longer Adolescent), which beats a later word's start
 * (Fluorescent Adolescent), which beats a match inside a word.
 */
export function rankScore(text, q) {
  const t = (text || '').toLowerCase().normalize('NFKC');
  if (!t || !q) return 0;
  if (t === q) return 1000;
  const lenPenalty = Math.min(99, t.length - q.length);
  if (t.startsWith(q)) return 800 - lenPenalty;
  const at = t.indexOf(q);
  if (at < 0) {
    // Several words: each one found counts.
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length < 2) return 0;
    return Math.max(0, ...words.map((w) => rankScore(text, w))) / 4;
  }
  const wordStart = at > 0 && /[\s\-_.,:;/(&'"!?[]/.test(t[at - 1]);
  return (wordStart ? 600 : 300) - lenPenalty - Math.min(99, at);
}

function rankBy(items, texts, q) {
  q = q.normalize('NFKC');
  return items
    .map((it, i) => [it, Math.max(...texts[i].map((x) => rankScore(x, q))), i])
    .sort((a, b) => b[1] - a[1] || a[2] - b[2])
    .map(([it]) => it);
}

const SHUFFLED = new Set(['random', 'shuffle-tracks', 'shuffle-albums', 'shuffle-folders']);
const groupCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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
export function splitValues(key, kind = '') {
  const out = [];
  const seen = new Set();
  const genres = kind === 'genres';
  for (const part of key.split(SEP)) {
    for (const v of genres ? splitGenreText(part) : part.split(';')) {
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
/**
 * Folders view: { name, path, folders: [nodes], rows: [direct playlist rows],
 * count } from runs of "folder of the song". The top shows what's inside the
 * folder every song shares (E:\\Music: its folders).
 */
function folderTree(runs, keep) {
  const top = { name: '', path: '', folders: new Map(), rows: [], count: 0 };
  for (const r of runs) {
    const parts = r.key.split('\\').filter(Boolean);
    let node = top;
    let path = '';
    for (const p of parts) {
      path = path ? `${path}\\${p}` : p;
      const k = p.toLowerCase();
      let next = node.folders.get(k);
      if (!next) node.folders.set(k, (next = { name: p, path, folders: new Map(), rows: [], count: 0 }));
      node = next;
    }
    for (let i = r.start; i < r.start + r.count; i++) if (!keep || keep.has(i)) node.rows.push(i);
  }
  // Counts, and folders as sorted lists (folders with nothing left out).
  const finish = (n) => {
    const list = [...n.folders.values()].map(finish).filter((c) => c.count);
    list.sort((a, b) => groupCollator.compare(a.name, b.name));
    n.folders = list;
    n.count = n.rows.length + list.reduce((s, c) => s + c.count, 0);
    return n;
  };
  finish(top);
  let root = top;
  while (root.folders.length === 1 && !root.rows.length) root = root.folders[0];
  return root;
}

/** Every playlist row under a folder. */
export function folderRows(node) {
  const out = [...node.rows];
  for (const c of node.folders) out.push(...folderRows(c));
  return out;
}

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
/** "Pop/Rock", "Pop, Pop Rock", "Rock; Pop" -> separate genres. A few names
 *  have a slash of their own ("Singer/Songwriter") and stay whole. */
// Discogs's "Folk, World, & Country" is one genre, commas and all.
const WHOLE_GENRES = /\b(singer\s*\/\s*song-?writer|r\s*\/\s*b|d\s*\/\s*b|c\s*\/\s*w|folk\s*,\s*world\s*,?\s*(?:&|and)\s*country)\b/gi;
export function splitGenreText(text, chars = store.get('genreSplit')) {
  const seps = [...new Set(String(chars ?? ';').replace(/\s+/g, ''))];
  if (!seps.length) return [text];
  const kept = [];
  const masked = text.replace(WHOLE_GENRES, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  const at = new RegExp(`\\s*[${seps.map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('')}]\\s*`);
  const parts = masked.split(at).map((v) => v.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[i]));
  // "Rock, Pop, & Soul": the list's last item is "Soul", not "& Soul".
  return parts.map((p) => p.replace(/^(?:&|and\b)\s*/i, ''));
}

export const isPlaceholderArtist = (name) => /^\[.+\]$/.test(name.trim());

function groupByValues(runs, kind, unknown, hide = null) {
  const map = new Map();
  for (const r of runs) {
    let values = splitValues(r.key, kind);
    if (!values.length) values.push(unknown);
    // Hidden values get no tile; a song credited only to them gets none either.
    else if (hide) values = values.filter((v) => !hide(v));
    const albums = (r.sub || []).map((s) => s.key.toLowerCase());
    for (const v of values) {
      const k = v.toLowerCase();
      let g = map.get(k);
      if (!g) map.set(k, (g = { key: v, ranges: [], albums: new Set(), sizes: new Map() }));
      // "j-pop" and "J-Pop" are one tile; it takes the capitalised spelling.
      else if (g.key === k && v !== k) g.key = v;
      // Each album's first row and size, for a genre tile's cover collage.
      for (const s of r.sub || []) {
        const a = g.sizes.get(s.key.toLowerCase()) || { start: s.start, count: 0 };
        a.count += s.count;
        g.sizes.set(s.key.toLowerCase(), a);
      }
      g.ranges.push([r.start, r.count]);
      albums.forEach((a) => g.albums.add(a));
    }
  }
  const unknownKey = unknown.toLowerCase();
  return [...map.values()]
    .map((g) => ({
      ...finishGroup(g),
      albumCount: g.albums.size,
      // First rows of the four biggest albums.
      collageRows: [...g.sizes.values()].sort((a, b) => b.count - a.count).slice(0, 4).map((a) => a.start),
    }))
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
