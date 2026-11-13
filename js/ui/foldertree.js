// "Folders" view: the playlist's songs as a folder tree, like Explorer's.
// Folders open and close in place (click, or ← →); songs are listed by file
// name under their folder. A virtualised list: only the rows on screen exist.

import { el, rafThrottle, formatTime, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view, folderRows } from '../data/view.js';
import { player } from '../data/player.js';
import { trackContextMenu } from './menus.js';
import { RowSelector } from './rowselect.js';
import { draggableRows, selectionOr } from './dnd.js';

const ROW_H = 32;
const INDENT = 20;
const open = new Set(); // lower-case paths of the open folders (this session)

export class FolderTree {
  constructor(scroller) {
    this.scroller = scroller;
    this.sizer = el('div.ft-sizer');
    this.list = el('div.ft', { role: 'tree' }, this.sizer);
    scroller.append(this.list);
    this.items = []; // what's shown, in order: { dir: node, depth } | { row, depth }
    this.nodes = new Map(); // item index -> element
    this.pool = [];
    this.tracks = new Map(); // row -> track (handle, duration)
    this.onScroll = rafThrottle(() => this.render());
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(scroller);

    this.list.addEventListener('click', (e) => this.#click(e));
    this.list.addEventListener('dblclick', (e) => this.#dblclick(e));
    this.list.addEventListener('contextmenu', (e) => this.#context(e));
    this.list.addEventListener('keydown', (e) => this.#key(e));
    // Songs select like the Songs list (Ctrl, Shift); folders are dragged whole.
    new RowSelector(this.list, () => this.items.filter((it) => it.row != null).map((it) => it.row));
    draggableRows(this.list, (e) => {
      const item = this.#itemOf(e);
      if (!item) return null;
      return item.dir ? folderRows(item.dir) : selectionOr(item.row);
    });
    this.offStore = store.subscribe((k) => k === 'sortDescending' && this.setData(true));
  }

  destroy() {
    this.offStore?.();
    this.ro.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.list.remove();
  }

  setData(keep = false) {
    if (!keep) this.scroller.scrollTop = 0;
    this.tracks.clear();
    this.#build();
  }

  /** The visible items from the tree and which folders are open. */
  #build() {
    const tree = view.tree;
    const desc = !!store.get('sortDescending');
    const items = [];
    const walk = (node, depth) => {
      const folders = desc ? [...node.folders].reverse() : node.folders;
      for (const f of folders) {
        items.push({ dir: f, depth });
        if (open.has(f.path.toLowerCase())) walk(f, depth + 1);
      }
      for (const row of this.#songsOf(node)) items.push({ row, depth });
    };
    if (tree) walk(tree, 0);
    this.items = items;
    this.sizer.style.height = `${items.length * ROW_H + 40}px`;
    for (const node of this.nodes.values()) this.#recycle(node);
    this.nodes.clear();
    this.render();
  }

  /** A folder's own songs, by file name once their names are known. */
  #songsOf(node) {
    const rows = [...node.rows];
    if (rows.every((r) => this.tracks.has(r))) rows.sort((a, b) => fileCollator.compare(fileName(this.tracks.get(a)), fileName(this.tracks.get(b))));
    return rows;
  }

  render() {
    const top = this.scroller.scrollTop - this.list.offsetTop;
    const h = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - 10);
    const last = Math.min(this.items.length - 1, Math.ceil((top + h) / ROW_H) + 10);
    for (const [i, node] of this.nodes) {
      if (i < first || i > last) {
        this.#recycle(node);
        this.nodes.delete(i);
      }
    }
    const need = [];
    for (let i = first; i <= last; i++) {
      if (this.nodes.has(i)) continue;
      const node = this.pool.pop() || el('div.row.ft-row');
      node.hidden = false;
      node.style.transform = `translateY(${i * ROW_H}px)`;
      this.list.append(node);
      this.nodes.set(i, node);
      this.#fill(node, i);
      const it = this.items[i];
      if (it.row != null && !this.tracks.has(it.row)) need.push(it.row);
    }
    if (need.length) this.#fetch(need);
  }

  async #fetch(rows) {
    const tracks = await view.tracks(rows);
    let reorder = false;
    rows.forEach((r, n) => {
      if (!tracks[n]) return;
      this.tracks.set(r, tracks[n]);
      reorder = true;
    });
    if (!reorder) return;
    // Names known: put each open folder's songs in file-name order.
    const scroll = this.scroller.scrollTop;
    this.#build();
    this.scroller.scrollTop = scroll;
  }

  #recycle(node) {
    node.hidden = true;
    this.pool.push(node);
  }

