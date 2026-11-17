// Fusion's own shuffle, so Now playing can show what plays next.
//
// foobar2000 keeps its shuffled order to itself. So for Shuffle (tracks),
// Shuffle (albums) and Shuffle (folders) Fusion sets foobar2000 to Default,
// works out the order itself, and feeds foobar2000 one song at a time
// through the playback queue: whenever the queue would be empty, the next
// song in Fusion's order is queued. Songs you queue yourself play first;
// Fusion's one entry always sits at the end of the queue, and isn't shown as
// part of the queue. Random stays foobar2000's own.
//
// The order is kept in the page's storage, so a reload carries on where it
// was. While Fusion isn't loaded, foobar2000 just plays on in Default order.

import { tryCall, on, onAny } from '../core/bridge.js';
import { debounce } from '../core/util.js';
import { Emitter } from '../core/emitter.js';
import { logInfo } from '../core/log.js';
import { TF } from './patterns.js';
import { player } from './player.js';
import { playlists } from './playlists.js';

export const FUSION_SHUFFLES = ['shuffle-tracks', 'shuffle-albums', 'shuffle-folders'];
const STORE_KEY = 'fusion.shuffle';

class Shuffle extends Emitter {
  mode = null; // one of FUSION_SHUFFLES, or null when foobar2000's order is in charge
  guid = null; // the playlist being shuffled
  count = 0; // its song count when the order was made
  order = []; // its rows, in the order they play
  pos = -1; // where the playing song is in `order`
  #handles = []; // the file of each song in `order` (to follow them when rows move)
  #at = new Map(); // row -> position in order
  ours = null; // { guid, row, handle } of the song Fusion queued
  #lastQueue = [];
  #seen = ''; // the song last handled by #onTrack
  #left = new Map(); // handle -> when a song you queued left the queue
  oursQueued = false; // Fusion's song is in the queue now
  #busy = Promise.resolve();

  get active() {
    return !!this.mode;
  }

  handles(name) {
    return FUSION_SHUFFLES.includes(name);
  }

  /** Rows still to play after the current song (at most n). */
  upcoming(n) {
    return this.order.slice(this.pos + 1, this.pos + 1 + n);
  }

  /** Whether a queue entry is the one Fusion added (not shown as queued). */
  isOurs(item) {
    return !!this.ours && item?.playlistGuid === this.ours.guid && item?.playlistItem === this.ours.row && (!this.ours.handle || item.handle === this.ours.handle);
  }

