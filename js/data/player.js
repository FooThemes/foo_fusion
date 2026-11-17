// Playback state: transport, now-playing track, time, volume, order, queue.
// One source of truth that the player bar, now-playing view and tiles read.

import { call, tryCall, on, onAny, onCall } from '../core/bridge.js';
import { debounce } from '../core/util.js';
import { Emitter } from '../core/emitter.js';
import * as store from '../core/store.js';
import { logInfo } from '../core/log.js';
import { osVolume } from './osvolume.js';

export const ORDERS = ['default', 'repeat-playlist', 'repeat-track', 'random', 'shuffle-tracks', 'shuffle-albums', 'shuffle-folders'];
export const ORDER_LABELS = {
  default: 'Default',
  'repeat-playlist': 'Repeat (playlist)',
  'repeat-track': 'Repeat (track)',
  random: 'Random',
  'shuffle-tracks': 'Shuffle (tracks)',
  'shuffle-albums': 'Shuffle (albums)',
  'shuffle-folders': 'Shuffle (folders)',
};

class Player extends Emitter {
  state = 'stopped';
  track = null;
  position = 0;
  positionAt = 0; // performance.now() when position was read
  duration = 0;
  canSeek = false;
  volume = 100;
  muted = false;
  nativeOrder = 'default'; // foobar2000's own playback order
  shuffle = null; // Fusion's shuffle (shuffle.js), when one is on it decides the order
  onNativeOrder = null; // shuffle.js: told when foobar2000's order changes
  history = loadHistory(); // songs played before the current one, oldest first (kept across reloads)
  queueCount = 0;
  stopAfterCurrent = false;
  playingPlaylist = -1;
  playingIndex = -1;

  /** Songs you queued (not the one Fusion's shuffle keeps queued). */
  get userQueueCount() {
    return Math.max(0, this.queueCount - (this.shuffle?.oursQueued ? 1 : 0));
  }

  /** The order in effect: Fusion's shuffle when it's on, else foobar2000's. */
  get order() {
    return this.shuffle?.mode || this.nativeOrder;
  }

  get active() {
    return this.state !== 'stopped';
  }

  /** Current position, extrapolated between the host's once-a-second updates. */
  now() {
    if (this.state !== 'playing') return this.position;
    return Math.min(this.duration || Infinity, this.position + (performance.now() - this.positionAt) / 1000);
  }