  #fill(node, i) {
    const it = this.items[i];
    node.dataset.index = i;
    node.style.paddingLeft = `${16 + it.depth * INDENT}px`;
    node.replaceChildren();
    if (it.dir) {
      const isOpen = open.has(it.dir.path.toLowerCase());
      delete node.dataset.row;
      node.className = `row ft-row ft-dir${isOpen ? ' open' : ''}`;
      node.setAttribute('role', 'treeitem');
      node.setAttribute('aria-expanded', String(isOpen));
      node.tabIndex = -1;
      node.title = it.dir.path;
      node.append(el('span.ft-chev', null, icon('chevronRight')), el('span.ft-icon', null, icon('folder')), el('span.ft-name', { text: it.dir.label || it.dir.name }), el('span.ft-meta', { text: plural(it.dir.count, 'song') }));
      return;
    }
    const t = this.tracks.get(it.row);
    node.dataset.row = it.row;
    node.className = 'row ft-row ft-song';
    node.setAttribute('role', 'treeitem');
    node.removeAttribute('aria-expanded');
    node.tabIndex = -1;
    node.classList.toggle('selected', view.selection.has(it.row));
    node.classList.toggle('playing', this.#isPlaying(it.row));
    node.title = t?.absolutePath || t?.handle || '';
    node.append(
      el('span.ft-chev'),
      el('span.ft-icon', null, icon(this.#isPlaying(it.row) ? 'nowPlaying' : 'note')),
      el('span.ft-name', { text: t ? fileName(t) : '' }),
      el('span.ft-meta', { text: t?.duration ? formatTime(t.duration) : '' }),
    );
  }

  #isPlaying(row) {
    return player.playingPlaylist === view.playlist?.index && player.playingIndex === row;
  }

  #itemOf(e) {
    const node = e.target.closest('.ft-row');
    return node ? this.items[Number(node.dataset.index)] : null;
  }

  toggleFolder(node, force) {
    const k = node.path.toLowerCase();
    const want = force ?? !open.has(k);
    if (want === open.has(k)) return;
    if (want) open.add(k);
    else open.delete(k);
    const scroll = this.scroller.scrollTop;
    this.#build();
    this.scroller.scrollTop = scroll;
  }

  #click(e) {
    const it = this.#itemOf(e);
    if (it?.dir && !e.ctrlKey && !e.shiftKey) this.toggleFolder(it.dir);
  }

  #dblclick(e) {
    const it = this.#itemOf(e);
    if (it?.row != null) view.play(it.row);
  }

  #context(e) {
    const it = this.#itemOf(e);
    if (!it) return;
    e.preventDefault();
    if (it.dir) {
      const node = e.target.closest('.ft-row');
      node.classList.add('menu-open');
      Promise.resolve(trackContextMenu(folderRows(it.dir), [{ label: open.has(it.dir.path.toLowerCase()) ? 'Close folder' : 'Open folder', run: () => this.toggleFolder(it.dir) }], { select: false })).finally(() => node.classList.remove('menu-open'));
    } else trackContextMenu(selectionOr(it.row));
  }

  #key(e) {
    const it = this.#itemOf(e);
    if (!it) return;
    if (it.dir && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      this.toggleFolder(it.dir, e.key === 'ArrowRight');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (it.dir) this.toggleFolder(it.dir);
      else view.play(it.row);
    }
  }

  refreshSelection() {
    for (const node of this.nodes.values()) if (node.dataset.row != null) node.classList.toggle('selected', view.selection.has(Number(node.dataset.row)));
  }

  refreshPlaying() {
    for (const [i, node] of this.nodes) if (this.items[i]?.row != null) this.#fill(node, i);
  }

  refreshTracks() {
    this.tracks.clear();
    this.#build();
  }

  /** Open the folders down to a row (the playing song) and scroll to it. */
  showRow(row) {
    const path = [];
    const find = (node) => {
      if (node.rows.includes(row)) return true;
      for (const f of node.folders) {
        path.push(f);
        if (find(f)) return true;
        path.pop();
      }
      return false;
    };
    if (!view.tree || !find(view.tree)) return;
    for (const f of path) open.add(f.path.toLowerCase());
    this.#build();
    const i = this.items.findIndex((it) => it.row === row);
    if (i >= 0) this.scroller.scrollTo({ top: this.list.offsetTop + i * ROW_H - this.scroller.clientHeight / 3 });
  }
}

const fileCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** "03 Song.flac" -> "03 Song" (with the subsong for a cue sheet's tracks). */
function fileName(t) {
  const h = t.handle || '';
  const sub = /\|subsong:(\d+)$/.exec(h);
  const name = h.replace(/\|subsong:\d+$/, '').split('\\').pop().replace(/\.[^.]+$/, '');
  // A cue sheet's tracks share one file: its title tells them apart.
  return sub ? `${name} · ${t.title || '#' + sub[1]}` : name;
}
