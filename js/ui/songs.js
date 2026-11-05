// "Songs" view: every track of the playlist in a virtualised list with columns.
// Rows are fetched from foobar2000 a page at a time as they scroll into view.

import { setVersioned } from './titles.js';
import { parseVersions } from '../data/versions.js';
import { el, rafThrottle, formatTime, debounce } from '../core/util.js';
import { icon } from '../core/icons.js';
import { view, splitValues } from '../data/view.js';
import { player } from '../data/player.js';
import { trackContextMenu } from './menus.js';
import { RowSelector } from './rowselect.js';
import { heartButton, setHeart, refreshHearts } from './heart.js';
import { draggableRows, selectionOr } from './dnd.js';
import { favourites } from '../data/favourites.js';
import * as store from '../core/store.js';
import { showMenu } from './menus.js';

const ROW_H = 35;
const PAGE = 120;

// Columns the Songs view can show (right-click the header to pick, drag a
// header to move it, drag its right edge to size it). The playing-song
// marker sits at the start of the title.
const COLUMNS = {
  title: { label: 'Title', width: 'minmax(0, 3fr)', always: true },
  artist: { label: 'Artist', width: 'minmax(0, 2fr)' },
  album: { label: 'Album', width: 'minmax(0, 2fr)' },
  albumartist: { label: 'Album artist', width: 'minmax(0, 2fr)' },
  year: { label: 'Year', width: '56px' },
  date: { label: 'Date', width: '96px' },
  genre: { label: 'Genre', width: 'minmax(0, 1.2fr)' },
  track: { label: 'Track', width: '48px', right: true },
  disc: { label: 'Disc', width: '44px', right: true },
  fav: { label: '', menu: 'Favourite', width: '28px', icon: 'heart' },
  len: { label: 'Length', width: '56px', right: true },
  codec: { label: 'Format', width: '72px' },
  bitrate: { label: 'Bitrate', width: '80px', right: true },
  plays: { label: 'Plays', width: '52px', right: true, menu: 'Plays (foo_playcount)' },
  added: { label: 'Added', width: '96px', menu: 'Added (foo_playcount)' },
};
const DEFAULT_COLUMNS = ['fav', 'title', 'artist', 'album', 'year', 'genre', 'len'];
const MIN_WIDTH = 28;

function columns() {
  const list = (store.get('songColumns') || DEFAULT_COLUMNS).filter((k) => COLUMNS[k]);
  return list.includes('title') ? list : ['title', ...list];
}