  async init() {
    const ensureSoon = debounce(() => this.#run(() => this.#ensure()), 150);
    on('playback:queueChanged', () => {
      if (!this.mode) return;
      this.#readQueue();
      ensureSoon();
    });
    player.on('track', () => this.#run(() => this.#onTrack()));
    // Songs added, removed or moved in the shuffled playlist (an autoplaylist
    // re-sorts as play counts change): the order is kept, each song followed
    // to its new row; new songs are slotted in at random further on.
    const changed = debounce(() => this.mode && this.#run(() => this.#remap()), 800);
    onAny(['playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReordered', 'playlist:itemsReplaced', 'playlist:sorted'], (d) => {
      if (!this.mode) return;
      const g = d?.playlistGuid || playlists.list[d?.playlist]?.guid;
      if (!g || g === this.guid) changed();
    });
    // Picked from foobar2000's own Playback menu: Fusion takes the shuffles
    // over; anything else (Default aside) ends Fusion's shuffle.
    player.onNativeOrder = (name) => {
      if (FUSION_SHUFFLES.includes(name)) this.start(name);
      else if (name !== 'default' && this.mode) this.stop({ keepNative: true });
    };

    const saved = load();
    if (FUSION_SHUFFLES.includes(player.nativeOrder)) return this.start(player.nativeOrder);
    if (!saved?.mode) return;
    const pl = playlists.list.find((p) => p.guid === saved.guid);
    if (pl && pl.trackCount === saved.count && Array.isArray(saved.order)) {
      Object.assign(this, { mode: saved.mode, guid: saved.guid, count: saved.count, order: saved.order, pos: saved.pos ?? -1, ours: saved.ours || null });
      this.#index();
      player.emit('order', this.mode);
      await this.#run(async () => {
        this.#handles = await rowHandles(pl, this.order);
        await this.#onTrack();
      });
    } else {
      await this.start(saved.mode);
    }
  }

  /** Turn one of the shuffles on (from the play bar, or taken over from foobar2000). */
  async start(mode) {
    this.mode = mode;
    if (player.nativeOrder !== 'default') await tryCall('playback.setPlaybackOrder', { name: 'default' });
    player.emit('order', mode);
    await this.#run(() => this.#rebuild());
    logInfo(`shuffle: ${mode}, ${this.order.length} songs`);
  }

  /** Back to foobar2000's own order (`name`, unless it set one itself). */
  async stop({ keepNative = false, name = 'default' } = {}) {
    if (!this.mode) return;
    this.mode = null;
    await this.#run(() => this.#removeOurs());
    Object.assign(this, { guid: null, order: [], pos: -1, ours: null });
    this.#at.clear();
    save(null);
    if (!keepNative) await tryCall('playback.setPlaybackOrder', { name });
    player.emit('order', player.order);
    this.emit('change');
  }

  /**
   * Move a coming-up song (playlist row `row`) before or after another
   * (`target`), as dragged in Now playing.
   */
  move(row, target, after) {
    if (!this.mode || row === target) return;
    const from = this.#at.get(row);
    if (from == null || from <= this.pos) return;
    const order = this.order.slice();
    const handles = this.#handles.slice();
    order.splice(from, 1);
    const [h] = handles.splice(from, 1);
    let to = order.indexOf(target);
    if (to < 0) return;
    if (after) to++;
    // Never before the playing song.
    to = Math.max(this.pos + 1, to);
    order.splice(to, 0, row);
    handles.splice(to, 0, h);
    this.order = order;
    this.#handles = handles;
    this.#index();
    this.emit('change');
    return this.#run(() => this.#ensure());
  }

  // One change at a time: queue edits answer with events that call back in.
  #run(fn) {
    this.#busy = this.#busy.then(fn, fn).catch((err) => console.error('[fusion] shuffle:', err));
    return this.#busy;
  }