  async init() {
    const [st, cur, vol, ord, q, sac] = await Promise.all([
      tryCall('playback.getState'),
      tryCall('playback.getCurrentTrack'),
      tryCall('playback.getVolume'),
      tryCall('playback.getPlaybackOrder'),
      tryCall('queue.getCount'),
      tryCall('playback.getStopAfterCurrent'),
    ]);
    if (st) this.#setState(st.state, st);
    if (cur?.track) this.track = cur.track;
    if (vol) this.#setVolume(vol);
    if (ord) this.nativeOrder = ord.orderName || ord.name || 'default';
    if (q) this.queueCount = q.count ?? 0;
    if (sac) this.stopAfterCurrent = !!(sac.enabled ?? sac.stopAfterCurrent ?? sac.value);
    if (this.active) {
      const pos = await tryCall('playback.getPosition');
      if (pos) this.#setPosition(pos.position, pos.duration);
      await this.#refreshLocation();
    }

    on('playback:trackChanged', (t) => {
      // Played from elsewhere while paused this way (a media key, foobar2000's
      // own Play, which starts the queue first): straight back to the paused
      // song, before anything takes this one as playing.
      if (this.#held && this.#held.handle !== t.handle && !this.#resuming) {
        logInfo('pause: resumed from elsewhere; back to the paused song');
        this.#resume();
        return;
      }
      this.trackStart = (this.trackStart || 0) + 1; // each real start (re-announcements of the same song don't count)
      // Started by you (from stopped, or playing another song, which foobar2000
      // reports as a stop for "user"), rather than the queue or Next moving on.
      const stop = this.#lastStop;
      const now = performance.now();
      // How it started: 'history' (Previous going back), 'queue' (played from
      // the queue), 'user' (you picked it), else '' (moved on by itself or Next).
      const asked = now - this.#asked.at < 3000 ? this.#asked.kind : '';
      this.startKind = asked || (this.state === 'stopped' || (!!stop && now - stop.at < 2000 && stop.reason !== 'starting_another') ? 'user' : '');
      this.startedByUser = this.startKind === 'user';
      this.#lastStop = null;
      this.#asked = { kind: '', at: -1e9 };
      const back = this.#goingBack;
      this.#goingBack = false;
      // Remember what played before (for "Previously" in Now playing).
      clearTimeout(this.#stopTimer);
      // Going back through what played: the song left isn't added again, so
      // Previous keeps going further back.
      if (this.track && this.track.handle !== t.handle && !back) {
        const { handle, title, artist, album, duration } = this.track;
        this.history.push({ handle, title, artist, album, duration, playlist: this.playingPlaylist, index: this.playingIndex });
        if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
        saveHistory(this.history);
      }
      // Back from a pause that let go of the output: the same song resumes
      // where it was; anything else ends that pause.
      const held = this.#held;
      this.#held = null;
      this.#resuming = false;
      if (held && held.handle === t.handle && held.position > 1) setTimeout(() => this.seek(held.position), 60);
      this.track = t;
      this.duration = t.duration || (held && held.handle === t.handle ? this.duration : 0);
      this.#setPosition(held && held.handle === t.handle ? held.position : t.position || 0);
      const start = this.trackStart;
      this.#refreshLocation().then(() => {
        // Its playlist and row are known now (located for this start).
        if (this.trackStart === start) this.locatedStart = start;
        this.emit('track', t);
      });
    });
    // foobar2000 stops for a moment when another song is started (Next is
    // "starting_another"; playing another row reports a "user" stop). Acting
    // on that blanked Now playing between songs, so a stop only counts if no
    // song starts within a moment.
    // A song Fusion starts for you (double-click, Play from here, Previous
    // in its shuffle). foobar2000 started by its own controls is told apart
    // by the stop it reports (below).
    onCall((method) => {
      const kind = { 'playlist.playTrack': 'user', 'playback.playPath': 'user', 'queue.playNow': 'queue' }[method];
      if (kind) this.#asked = { kind: this.#goingBack || this.#replay ? 'history' : kind, at: performance.now() };
      if (kind) this.#replay = false;
    });
    on('playback:stateChanged', (d) => {
      if (d.state === 'stopped') this.#lastStop = { reason: this.#lastStop?.reason || 'user', at: performance.now() };
      if (d.state !== 'stopped') {
        clearTimeout(this.#stopTimer);
        return this.#setState(d.state, d);
      }
      this.#stopSoon();
    });
    on('playback:paused', (d) => this.#setState(d.paused ? 'paused' : 'playing', d));
    on('playback:stopped', (d) => {
      this.#lastStop = { reason: d?.reason || 'unknown', at: performance.now() };
      if (d?.reason === 'starting_another') return;
      this.#stopSoon();
    });
    on('playback:time', (d) => {
      // The once-a-second report lands a little early or late; snapping to
      // it made the seek bar twitch back and forth each second. Close enough
      // (a quarter second): the running clock is kept; further out it's taken.
      const drift = Math.abs((d.position || 0) - this.now());
      if (this.state !== 'playing' || drift > 0.25) this.#setPosition(d.position);
      else if (drift > 0.05) {
        // Eased towards it instead, over the next second.
        this.position += ((d.position || 0) - this.now()) * 0.5;
      }
      this.emit('time');
    });
    on('playback:seeked', (d) => {
      if (d.position != null) this.#setPosition(d.position);
      this.emit('time');
    });
    on('playback:volumeChanged', (d) => this.#setVolume(d));
    osVolume.on('change', () => this.#fromWindows());
    osVolume.init();
    on('playback:orderChanged', (d) => {
      this.nativeOrder = ORDERS[d.orderIndex ?? d.order] || this.nativeOrder;
      this.onNativeOrder?.(this.nativeOrder);
      this.emit('order', this.order);
    });
    on('playback:queueChanged', (d) => {
      this.queueCount = d.count ?? 0;
      this.emit('queue', this.queueCount);
    });
    on('playback:stopAfterCurrentChanged', (d) => {
      this.stopAfterCurrent = !!(d.enabled ?? d.stopAfterCurrent ?? d.state);
      this.emit('state', this.state);
    });
    // The playing song's tags were edited: show the new title/artist.
    on('metadb:changed', (d) => {
      if (!this.track) return;
      if (d.truncated || (d.handles || []).includes(this.track.handle)) tryCall('playback.getCurrentTrack').then((r) => r?.track && ((this.track = r.track), this.emit('track', r.track)));
    });
    // Sorting, adding or removing songs (or whole playlists) moves the playing
    // song to another row or playlist index: read where it is again, so the
    // playing marks follow it.
    const relocate = debounce(async () => {
      if (this.playingIndex < 0 && this.state === 'stopped') return;
      const before = `${this.playingPlaylist}:${this.playingIndex}`;
      await this.#refreshLocation();
      if (`${this.playingPlaylist}:${this.playingIndex}` !== before) this.emit('state', this.state);
    }, 120);
    onAny(['playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReordered', 'playlist:itemsReplaced', 'playlist:sorted', 'playlist:created', 'playlist:removed', 'playlist:reordered'], relocate);
    on('playback:edited', () => tryCall('playback.getCurrentTrack').then((r) => r?.track && ((this.track = r.track), this.emit('track', r.track))));
  }

  #stopTimer = 0;
  #lastStop = null;
  #asked = { kind: '', at: -1e9 };
  #goingBack = false;
  #replay = false;

  /** The next song Fusion starts is one played before (Now playing's history). */
  replaying() {
    this.#replay = true;
  }
  startKind = '';
  startedByUser = false; // the playing song was started by you (see trackChanged)
  #stopSoon() {
    clearTimeout(this.#stopTimer);
    this.#stopTimer = setTimeout(() => {
      // Stopped by a pause that let go of the output: still shown as paused.
      // The device is let go: the DAC gets Windows' level again (osvolume.js).
      setTimeout(() => osVolume.pushToDevice(), 400);
      if (this.#held) return this.#setState('paused', {});
      this.#setState('stopped', {});
      this.playingIndex = -1;
      this.emit('track', null);
    }, 350);
  }

  async #refreshLocation() {
    const loc = await tryCall('playback.getCurrentTrackIndex');
    this.playingPlaylist = loc?.playlist ?? -1;
    this.playingIndex = loc?.index ?? -1;
  }

  #setState(state, d) {
    if (!state) return;
    const was = this.state;
    this.state = state;
    // Paused (by any control): on ASIO, perhaps let go of the driver.
    if (state === 'paused' && was === 'playing' && !this.#held) this.#releaseOnPause();
    if (d.duration != null) this.#setDuration(d.duration);
    // While jumping back after a released pause the song is briefly reported
    // as not seekable: the seek bar would dim for a moment.
    if (d.canSeek != null && !(d.canSeek === false && this.#jumpTo && performance.now() - this.#jumpTo.at < 2500)) this.canSeek = d.canSeek;
    if (d.position != null) this.#setPosition(d.position);
    this.emit('state', state);
  }

  #setPosition(pos, dur) {
    // Jumping back after a released pause: reports of the song's start (or
    // of whatever foobar2000 started first) don't move the bar.
    const j = this.#jumpTo;
    if (j && performance.now() - j.at < 2500 && Math.abs((pos || 0) - j.position) > 2) return;
    this.position = pos || 0;
    this.positionAt = performance.now();
    if (dur != null) this.#setDuration(dur);
  }

  // While a song is being (re)opened foobar2000 reports it as 0 seconds long
  // for a moment: the seek bar emptied and the time left vanished. A zero
  // length doesn't replace the playing song's known one.
  #setDuration(d) {
    if (!(d > 0) && this.duration > 0 && this.track && this.state !== 'stopped') return;
    this.duration = d || 0;
  }

  #setVolume(v) {
    // Following Windows: the slider is Windows' volume, not foobar2000's.
    if (osVolume.active) return;
    this.volume = v.volume ?? this.volume;
    this.muted = !!(v.muted ?? v.isMuted ?? this.muted);
    this.emit('volume', this.volume);
  }
  #fromWindows() {
    this.volume = Math.round(osVolume.scalar * 100);
    this.muted = osVolume.isMuted;
    this.emit('volume', this.volume);
  }

  playOrPause() {
    if (this.#held && this.state === 'paused') return this.#resume();
    return call('playback.playOrPause');
  }

  // --- Pause that lets go of an ASIO driver -------------------------------
  // foobar2000's ASIO output keeps the driver open while paused, so nothing
  // else can play through the device. With "Pause releases ASIO" on, a
  // pause there becomes a stop (which closes the driver) with the song and
  // position kept; Play starts the song again and goes back to that point.
  #held = null; // { playlist, index, handle, position } while paused this way
  #resuming = false;
  #jumpTo = null;

  /** Paused by stopping (to free an ASIO driver): foobar2000 itself is stopped. */
  get released() {
    return !!this.#held;
  }

  async #releaseOnPause() {
    if (!store.get('releaseOnPause') || !this.track) return;
    const conf = await tryCall('config.getOutputConfig');
    if (!/asio/i.test(conf?.outputName || '') || this.state !== 'paused') return;
    this.#held = { playlist: this.playingPlaylist, index: this.playingIndex, handle: this.track.handle, position: this.now() };
    logInfo(`pause: ASIO output released at ${Math.round(this.#held.position)} s`);
    await tryCall('playback.stop');
  }

  async #resume() {
    const h = this.#held;
    this.#resuming = true;
    this.#jumpTo = { position: h.position, at: performance.now() };
    let atRow = false;
    if (h.playlist >= 0 && h.index >= 0) {
      const r = await tryCall('playlist.getTracksAt', { playlist: h.playlist, rows: [h.index], fields: ['handle'] });
      atRow = r?.tracks?.[0]?.handle === h.handle;
    }
    if (atRow) return call('playlist.playTrack', { playlist: h.playlist, index: h.index });
    return call('playback.playPath', { path: h.handle });
  }
  next() {
    return call('playback.next');
  }
  previous() {
    // Fusion's shuffle: back through the songs that actually played (queued
    // ones included), one more each time.
    if (this.shuffle?.mode) return this.#back();
    return call('playback.previous');
  }

  async #back() {
    const h = this.history.pop();
    if (!h) return call('playback.previous');
    saveHistory(this.history);
    this.#goingBack = true;
    // Its row, if it still holds that song; else the file itself.
    let atRow = false;
    if (h.playlist >= 0 && h.index >= 0) {
      const r = await tryCall('playlist.getTracksAt', { playlist: h.playlist, rows: [h.index], fields: ['handle'] });
      atRow = r?.tracks?.[0]?.handle === h.handle;
    }
    try {
      if (atRow) await call('playlist.playTrack', { playlist: h.playlist, index: h.index });
      else await call('playback.playPath', { path: h.handle });
    } catch (err) {
      this.#goingBack = false;
      throw err;
    }
  }
  stop() {
    // Already stopped by a pause that let go of the output: just forget the place.
    if (this.#held) {
      this.#held = null;
      this.#setState('stopped', {});
      this.playingIndex = -1;
      this.emit('track', null);
      return Promise.resolve();
    }
    return call('playback.stop');
  }
  seek(seconds) {
    this.#setPosition(seconds);
    this.emit('time');
    return call('playback.setPosition', { position: seconds });
  }
  setVolume(volume) {
    if (osVolume.active) {
      // Shown at once; Windows confirms it a moment later.
      this.volume = Math.round(volume);
      this.emit('volume', this.volume);
      return osVolume.set(volume / 100);
    }
    return call('playback.setVolume', { volume: Math.round(volume) });
  }
  toggleMute() {
    if (osVolume.active) return osVolume.setMute(!osVolume.isMuted);
    return call('playback.toggleMute');
  }
  /** Shuffle (tracks, albums, folders) is Fusion's own (shuffle.js); the rest are foobar2000's. */
  async setOrder(name) {
    if (this.shuffle?.handles(name)) return this.shuffle.start(name);
    if (this.shuffle?.mode) return this.shuffle.stop({ name });
    return call('playback.setPlaybackOrder', { name });
  }
}

// The last songs played, kept in the page's storage so Now playing can show
// them (and Previous go back through them) after a reload.
const HISTORY = 50;
const HISTORY_KEY = 'fusion.history';
function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(h) ? h.slice(-HISTORY) : [];
  } catch {
    return [];
  }
}
function saveHistory(h) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch {
    /* no storage: kept until a reload */
  }
}

export const player = new Player();
