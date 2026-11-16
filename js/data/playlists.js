// The playlist list (left panel) and which playlist is active.
//
// Fusion's two special playlists are found by name, as in the original skin:
//   "Collection" - an autoplaylist of the whole media library
//   "Favorites"  - an autoplaylist of tracks tagged MOOD = "Like it"

import { call, tryCall, onAny, on } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';
import { debounce } from '../core/util.js';
import * as store from '../core/store.js';

export const COLLECTION = 'Collection';
export const FAVORITES = 'Favourites';
const OLD_FAVORITES = 'Favorites'; // name used by earlier Fusion builds; renamed on start
// Plays the Songs view of an autoplaylist in the order it's shown (foobar2000
// can't reorder a locked playlist). Kept out of Fusion's playlist lists.
export const PLAYBACK = 'Fusion playback';

class Playlists extends Emitter {
  list = [];
  active = -1;

  get activePlaylist() {
    return this.list[this.active] || null;
  }

  byName(name) {
    return this.list.find((p) => p.name === name) || null;
  }

  isSpecial(p) {
    return !!p && (p.name === COLLECTION || p.name === FAVORITES);
  }

  /** Playlists shown under "New playlist" (everything except the two specials). */
  get userPlaylists() {
    return this.list.filter((p) => !this.isSpecial(p) && !this.isHidden(p));
  }

  isHidden(p) {
    return !!p && p.name === PLAYBACK;
  }

  async init() {
    await this.refresh();
    // First run: create the library playlist and show it, as the original did.
    if (!this.byName(COLLECTION)) await this.ensureCollection(true);
    // Earlier builds spelt it "Favorites"; rename it in place (keeps its GUID).
    const old = this.byName(OLD_FAVORITES);
    if (old && !this.byName(FAVORITES)) {
      await tryCall('playlist.rename', { playlist: old.index, name: FAVORITES });
      await this.refresh();
    }
    const refresh = debounce(() => this.refresh(), 60);
    onAny(
      ['playlist:created', 'playlist:removed', 'playlist:renamed', 'playlist:reordered', 'playlist:lockChanged', 'playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReplaced', 'playback:trackChanged', 'playback:stopped'],
      refresh,
    );
    on('playlist:activated', (d) => {
      this.active = d.newIndex ?? -1;
      this.pending = -1;
      this.pendingName = '';
      for (const p of this.list) p.isActive = p.index === this.active;
      this.emit('active', this.activePlaylist);
      refresh();
    });
  }

  async refresh() {
    const res = await tryCall('playlist.getAll');
    if (!res) return;
    this.list = res.playlists || [];
    const prev = this.active;
    const act = this.list.find((p) => p.isActive);
    this.active = act ? act.index : -1;
    if (this.pending === this.active) (this.pending = -1), (this.pendingName = '');
    this.emit('change', this.list);
    if (prev !== this.active) this.emit('active', this.activePlaylist);
  }

  // The playlist about to be shown (asked for, not yet reported active):
  // leaving Now playing redrew the old one's page in the meantime.
  // -2: one that's still being made (Favourites, the first time).
  pending = -1;
  pendingName = '';
  #pendingTimer = 0;
  /** The playlist being shown, or about to be (-1: one not listed yet). */
  get shownIndex() {
    return this.pending >= 0 ? this.pending : this.pending === -2 ? -1 : this.active;
  }
  get shownPlaylist() {
    return this.list.find((p) => p.index === this.shownIndex) || null;
  }
  /** Mark the playlist that's about to be activated (before the tab switches). */
  willShow(index, name = '') {
    const known = index != null && index >= 0;
    this.pending = known ? (index !== this.active ? index : -1) : -2;
    this.pendingName = this.pending === -1 ? '' : name || this.list.find((p) => p.index === index)?.name || '';
    // In case it never comes (the switch failed).
    clearTimeout(this.#pendingTimer);
    if (this.pending !== -1) this.#pendingTimer = setTimeout(() => this.#settle(), 4000);
  }
  #settle() {
    if (this.pending === -1) return;
    this.pending = -1;
    this.pendingName = '';
    this.emit('change', this.list);
  }

  async activate(index) {
    if (index === this.active) {
      this.pending = -1;
      this.pendingName = '';
      this.emit('active', this.activePlaylist);
      return;
    }
    this.pending = index;
    this.pendingName = this.list.find((p) => p.index === index)?.name || '';
    try {
      await call('playlist.setActive', { playlist: index });
    } catch (e) {
      this.pending = -1;
      throw e;
    }
  }

  async ensureCollection(activate = true) {
    let p = this.byName(COLLECTION);
    if (!p) {
      const res = await call('playlist.createAutoplaylist', { name: COLLECTION, query: 'ALL', sort: '' });
      await this.#move(res.index, 0);
      await this.refresh();
      p = this.byName(COLLECTION);
    }
    if (activate && p) await this.activate(p.index);
    return p;
  }

  async ensureFavorites(activate = true) {
    let p = this.byName(FAVORITES);
    if (!p) {
      const res = await call('playlist.createAutoplaylist', { name: FAVORITES, query: store.get('favouritesQuery'), sort: '' });
      const coll = this.byName(COLLECTION);
      await this.#move(res.index, coll ? coll.index + 1 : 0);
      await this.refresh();
      p = this.byName(FAVORITES);
    }
    if (activate && p) await this.activate(p.index);
    return p;
  }

  /** Move playlist `from` to position `to`. */
  async #move(from, to) {
    await this.refresh();
    const order = this.list.map((p) => p.index).filter((i) => i !== from);
    order.splice(to, 0, from);
    await call('playlist.reorderPlaylists', { newOrder: order }).catch(() => {});
  }

  async create(name = 'New playlist', activate = true) {
    const res = await call('playlist.create', { name });
    await this.refresh();
    if (activate) await this.activate(res.index);
    return res;
  }

  rename(index, name) {
    return call('playlist.rename', { playlist: index, name });
  }

  remove(index) {
    return call('playlist.remove', { playlist: index });
  }
}

export const playlists = new Playlists();