  /** A new order for the playing playlist (or the one on show), from the playing song. */
  async #rebuild() {
    if (!this.mode) return;
    const pl = (player.active && playlists.list[player.playingPlaylist]) || playlists.activePlaylist;
    if (!pl) return;
    const current = player.active && playlists.list[player.playingPlaylist]?.guid === pl.guid ? player.playingIndex : -1;
    this.guid = pl.guid;
    this.count = pl.trackCount;
    this.order = await makeOrder(this.mode, pl, current);
    this.pos = current >= 0 ? 0 : -1;
    this.#index();
    this.#handles = await rowHandles(pl, this.order);
    logInfo(`shuffle: new ${this.mode} order for ${pl.name} (${this.order.length} songs)`);
    await this.#ensure();
    this.emit('change');
  }

  /** The playlist changed: the same order, each song at its row now. */
  async #remap() {
    const pl = playlists.list.find((p) => p.guid === this.guid);
    if (!pl) return;
    const all = await rowHandles(pl);
    if (!all.length && pl.trackCount) return;
    const rowsOf = new Map(); // handle -> its rows, in order
    all.forEach((h, row) => {
      if (!rowsOf.has(h)) rowsOf.set(h, []);
      rowsOf.get(h).push(row);
    });
    const order = [];
    const handles = [];
    let pos = -1;
    this.#handles.forEach((h, i) => {
      const row = rowsOf.get(h)?.shift();
      if (row == null) return; // removed from the playlist
      if (i === this.pos) pos = order.length;
      order.push(row);
      handles.push(h);
    });
    // Songs new to the playlist: anywhere after the playing one.
    for (const [h, rows] of rowsOf) {
      for (const row of rows) {
        const at = pos + 1 + Math.floor(Math.random() * (order.length - pos));
        order.splice(at, 0, row);
        handles.splice(at, 0, h);
      }
    }
    this.count = pl.trackCount;
    this.order = order;
    this.#handles = handles;
    this.pos = pos;
    this.#index();
    await this.#ensure();
    this.emit('change');
  }

  /** Gone back to `row`: it takes the place before the song that was playing (order[pos]). */
  #stepBack(row, handle) {
    const i = this.#at.get(row);
    if (i === this.pos - 1) return void (this.pos = i); // the one before: just a step
    if (i === this.pos) return; // the same song again
    const order = this.order.slice();
    const handles = this.#handles.slice();
    let at = this.pos;
    if (i != null) {
      order.splice(i, 1);
      handles.splice(i, 1);
      if (i < at) at--;
    }
    at = Math.max(0, at);
    order.splice(at, 0, row);
    handles.splice(at, 0, handle);
    this.order = order;
    this.#handles = handles;
    this.pos = at;
    this.#index();
  }

  #index() {
    this.#at = new Map(this.order.map((row, i) => [row, i]));
  }

  // A new song started: work out where it is in the order. Only a song you
  // started yourself (player.startedByUser) moves the shuffle elsewhere;
  // songs that come up through the queue never do.
  async #onTrack() {
    if (!this.mode) return;
    const pl = playlists.list[player.playingPlaylist];
    const row = player.playingIndex;
    const h = player.track?.handle;
    // The player announces a song more than once (its details arrive in
    // stages): only a new song moves the order on.
    // Until its playlist row is known, a new song can't be placed.
    if (player.locatedStart !== player.trackStart) return;
    const key = `${h}|${player.trackStart || ''}`;
    if (key === this.#seen) return this.#ensure();
    this.#seen = key;
    const inOrder = pl && pl.guid === this.guid && row >= 0 && this.#at.has(row);
    const nextUp = inOrder && row === this.order[this.pos + 1];
    // A song that was in the queue (yours, from any playlist).
    const fromQueue = player.startKind === 'queue' || (!!h && (this.#lastQueue.some((it) => it.handle === h && !this.isOurs(it)) || Date.now() - (this.#left.get(h) || 0) < 15000));
    let why;
    if (player.startKind === 'history') {
      // Previous: one step back, whatever the order says. The song gone back
      // to goes just before the one left, so that's next again (and the rest
      // follow as they were), rather than the order jumping to wherever the
      // song happens to be in it.
      why = 'went back';
      if (inOrder) this.#stepBack(row, h);
    } else if ((h && this.ours && h === this.ours.handle) || (nextUp && player.startKind === '')) {
      why = 'next in order';
      this.pos = this.#at.get(row) ?? this.pos + 1;
      this.ours = null;
    } else if (fromQueue) {
      why = 'from the queue: order waits';
      this.#left.delete(h);
    } else if (!player.startedByUser) {
      why = 'moved on by itself: order waits';
    } else if (inOrder) {
      why = 'you played it: order carries on from it';
      this.pos = this.#at.get(row);
    } else if (pl && row >= 0) {
      logInfo(`shuffle: you started a song in ${pl.name}; shuffling that`);
      return this.#rebuild();
    }
    logInfo(`shuffle: ${player.track?.title || h} (${why || 'not in a playlist'}), position ${this.pos + 1} of ${this.order.length}`);
    if (this.order.length && this.pos >= this.order.length - 1) {
      // The end of the order: a fresh one carries on from here.
      return this.#rebuild();
    }
    await this.#ensure();
    this.emit('change');
  }

  // Keep Fusion's next song queued, at the end of the queue.
  async #ensure() {
    if (!this.mode) return;
    const items = await this.#readQueue();
    // Fusion's song has just started (its track event is on the way): that
    // event moves the order on and queues the next.
    if (this.ours && player.track?.handle === this.ours.handle && !items.some((it) => this.isOurs(it))) return;
    const mine = items.filter((it) => this.isOurs(it));
    const want = this.order[this.pos + 1];
    // Never queue the song that's playing (its track event may not have
    // been handled yet, leaving the place in the order behind).
    if (want != null && player.track?.handle && this.#handles[this.pos + 1] === player.track.handle) return;
    const okay = mine.length === 1 && items[items.length - 1] === mine[0] && mine[0].playlistItem === want;
    if (okay || !player.active) return save(this);
    if (mine.length) await tryCall('queue.remove', { indices: mine.map((it) => it.queueIndex) });
    this.ours = null;
    if (want != null) {
      // Counted as Fusion's (not yours) from the moment it's added: the queue
      // badge flicked up by one before the queue was read again.
      // Recorded as Fusion's before the queue is read again, so it's never
      // counted as yours (the badge flicked up by one on each Next).
      this.ours = { guid: this.guid, row: want, handle: undefined };
      this.oursQueued = true;
      const res = await tryCall('queue.add', { playlistGuid: this.guid, tracks: [want] });
      if (!res) {
        this.ours = null;
        this.oursQueued = false;
      } else {
        const after = await this.#readQueue();
        const added = after.filter((it) => this.isOurs(it)).pop();
        if (added && this.ours) this.ours.handle = added.handle;
      }
    }
    save(this);
  }

  // The queue now.
  async #readQueue() {
    const q = await tryCall('queue.get');
    const items = q?.items || [];
    const still = new Set(items.map((it) => it.handle));
    for (const it of this.#lastQueue) if (!this.isOurs(it) && !still.has(it.handle)) this.#left.set(it.handle, Date.now());
    this.#lastQueue = items;
    const was = this.oursQueued;
    this.oursQueued = items.some((it) => this.isOurs(it));
    if (was !== this.oursQueued) player.emit('queue', player.queueCount);
    return items;
  }

  async #removeOurs() {
    const q = await tryCall('queue.get');
    const mine = (q?.items || []).filter((it) => this.isOurs(it));
    if (mine.length) await tryCall('queue.remove', { indices: mine.map((it) => it.queueIndex) });
    this.ours = null;
    this.oursQueued = false;
    player.emit('queue', player.queueCount);
  }
}