export class SongList {
  constructor(scroller) {
    this.scroller = scroller;
    this.headerRow = el('div.song-head');
    this.sizer = el('div.song-sizer');
    this.wrap = el('div.songs', { role: 'listbox', 'aria-multiselectable': 'true' }, this.headerRow, this.sizer);
    scroller.append(this.wrap);
    this.#buildHeader();
    this.headerRow.addEventListener('contextmenu', (e) => (e.preventDefault(), this.#columnMenu()));
    this.#dragColumns();
    this.#resizeColumns();
    this.offStore = store.subscribe((k) => {
      if (k !== 'songColumns' && k !== 'songColumnWidths') return;
      this.#buildHeader();
      for (const node of [...this.nodes.values(), ...this.free]) node.remove();
      this.nodes.clear();
      this.free = [];
      this.render();
    });
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
      trackContextMenu(view.selection.has(r) ? [...view.selection].sort((a, b) => a - b) : [r], goToItems(view.cachedTrack(r)));
    });
    this.loadVisible = debounce(() => this.#fetchVisible(), 40);
    draggableRows(this.sizer, (e) => {
      const node = e.target.closest('[data-row]');
      return node ? selectionOr(Number(node.dataset.row)) : null;
    });
    this.offFav = favourites.on('change', ({ handles, state }) => refreshHearts(this.sizer, handles, state));
  }

  destroy() {
    this.destroyed = true;
    this.offFav();
    this.offStore();
    this.ro.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.wrap.remove();
  }

  allRows() {
    return view.rows || Array.from({ length: view.total }, (_, i) => i);
  }

  setData(keepScroll = false) {
    this.prefetching = null;
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

  #buildHeader() {
    this.cols = columns();
    const widths = store.get('songColumnWidths') || {};
    this.wrap.style.setProperty('--song-cols', this.cols.map((k) => (widths[k] ? `${widths[k]}px` : COLUMNS[k].width)).join(' '));
    this.headerRow.replaceChildren(
      ...this.cols.map((k) =>
        el(
          `div.c-${k}${COLUMNS[k].right ? '.right' : ''}`,
          { dataset: { col: k }, title: COLUMNS[k].menu || COLUMNS[k].label },
          COLUMNS[k].icon ? icon(COLUMNS[k].icon) : el('span.col-label', { text: COLUMNS[k].label }),
          el('span.col-resize', { title: 'Drag to resize; double-click for the default width' }),
        ),
      ),
    );
  }

  /** Drag a header's right edge to size its column (double-click: default). */
  #resizeColumns() {
    let drag = null;
    this.headerRow.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.col-resize');
      if (!handle || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const cell = handle.parentElement;
      drag = { key: cell.dataset.col, x: e.clientX, w: cell.getBoundingClientRect().width };
      this.headerRow.setPointerCapture(e.pointerId);
      this.headerRow.classList.add('resizing');
    }, true);
    this.headerRow.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = Math.max(MIN_WIDTH, Math.round(drag.w + e.clientX - drag.x));
      drag.now = w;
      // Live, without rebuilding the rows: just the column template.
      const widths = { ...(store.get('songColumnWidths') || {}), [drag.key]: w };
      this.wrap.style.setProperty('--song-cols', this.cols.map((k) => (widths[k] ? `${widths[k]}px` : COLUMNS[k].width)).join(' '));
    });
    const end = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      this.headerRow.classList.remove('resizing');
      if (d.now) store.set('songColumnWidths', { ...(store.get('songColumnWidths') || {}), [d.key]: d.now });
    };
    this.headerRow.addEventListener('pointerup', end);
    this.headerRow.addEventListener('pointercancel', end);
    this.headerRow.addEventListener('dblclick', (e) => {
      const handle = e.target.closest('.col-resize');
      if (!handle) return;
      const widths = { ...(store.get('songColumnWidths') || {}) };
      delete widths[handle.parentElement.dataset.col];
      store.set('songColumnWidths', widths);
    });
  }

  /** Right-click the header: tick the columns to show. */
  #columnMenu() {
    const shown = new Set(this.cols);
    const toggle = (k) => {
      const list = shown.has(k) ? this.cols.filter((c) => c !== k) : [...this.cols, k];
      store.set('songColumns', list);
    };
    showMenu([
      ...Object.entries(COLUMNS).map(([k, c]) => ({ label: c.menu || c.label, checked: shown.has(k), enabled: !c.always, run: () => toggle(k) })),
      '-',
      { label: 'Reset columns', run: () => (store.set('songColumnWidths', {}), store.set('songColumns', [...DEFAULT_COLUMNS])) },
    ]);
  }

  /** Drag a column header left or right to move the column. */
  #dragColumns() {
    let drag = null;
    this.headerRow.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('[data-col]');
      if (!cell || e.button !== 0 || e.target.closest('.col-resize')) return;
      drag = { cell, key: cell.dataset.col, x: e.clientX, moved: false };
      this.headerRow.setPointerCapture(e.pointerId);
    });
    this.headerRow.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      drag.moved = true;
      drag.cell.classList.add('dragging');
      drag.cell.style.transform = `translateX(${dx}px)`;
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.cell.classList.remove('dragging');
      d.cell.style.transform = '';
      if (!d.moved) return;
      // Where it was dropped: before the first column whose middle is right of the pointer.
      const others = [...this.headerRow.querySelectorAll('[data-col]')].filter((c) => c !== d.cell);
      const before = others.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientX < r.left + r.width / 2;
      });
      const list = this.cols.filter((k) => k !== d.key);
      const at = before ? list.indexOf(before.dataset.col) : list.length;
      list.splice(at, 0, d.key);
      if (list.join() !== this.cols.join()) store.set('songColumns', list);
    };
    this.headerRow.addEventListener('pointerup', end);
    this.headerRow.addEventListener('pointercancel', end);
  }

  #make() {
    const node = el('div.song-row', { role: 'option' }, ...this.cols.map((k) => el(`div.c-${k}.ellipsis${COLUMNS[k].right ? '.right' : ''}`, { dataset: { col: k } })));
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
    const f = t?.formats || {};
    let tip = '';
    this.cols.forEach((k, i) => {
      const c = node.children[i];
      switch (k) {
        case 'title':
          tip = setVersioned(c, t ? t.title || t.handle.split('\\').pop() : '', t ? parseVersions(f.vt) : null, 'titles');
          break;
        case 'artist':
          setVersioned(c, t?.artist || '', t ? parseVersions(f.va) : null, 'artists');
          break;
        case 'album':
          setVersioned(c, t?.album || '', t ? parseVersions(f.vl) : null, 'albums');
          break;
        case 'albumartist':
          setVersioned(c, t?.albumArtist || '', t ? parseVersions(f.vaa) : null, 'artists');
          break;
        case 'fav':
          if (t && !t.quick) {
            const loved = favourites.state(t);
            const b = c.firstChild;
            if (b && b.dataset.handle === t.handle) setHeart(b, loved);
            else c.replaceChildren(heartButton(t.handle, loved));
          } else c.replaceChildren();
          break;
        default:
          c.textContent = t ? CELL[k](t, f) : '';
      }
    });
    node.title = t ? `${t.title} - ${t.artist}` + (tip ? `\n\n${tip}` : '') : '';
    this.#state(node, row);
  }

  #state(node, row) {
    node.classList.toggle('selected', view.selection.has(row));
    const playing = view.isPlayingRow(row);
    node.classList.toggle('playing', playing);
    // The playing marker at the start of the title.
    const title = node.querySelector('.c-title');
    const mark = title?.querySelector(':scope > .play-mark');
    const want = playing ? (player.state === 'paused' ? 'pause' : 'nowPlaying') : null;
    if (!want) mark?.remove();
    else if (mark?.dataset.icon !== want) {
      mark?.remove();
      const m = el('span.play-mark', { dataset: { icon: want } }, icon(want));
      title.prepend(m);
    }
  }

  async #fetchVisible() {
    const shown = [...this.nodes.values()].map((node) => Number(node.dataset.row));
    // First the plain tags (fast), so rows never sit blank while scrolling…
    const bare = shown.filter((r) => !view.cachedTrack(r));
    if (bare.length) {
      await view.quickTracks(bare);
      for (const [pos, node] of this.nodes) if (bare.includes(Number(node.dataset.row))) this.#fill(node, pos);
    }
    this.#prefetchAll();
    // …then everything else (versions, codec, play counts).
    const need = shown.filter((row) => !view.hasFullTrack(row) && !this.fetching.has(row));
    if (!need.length) return;
    need.sort((a, b) => a - b);
    const batch = need.slice(0, PAGE * 2);
    batch.forEach((r) => this.fetching.add(r));
    await view.tracks(batch);
    batch.forEach((r) => this.fetching.delete(r));
    for (const [pos, node] of this.nodes) this.#fill(node, pos);
    if (need.length > batch.length) this.loadVisible();
  }

  /** The plain tags of the whole list, in the background, so a jump
   *  anywhere (dragging the scrollbar) shows text straight away. */
  #prefetchAll() {
    if (this.prefetching === view.playlist?.guid + '|' + view.total) return;
    const key = (this.prefetching = view.playlist?.guid + '|' + view.total);
    const total = view.total;
    (async () => {
      for (let pos = 0; pos < total; pos += 1500) {
        await new Promise((r) => setTimeout(r, 120));
        if (this.prefetching !== key || this.destroyed) return;
        const rows = [];
        for (let i = pos; i < Math.min(total, pos + 1500); i++) rows.push(view.rowAt(i));
        await view.quickTracks(rows);
      }
    })();
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

