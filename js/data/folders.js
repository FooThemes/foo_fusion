// Playlist folders. foobar2000 has no folders of its own, so Fusion keeps
// them in its settings: each folder is a name plus the GUIDs of its playlists.
// Members are kept next to each other in foobar2000's playlist order, so the
// tree and foobar2000's own list agree.

import { tryCall } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';
import * as store from '../core/store.js';
import { playlists } from './playlists.js';

class Folders extends Emitter {
  get list() {
    return store.get('folders') || [];
  }

  #save(list) {
    store.set('folders', list.map((f) => ({ ...f, items: [...f.items] })));
    this.emit('change');
  }

  folderOf(guid) {
    return this.list.find((f) => f.items.includes(guid)) || null;
  }

  /** Tree for display: folders sit where their first playlist is. */
  tree() {
    const all = playlists.list.filter((p) => !playlists.isHidden(p));
    const byGuid = new Map(all.map((p) => [p.guid, p]));
    const out = [];
    const placed = new Set();
    for (const p of all) {
      const f = this.folderOf(p.guid);
      if (!f) {
        out.push({ type: 'playlist', p });
      } else if (!placed.has(f.id)) {
        placed.add(f.id);
        const members = all.filter((x) => f.items.includes(x.guid));
        out.push({ type: 'folder', folder: f, members });
      }
    }
    for (const f of this.list) if (!placed.has(f.id)) out.push({ type: 'folder', folder: f, members: f.items.map((g) => byGuid.get(g)).filter(Boolean) });
    return out;
  }

  create(name, items = []) {
    const f = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, collapsed: false, items: [] };
    const list = this.list.map((x) => ({ ...x, items: x.items.filter((g) => !items.includes(g)) }));
    f.items = [...items];
    list.push(f);
    this.#save(list);
    return this.#gather(f.id).then(() => f);
  }

  rename(id, name) {
    this.#save(this.list.map((f) => (f.id === id ? { ...f, name } : f)));
  }

  /** Remove the folder; its playlists stay, at the top level. */
  remove(id) {
    this.#save(this.list.filter((f) => f.id !== id));
  }

  toggle(id, collapsed) {
    this.#save(this.list.map((f) => (f.id === id ? { ...f, collapsed: collapsed ?? !f.collapsed } : f)));
  }

  /** Put playlists into a folder (or take them out with folderId = null). */
  async move(guids, folderId) {
    const list = this.list.map((f) => ({ ...f, items: f.items.filter((g) => !guids.includes(g)) }));
    const target = list.find((f) => f.id === folderId);
    if (target) target.items.push(...guids);
    this.#save(list);
    if (target) await this.#gather(folderId);
  }

  /** Reorder foobar2000's playlists so a folder's members are adjacent. */
  async #gather(id) {
    const f = this.list.find((x) => x.id === id);
    if (!f || f.items.length < 2) return;
    const order = playlists.list.map((p) => p.guid);
    const members = order.filter((g) => f.items.includes(g));
    const first = order.indexOf(members[0]);
    const rest = order.filter((g) => !f.items.includes(g));
    const at = rest.indexOf(order.slice(0, first).filter((g) => !f.items.includes(g)).pop()) + 1;
    rest.splice(at, 0, ...members);
    if (rest.join() !== order.join()) await tryCall('playlist.reorderPlaylists', { newOrderGuids: rest });
  }

  /** Forget playlists that no longer exist. */
  prune() {
    const live = new Set(playlists.list.map((p) => p.guid));
    if (!live.size) return;
    const list = this.list.map((f) => ({ ...f, items: f.items.filter((g) => live.has(g)) }));
    if (JSON.stringify(list) !== JSON.stringify(this.list)) this.#save(list);
  }
}

export const folders = new Folders();
playlists.on('change', () => folders.prune());
