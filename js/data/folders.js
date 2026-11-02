// Playlist folders, which can hold subfolders. foobar2000 has no folders of
// its own, so Fusion keeps them in its settings: each folder is a name, an
// optional parent folder, and the GUIDs of the playlists directly inside it.
// Every folder's playlists (subfolders included) are kept next to each other
// in foobar2000's playlist order, so the tree and foobar2000's list agree.

import { tryCall } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';
import * as store from '../core/store.js';
import { playlists } from './playlists.js';

class Folders extends Emitter {
  get list() {
    return store.get('folders') || [];
  }

  #save(list) {
    store.set('folders', list.map((f) => ({ ...f, parent: f.parent || null, items: [...f.items] })));
    this.emit('change');
  }

  byId(id) {
    return this.list.find((f) => f.id === id) || null;
  }

  folderOf(guid) {
    return this.list.find((f) => f.items.includes(guid)) || null;
  }

  /** The folder, its parent, and so on up to the top. */
  ancestors(id) {
    const out = [];
    const seen = new Set();
    for (let f = this.byId(id); f && !seen.has(f.id); f = this.byId(f.parent)) {
      seen.add(f.id);
      out.push(f);
    }
    return out;
  }

  /** Path for menus: "Road / Night drives". */
  path(id) {
    return this.ancestors(id)
      .reverse()
      .map((f) => f.name)
      .join(' / ');
  }

  /**
   * Tree for display. Nodes: { type: 'playlist', p } or { type: 'folder',
   * folder, children, members } (members: every playlist in the subtree). A
   * folder sits where its first playlist is; empty ones go last.
   */
  tree() {
    const all = playlists.list.filter((p) => !playlists.isHidden(p));
    const list = this.list;
    const ids = new Set(list.map((f) => f.id));
    const parentOf = (f) => (f.parent && ids.has(f.parent) && f.parent !== f.id ? f.parent : null);
    const make = (parentId) => {
      const out = [];
      const placed = new Set();
      // Which direct child folder (if any) of parentId holds this playlist?
      const childFor = (guid) => {
        let f = this.folderOf(guid);
        const chain = [];
        const seen = new Set();
        while (f && !seen.has(f.id)) {
          seen.add(f.id);
          chain.push(f);
          f = list.find((x) => x.id === parentOf(f));
        }
        // chain: innermost .. outermost; find the element whose parent is parentId
        if (parentId == null) return chain.length ? chain[chain.length - 1] : null;
        const i = chain.findIndex((x) => x.id === parentId);
        return i > 0 ? chain[i - 1] : i === 0 ? 'self' : undefined;
      };
      for (const p of all) {
        const c = childFor(p.guid);
        if (c === undefined) continue; // not under this folder
        if (c === null || c === 'self') out.push({ type: 'playlist', p });
        else if (!placed.has(c.id)) {
          placed.add(c.id);
          out.push(folderNode(c));
        }
      }
      for (const f of list) if (parentOf(f) === parentId && !placed.has(f.id)) out.push(folderNode(f));
      return out;
    };
    const folderNode = (f) => {
      const children = make(f.id);
      const members = [];
      const walk = (nodes) => nodes.forEach((n) => (n.type === 'playlist' ? members.push(n.p) : walk(n.children)));
      walk(children);
      return { type: 'folder', folder: f, children, members };
    };
    return make(null);
  }

  /** Visible rows (collapsed folders hide their contents), with depth. */
  rows(nodes = this.tree(), depth = 0, out = []) {
    for (const n of nodes) {
      out.push({ ...n, depth });
      if (n.type === 'folder' && !n.folder.collapsed) this.rows(n.children, depth + 1, out);
    }
    return out;
  }

  async create(name, items = [], parent = null) {
    const f = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, collapsed: false, parent, items: [...items] };
    const list = this.list.map((x) => ({ ...x, items: x.items.filter((g) => !items.includes(g)) }));
    list.push(f);
    this.#save(list);
    await this.#arrange();
    return f;
  }

  rename(id, name) {
    this.#save(this.list.map((f) => (f.id === id ? { ...f, name } : f)));
  }

  /** Remove the folder; its playlists and subfolders move up a level. */
  remove(id) {
    const gone = this.byId(id);
    if (!gone) return;
    const up = gone.parent || null;
    const list = this.list
      .filter((f) => f.id !== id)
      .map((f) => (f.parent === id ? { ...f, parent: up } : f))
      .map((f) => (f.id === up ? { ...f, items: [...f.items, ...gone.items] } : f));
    this.#save(list);
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
    await this.#arrange();
  }

  /** Nest a folder inside another (or at the top with parentId = null). */
  async moveFolder(id, parentId) {
    if (id === parentId) return;
    // Not into itself or one of its own subfolders.
    if (parentId && this.ancestors(parentId).some((f) => f.id === id)) return;
    this.#save(this.list.map((f) => (f.id === id ? { ...f, parent: parentId || null } : f)));
    await this.#arrange();
  }

  /** Reorder foobar2000's playlists to match the tree (folders contiguous). */
  async #arrange() {
    const order = playlists.list.map((p) => p.guid);
    const want = [];
    const walk = (nodes) => nodes.forEach((n) => (n.type === 'playlist' ? want.push(n.p.guid) : walk(n.children)));
    walk(this.tree());
    // Hidden playlists keep their place at the end.
    for (const g of order) if (!want.includes(g)) want.push(g);
    if (want.join() !== order.join()) await tryCall('playlist.reorderPlaylists', { newOrderGuids: want });
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
