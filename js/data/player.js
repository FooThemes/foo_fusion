// Playback state: transport, now-playing track, time, volume, order, queue.
// One source of truth that the player bar, now-playing view and tiles read.

import { call, tryCall, on, onAny } from '../core/bridge.js';
import { debounce } from '../core/util.js';
import { Emitter } from '../core/emitter.js';

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
  history = []; // songs played before the current one, oldest first
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
      // Remember what played before (for "Previously" in Now playing).
      if (this.track && this.track.handle !== t.handle) {
        this.history.push({ ...this.track, playlist: this.playingPlaylist, index: this.playingIndex });
        if (this.history.length > 20) this.history.shift();
      }
      this.track = t;
      this.duration = t.duration || 0;
      this.#setPosition(t.position || 0);
      this.#refreshLocation().then(() => this.emit('track', t));
    });
    on('playback:stateChanged', (d) => this.#setState(d.state, d));
    on('playback:paused', (d) => this.#setState(d.paused ? 'paused' : 'playing', d));
    on('playback:stopped', () => {
      this.#setState('stopped', {});
      this.playingIndex = -1;
      this.emit('track', null);
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

  async #refreshLocation() {
    const loc = await tryCall('playback.getCurrentTrackIndex');
    this.playingPlaylist = loc?.playlist ?? -1;
    this.playingIndex = loc?.index ?? -1;
  }

  #setState(state, d) {
    if (!state) return;
    this.state = state;
    if (d.duration != null) this.duration = d.duration;
    if (d.canSeek != null) this.canSeek = d.canSeek;
    if (d.position != null) this.#setPosition(d.position);
    this.emit('state', state);
  }

  #setPosition(pos, dur) {
    this.position = pos || 0;
    this.positionAt = performance.now();
    if (dur != null) this.duration = dur;
  }

  #setVolume(v) {
    this.volume = v.volume ?? this.volume;
    this.muted = !!(v.muted ?? v.isMuted ?? this.muted);
    this.emit('volume', this.volume);
  }

  playOrPause() {
    return call('playback.playOrPause');
  }
  next() {
    return call('playback.next');
  }
  previous() {
    // Fusion's shuffle: back to the song that played before in its order.
    if (this.shuffle?.mode) return this.shuffle.previous();
    return call('playback.previous');
  }
  stop() {
    return call('playback.stop');
  }
  seek(seconds) {
    this.#setPosition(seconds);
    this.emit('time');
    return call('playback.setPosition', { position: seconds });
  }
  setVolume(volume) {
    return call('playback.setVolume', { volume: Math.round(volume) });
  }
  toggleMute() {
    return call('playback.toggleMute');
  }
  /** Shuffle (tracks, albums, folders) is Fusion's own (shuffle.js); the rest are foobar2000's. */
  async setOrder(name) {
    if (this.shuffle?.handles(name)) return this.shuffle.start(name);
    if (this.shuffle?.mode) return this.shuffle.stop({ name });
    return call('playback.setPlaybackOrder', { name });
  }
}

export const player = new Player();