/**
 * The play order for a playlist. Tracks: every row, shuffled. Albums and
 * folders: the groups shuffled, each played through in playlist order. The
 * playing song (and, for groups, the rest of its album or folder) comes first.
 */
async function makeOrder(mode, pl, current) {
  const n = pl.trackCount || 0;
  if (mode === 'shuffle-tracks') {
    const rows = shuffled(Array.from({ length: n }, (_, i) => i).filter((r) => r !== current));
    return current >= 0 ? [current, ...rows] : rows;
  }
  const res = await tryCall('playlist.getGroupRuns', { playlistGuid: pl.guid, patterns: [mode === 'shuffle-albums' ? TF.albumKey : TF.dirKey] });
  // Runs with the same key (an album split up in the playlist) join up.
  const groups = new Map();
  for (const run of res?.runs || []) {
    const key = String(run.key).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    const rows = groups.get(key);
    for (let r = run.start; r < run.start + run.count; r++) rows.push(r);
  }
  let list = [...groups.values()];
  if (!list.length) list = [Array.from({ length: n }, (_, i) => i)];
  const mine = current >= 0 ? list.find((g) => g.includes(current)) : null;
  const rest = shuffled(list.filter((g) => g !== mine));
  return [...(mine ? mine.slice(mine.indexOf(current)) : []), ...rest.flat()];
}

/** The file of each row (all of the playlist, or just `rows`, in that order). */
async function rowHandles(pl, rows = null) {
  const all = [];
  for (let i = 0; i < pl.trackCount; i += 4000) {
    const res = await tryCall('playlist.getTracks', { playlistGuid: pl.guid, start: i, count: Math.min(4000, pl.trackCount - i), fields: ['handle'] });
    if (!res) return [];
    for (const t of res.tracks) all.push(t.handle);
  }
  return rows ? rows.map((r) => all[r]) : all;
}

function shuffled(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

function save(s) {
  try {
    if (!s) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify({ mode: s.mode, guid: s.guid, count: s.count, order: s.order, pos: s.pos, ours: s.ours }));
  } catch {
    /* storage unavailable: the order lasts until a reload */
  }
}

export const shuffle = new Shuffle();
player.shuffle = shuffle;