// Plain-text cells.
const CELL = {
  year: (t) => (t.date || '').slice(0, 4),
  date: (t) => t.date || '',
  genre: (t, f) => splitValues(f.gn || t.genre || '', 'genres').join(', '),
  track: (t, f) => f.n || (t.trackNumber ? String(t.trackNumber) : ''),
  disc: (t) => (t.discNumber ? String(t.discNumber) : ''),
  len: (t) => formatTime(t.duration),
  codec: (t, f) => f.cd || '',
  bitrate: (t, f) => (f.br ? `${f.br} kbps` : ''),
  plays: (t, f) => f.pc || '',
  added: (t, f) => (f.ad || '').slice(0, 10),
};

/** "Go to album / artist / genre" for the song that was right-clicked. */
function goToItems(t) {
  if (!t) return [];
  const f = t.formats || {};
  // Every artist and genre on the song, by the names the Artists and Genres
  // tabs list (ARTISTS when tagged, else the album artist or artist).
  const artists = splitValues(f.ar || t.artist || '');
  const genres = splitValues(f.gn || t.genre || '', 'genres');
  const items = [{ label: 'Go to album', run: async () => view.goTo('albums', await view.albumKeyOf(t.handle)) }];
  if (artists.length === 1) items.push({ label: 'Go to artist', run: () => view.goTo('artists', artists[0]) });
  else if (artists.length) items.push({ label: 'Go to artist', submenu: artists.map((a) => ({ label: a, run: () => view.goTo('artists', a) })) });
  if (genres.length === 1) items.push({ label: 'Go to genre', run: () => view.goTo('genres', genres[0]) });
  else if (genres.length) items.push({ label: 'Go to genre', submenu: genres.map((g) => ({ label: g, run: () => view.goTo('genres', g) })) });
  return items;
}
