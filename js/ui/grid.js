// Tile grid for Albums / Artists / Genres, with the original skin's
// "expand in place" track list under the clicked album.
//
// Virtualised: only tiles near the viewport exist in the DOM, and tile nodes
// are recycled while scrolling, so a library with thousands of albums costs
// the same as one with fifty.

import { setTitle } from './titles.js';
import { el, rafThrottle, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view, firstRow } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt, albumArtTypes, warmArt } from '../data/artwork.js';
import { trackContextMenu } from './menus.js';
import { TrackPanel } from './trackpanel.js';
import { draggableRows } from './dnd.js';

const MARGIN = 40; // left/right margin, as in the original
const PAD = 8; // gap around each cover
const OVERSCAN = 2; // extra rows rendered above/below the viewport

export class Grid {
  constructor(scroller) {
    this.scroller = scroller;
    this.sizer = el('div.grid-sizer');
    this.layer = el('div.grid-layer');
    this.sizer.append(this.layer);
    this.scroller.append(this.sizer);
    this.tiles = new Map(); // group index -> node
    this.free = [];
    this.expanded = -1;
    this.panel = new TrackPanel(this);
    this.layer.append(this.panel.node);
    this.cols = 1;
    this.tileW = 160;
    this.tileH = 210;
    this.kind = 'albums';

    this.onScroll = rafThrottle(() => this.render());
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(rafThrottle(() => this.layout()));
    this.ro.observe(scroller);

    this.layer.addEventListener('click', (e) => this.#click(e));
    this.layer.addEventListener('dblclick', (e) => this.#dblclick(e));
    this.layer.addEventListener('contextmenu', (e) => this.#context(e));
    this.layer.addEventListener('keydown', (e) => this.#key(e));
    draggableRows(this.layer, (e) => {
      const i = this.#indexOf(e);
      return i < 0 ? null : view.groupRows(view.groups[i]);
    });
  }

  destroy() {
    this.ro.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.sizer.remove();
  }

  /** New data from the view model. Keeps scroll position when possible. */
  setData(keepScroll = false) {
    // Same groups as on screen (e.g. a reload after a re-sort that changed
    // nothing visible): just refresh the text, don't rebuild the tiles.
    const sig = view.groups.map((g) => `${g.key}:${firstRow(g)}:${g.count}`).join('|');
    if (keepScroll && sig === this.sig && this.kind === (view.drill ? 'albums' : view.mode)) {
      this.refreshHeads();
      return;
    }
    this.sig = sig;
    const kind = view.drill ? 'albums' : view.mode;
    // Tiles whose album is still on screen keep their node (and its loaded
    // image) and just move; only new arrivals get a pooled node.
    for (const node of this.stale?.values() || []) this.#recycle(node);
    this.stale = new Map();
    for (const node of this.tiles.values()) {
      if (kind === this.kind && node.dataset.key != null) this.stale.set(node.dataset.key, node);
      else this.#recycle(node);
    }
    this.kind = kind;
    this.tiles.clear();
    if (this.expanded >= view.groups.length) this.expanded = -1;
    if (!keepScroll) {
      this.expanded = -1;
      this.scroller.scrollTop = 0;
    }
    this.panel.close(true);
    if (this.expanded >= 0) this.panel.open(view.groups[this.expanded], this.expanded);
    this.layout();
  }

  layout() {
    const w = this.scroller.clientWidth;
    if (!w) return;
    // Keep the open album (or the first visible tile) where it was on screen
    // while the columns reflow, instead of jumping to wherever its row lands.
    const hadLayout = this.rowCount != null && this.lastWidth;
    let anchor = -1;
    let anchorOffset = 0;
    if (hadLayout) {
      anchor = this.expanded >= 0 ? this.expanded : Math.max(0, Math.floor((this.scroller.scrollTop - 16) / this.tileH)) * this.cols;
      anchorOffset = this.rowTop(Math.floor(anchor / this.cols)) - this.scroller.scrollTop;
    }
    this.lastWidth = w;
    const round = this.kind === 'artists';
    const min = round ? store.get('artistTileSize') : store.get('tileSize');
    const inner = w - MARGIN * 2;
    this.cols = Math.max(1, Math.floor(inner / (min + PAD * 2)));
    this.tileW = Math.floor(inner / this.cols);
    const art = this.tileW - PAD * 2;
    this.tileH = art + PAD + (round ? 58 : this.kind === 'genres' ? 14 : 54);
    this.artSize = art;
    this.layer.style.setProperty('--tile-w', this.tileW + 'px');
    this.layer.style.setProperty('--art', art + 'px');
    this.rowCount = Math.ceil(view.groups.length / this.cols);
    this.panel.layout(w);
    this.#updateHeight();
    if (anchor >= 0 && anchor < view.groups.length) {
      this.scroller.scrollTop = Math.max(0, this.rowTop(Math.floor(anchor / this.cols)) - anchorOffset);
    }
    for (const [i, node] of this.tiles) this.#place(node, i);
    this.render();
    this.#warm();
  }

  /** Height the open album takes in the grid, including the gap below it. */
  get panelSpace() {
    return this.expanded >= 0 && this.panel.height ? this.panel.height + 28 : 0;
  }

  get expandedRow() {
    return this.expanded < 0 ? -1 : Math.floor(this.expanded / this.cols);
  }

  #updateHeight() {
    const extra = this.expanded >= 0 ? this.panelSpace : 0;
    this.sizer.style.height = this.rowCount * this.tileH + extra + 60 + 'px';
  }

  rowTop(row) {
    const er = this.expandedRow;
    return 16 + row * this.tileH + (er >= 0 && row > er ? this.panelSpace : 0);
  }

  render() {
    const groups = view.groups;
    if (!groups.length) {
      for (const node of this.stale?.values() || []) this.#recycle(node);
      this.stale = null;
      for (const node of this.tiles.values()) this.#recycle(node);
      this.tiles.clear();
      return;
    }
    const top = this.scroller.scrollTop;
    const bottom = top + this.scroller.clientHeight;
    const er = this.expandedRow;
    const ph = er >= 0 ? this.panelSpace : 0;
    const toRow = (y) => {
      if (er >= 0 && y > 16 + (er + 1) * this.tileH) y = Math.max(16 + (er + 1) * this.tileH, y - ph);
      return Math.floor((y - 16) / this.tileH);
    };
    const r0 = Math.max(0, toRow(top) - OVERSCAN);
    const r1 = Math.min(this.rowCount - 1, toRow(bottom) + OVERSCAN);
    const first = r0 * this.cols;
    const last = Math.min(groups.length - 1, (r1 + 1) * this.cols - 1);

    for (const [i, node] of this.tiles) {
      if (i < first || i > last) {
        this.#recycle(node);
        this.tiles.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      let node = this.tiles.get(i);
      if (!node) {
        const key = groups[i].key;
        node = this.stale?.get(key);
        if (node) this.stale.delete(key);
        else node = this.free.pop() || this.#makeTile();
        node.hidden = false;
        this.tiles.set(i, node);
        this.#place(node, i);
        this.#fill(node, i);
      }
    }
    if (this.stale) {
      for (const node of this.stale.values()) this.#recycle(node);
      this.stale = null;
    }
  }

  /** Get every cover of this list ready in the background (disk cache). */
  #warm() {
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      if (!this.artSize) return;
      const types = this.kind === 'artists' ? ['artist', 'front'] : this.kind === 'albums' ? albumArtTypes(store.get('separateDiscs')) : ['front'];
      warmArt(view.groups.map((g) => g.head?.handle), this.artSize, types);
    }, 300);
  }

  /** Text/art arrived for groups [from, to). */
  refreshHeads() {
    this.#warm();
    for (const [i, node] of this.tiles) this.#fill(node, i);
    if (this.expanded >= 0) this.panel.refreshHead(view.groups[this.expanded]);
  }

  /** Tags changed: re-read the open album's songs. */
  refreshTracks() {
    if (this.expanded >= 0) this.panel.reload();
  }

  refreshPlaying() {
    for (const [i, node] of this.tiles) node.classList.toggle('playing', this.#isPlaying(view.groups[i]));
    this.panel.refreshPlaying();
  }

  refreshSelection() {
    this.panel.refreshSelection();
  }

  #isPlaying(g) {
    if (!g || player.playingPlaylist !== view.playlist?.index || player.playingIndex < 0) return false;
    const r = player.playingIndex;
    return g.rows ? g.rows.includes(r) : r >= g.start && r < g.start + g.count;
  }

  #makeTile() {
    const img = el('img', { alt: '', decoding: 'async', draggable: false });
    const play = el('button.tile-play', { title: 'Play', tabindex: -1 }, icon('play'));
    const node = el(
      'div.tile',
      { tabindex: 0, role: 'button' },
      el('div.art', null, img, play),
      el('div.tile-t1.ellipsis'),
      el('div.tile-t2.ellipsis'),
    );
    this.layer.append(node);
    return node;
  }

