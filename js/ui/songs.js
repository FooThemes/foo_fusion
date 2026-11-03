// "Songs" view: every track of the playlist in a virtualised list with columns.
// Rows are fetched from foobar2000 a page at a time as they scroll into view.

import { setVersioned, versionText } from './titles.js';
import { parseVersions } from '../data/versions.js';
import { el, rafThrottle, formatTime, debounce } from '../core/util.js';
import { icon } from '../core/icons.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { trackContextMenu } from './menus.js';
import { RowSelector } from './rowselect.js';
import { heartButton, setHeart, refreshHearts } from './heart.js';
import { draggableRows, selectionOr } from './dnd.js';
import { favourites } from '../data/favourites.js';

const ROW_H = 35;
const PAGE = 120;

const COLUMNS = [
  ['num', ''],
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['year', 'Year'],
  ['genre', 'Genre'],
  ['fav', ''],
  ['len', 'Length'],
];

export class SongList {
  constructor(scroller) {
    this.scroller = scroller;
    this.headerRow = el('div.song-head', null, COLUMNS.map(([k, label]) => el(`div.c-${k}`, { text: label })));
    this.sizer = el('div.song-sizer');
    this.wrap = el('div.songs', { role: 'listbox', 'aria-multiselectable': 'true' }, this.headerRow, this.sizer);
    scroller.append(this.wrap);
    this.nodes = new Map(); // position -> row node
    this.free = [];
    this.fetching = new Set();

    this.onScroll = rafThrottle(() => this.render());
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(rafThrottle(() => this.render()));
    this.ro.observe(scroller);

    this.selector = new RowSelector(this.sizer, () => this.allRows());
    this.sizer.addEventListener('dblclick', (e) => {
      const node = e.target.closest('[data-row]');
      if (node) view.play(Number(node.dataset.row));
    });
    this.sizer.addEventListener('contextmenu', (e) => {
      const node = e.target.closest('[data-row]');
      if (!node) return;
      e.preventDefault();
      const r = Number(node.dataset.row);
      trackContextMenu(view.selection.has(r) ? [...view.selection].sort((a, b) => a - b) : [r]);
    });
    this.loadVisible = debounce(() => this.#fetchVisible(), 40);
    draggableRows(this.sizer, (e) => {
      const node = e.target.closest('[data-row]');
      return node ? selectionOr(Number(node.dataset.row)) : null;
    });
    this.offFav = favourites.on('change', ({ handles, state }) => refreshHearts(this.sizer, handles, state));
  }

  destroy() {
    this.offFav();
    this.ro.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.wrap.remove();
  }

  allRows() {
    return view.rows || Array.from({ length: view.total }, (_, i) => i);
  }

  setData(keepScroll = false) {
    for (const node of this.nodes.values()) this.#recycle(node);
    this.nodes.clear();
    this.sizer.style.height = view.total * ROW_H + 40 + 'px';
    if (!keepScroll) this.scroller.scrollTop = 0;
    this.render();
  }

  render() {
    const top = Math.max(0, this.scroller.scrollTop - 40);
    const h = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - 10);
    const last = Math.min(view.total - 1, Math.ceil((top + h) / ROW_H) + 10);
    for (const [pos, node] of this.nodes) {
      if (pos < first || pos > last) {
        this.#recycle(node);
        this.nodes.delete(pos);
      }
    }
    for (let pos = first; pos <= last; pos++) {
      if (this.nodes.has(pos)) continue;
      const node = this.free.pop() || this.#make();
      node.hidden = false;
      node.style.transform = `translateY(${pos * ROW_H}px)`;
      node.classList.toggle('alt', pos % 2 === 1);
      this.nodes.set(pos, node);
      this.#fill(node, pos);
    }
    this.loadVisible();
  }

  #make() {
    const node = el('div.song-row', { role: 'option' }, COLUMNS.map(([k]) => el(`div.c-${k}.ellipsis`)));
    this.sizer.append(node);
    return node;
  }

  #recycle(node) {
    node.hidden = true;
    this.free.push(node);
  }

  #fill(node, pos) {
    const row = view.rowAt(pos);
    node.dataset.row = row;
    const t = view.cachedTrack(row);
    const c = node.children;
    const f = t?.formats || {};
    const tip = setVersioned(c[1], t ? t.title || t.handle.split('\\').pop() : '', parseVersions(f.vt), 'tracks');
    c[2].textContent = t ? versionText(t.artist || '', parseVersions(f.va), 'tracks') : '';
    c[3].textContent = t ? versionText(t.album || '', parseVersions(f.vl), 'albums') : '';
    c[4].textContent = t ? (t.date || '').slice(0, 4) : '';
    c[5].textContent = t?.genre || '';
    if (t) {
      const loved = favourites.state(t);
      const b = c[6].firstChild;
      if (b && b.dataset.handle === t.handle) setHeart(b, loved);
      else c[6].replaceChildren(heartButton(t.handle, loved));
    } else c[6].replaceChildren();
    c[7].textContent = t ? formatTime(t.duration) : '';
    node.title = t ? `${t.title} - ${t.artist}` + (tip ? `\n\n${tip}` : '') : '';
    this.#state(node, row);
  }

  #state(node, row) {
    node.classList.toggle('selected', view.selection.has(row));
    const playing = view.isPlayingRow(row);
    node.classList.toggle('playing', playing);
    const num = node.children[0];
    if (playing) num.replaceChildren(icon(player.state === 'paused' ? 'pause' : 'nowPlaying'));
    else if (num.firstChild) num.textContent = '';
  }

  async #fetchVisible() {
    const need = [];
    for (const [pos, node] of this.nodes) {
      const row = Number(node.dataset.row);
      if (!view.cachedTrack(row) && !this.fetching.has(row)) need.push(row);
    }
    if (!need.length) return;
    need.sort((a, b) => a - b);
    const batch = need.slice(0, PAGE * 2);
    batch.forEach((r) => this.fetching.add(r));
    await view.tracks(batch);
    batch.forEach((r) => this.fetching.delete(r));
    for (const [pos, node] of this.nodes) this.#fill(node, pos);
    if (need.length > batch.length) this.loadVisible();
  }

  refreshSelection() {
    for (const node of this.nodes.values()) this.#state(node, Number(node.dataset.row));
  }

  refreshPlaying() {
    this.refreshSelection();
  }

  refreshTracks() {
    this.refreshHeads();
  }

  refreshHeads() {
    for (const [pos, node] of this.nodes) this.#fill(node, pos);
    this.loadVisible();
  }

  showRow(row) {
    const rows = view.rows;
    const pos = rows ? rows.indexOf(row) : row;
    if (pos < 0) return;
    const y = pos * ROW_H;
    const h = this.scroller.clientHeight;
    if (y < this.scroller.scrollTop || y > this.scroller.scrollTop + h - ROW_H * 2) this.scroller.scrollTop = y - h / 3;
  }
}