  #recycle(node) {
    node.hidden = true;
    delete node.dataset.key;
    node.classList.remove('expanded', 'playing');
    this.free.push(node);
  }

  #place(node, i) {
    const row = Math.floor(i / this.cols);
    const col = i % this.cols;
    node.style.transform = `translate(${MARGIN + col * this.tileW}px, ${this.rowTop(row)}px)`;
  }

  #fill(node, i) {
    const g = view.groups[i];
    node.dataset.index = i;
    const sameAlbum = node.dataset.key === g.key;
    node.dataset.key = g.key;
    const head = g.head;
    const [t1, t2] = node.querySelectorAll('.tile-t1, .tile-t2');
    const art = node.querySelector('.art');
    const img = art.querySelector('img');
    node.classList.toggle('expanded', i === this.expanded);
    node.classList.toggle('playing', this.#isPlaying(g));
    art.className = 'art';
    if (this.kind === 'albums') {
      const [artist, album] = splitAlbumKey(g.key);
      setTitle(t1, head?.title || album);
      const year = store.get('showAlbumYear') && head?.year ? ` · ${head.year}` : '';
      t2.textContent = (head?.artist || artist) + year + (store.get('showTrackCounts') ? ` · ${plural(g.count, 'song')}` : '');
      art.classList.add('ph-album');
      node.title = `${t1.textContent}\n${head?.artist || artist}`;
    } else if (this.kind === 'artists') {
      t1.textContent = g.key;
      t2.textContent = plural(g.albumCount || g.sub?.length || 1, 'album');
      art.classList.add('round', 'ph-artist');
      node.title = g.key;
    } else {
      t1.textContent = '';
      t2.textContent = '';
      art.classList.add('ph-genre');
      art.dataset.label = g.key;
      node.title = `${g.key}\n${plural(g.albumCount || g.sub?.length || 1, 'album')}`;
    }
    art.dataset.label = this.kind === 'genres' ? g.key : '';
    if (head?.handle) bindArt(img, head.handle, this.artSize, this.kind === 'artists' ? ['artist', 'front'] : this.kind === 'albums' ? albumArtTypes(store.get('separateDiscs')) : ['front']);
    else if (!sameAlbum) {
      delete img.dataset.artToken;
      img.removeAttribute('src');
      img.classList.remove('loaded');
    }
  }

  #indexOf(e) {
    const tile = e.target.closest('.tile');
    return tile ? Number(tile.dataset.index) : -1;
  }

  #click(e) {
    const i = this.#indexOf(e);
    if (i < 0) return;
    const g = view.groups[i];
    if (e.target.closest('.tile-play')) {
      view.playGroup(g);
      return;
    }
    if (this.kind === 'albums') this.toggle(i);
    else view.openDrill(g);
  }

  #dblclick(e) {
    const i = this.#indexOf(e);
    if (i >= 0 && !e.target.closest('.tile-play')) view.playGroup(view.groups[i]);
  }

  #context(e) {
    const i = this.#indexOf(e);
    if (i < 0) return;
    e.preventDefault();
    trackContextMenu(view.groupRows(view.groups[i]));
  }

  #key(e) {
    const i = this.#indexOf(e);
    if (i < 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey) view.playGroup(view.groups[i]);
      else this.#click(e);
    }
  }

  /** Open the album with this key (if it's in the list). */
  expandKey(key) {
    const i = view.groups.findIndex((g) => g.key === key);
    if (i >= 0 && this.expanded !== i) this.toggle(i);
  }

  toggle(i) {
    if (this.expanded === i) {
      this.collapse();
      return;
    }
    const prevRow = this.expandedRow;
    const wasOpen = this.expanded >= 0;
    this.expanded = i;
    this.layer.classList.toggle('shift', wasOpen && prevRow === this.expandedRow);
    this.panel.open(view.groups[i], i);
    this.#relayoutTiles();
    this.#reveal();
  }

  /** The open album list changed height (disc picked, tracks loaded). */
  relayout() {
    if (this.expanded >= 0) this.#relayoutTiles();
  }

  collapse() {
    if (this.expanded < 0) return;
    this.expanded = -1;
    this.panel.close();
    this.#relayoutTiles();
  }

  #relayoutTiles() {
    this.#updateHeight();
    this.layer.classList.add('animating');
    for (const [i, node] of this.tiles) {
      this.#place(node, i);
      node.classList.toggle('expanded', i === this.expanded);
    }
    this.render();
    clearTimeout(this.animT);
    this.animT = setTimeout(() => this.layer.classList.remove('animating', 'shift'), 260);
  }

  /** Scroll so the opened list is visible (smoothly, like the original). */
  #reveal() {
    const row = this.expandedRow;
    const top = this.rowTop(row);
    const bottom = top + this.tileH + this.panelSpace;
    const viewTop = this.scroller.scrollTop;
    const viewH = this.scroller.clientHeight;
    let target = null;
    if (bottom > viewTop + viewH) target = Math.min(top, bottom - viewH);
    else if (top < viewTop) target = top;
    if (target != null) this.scroller.scrollTo({ top: target - 8, behavior: store.get('smoothScroll') ? 'smooth' : 'auto' });
  }

  /** Scroll to and open the group holding playlist row `row`. */
  showRow(row) {
    const i = view.groups.findIndex((g) => (g.rows ? g.rows.includes(row) : row >= g.start && row < g.start + g.count));
    if (i < 0) return;
    if (this.kind === 'albums' && this.expanded !== i) this.toggle(i);
    else this.scroller.scrollTo({ top: this.rowTop(Math.floor(i / this.cols)) - 8 });
  }

  firstRowOf(i) {
    return firstRow(view.groups[i]);
  }
}

export function splitAlbumKey(key) {
  const parts = key.split('|');
  return [parts[0] || '', parts[1] || ''];
}
