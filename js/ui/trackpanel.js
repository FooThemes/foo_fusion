// The expanded album: cover, details and the album's tracks laid out in
// columns, drawn under the row of the clicked tile.

import { el, clear, formatTime, formatDuration, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt } from '../data/artwork.js';
import { showMenu, addToItems, trackContextMenu } from './menus.js';
import { RowSelector } from './rowselect.js';

const ROW_H = 35;
const COL_MIN = 300;
const MIN_H = 350; // "List height min" in the original
const PAD = 30;
const HEAD_H = 76;

export class TrackPanel {
  constructor(grid) {
    this.grid = grid;
    this.group = null;
    this.index = -1;
    this.rows = [];
    this.height = 0;
    this.width = 0;

    this.bg = el('img.tp-bg', { alt: '', decoding: 'async' });
    this.cover = el('img', { alt: '', decoding: 'async' });
    this.coverBox = el('div.art.ph-album.tp-cover', null, this.cover);
    this.title = el('h2.tp-title.ellipsis');
    this.meta = el('div.tp-meta.ellipsis');
    this.buttons = el('div.tp-buttons');
    this.list = el('div.tp-list', { role: 'listbox', 'aria-multiselectable': 'true' });
    this.notch = el('div.tp-notch');
    this.node = el(
      'div.trackpanel',
      { hidden: true },
      el('div.tp-bg-wrap', null, this.bg),
      this.notch,
      el('div.tp-inner', null, this.coverBox, el('div.tp-body', null, el('div.tp-head', null, this.title, this.meta, this.buttons), this.list)),
    );
    this.selector = new RowSelector(this.list, () => this.rows);
    this.list.addEventListener('dblclick', (e) => {
      const r = rowOf(e);
      if (r != null) view.play(r);
    });
    this.list.addEventListener('contextmenu', (e) => {
      const r = rowOf(e);
      if (r == null) return;
      e.preventDefault();
      trackContextMenu(view.selection.has(r) ? [...view.selection] : [r]);
    });
  }

  layout(width) {
    this.width = width;
    if (this.group) this.#measure();
  }

  #measure() {
    const n = this.rows.length;
    const artLeft = store.get('listArtLeft') && this.width > 640;
    const coverSize = artLeft ? Math.min(260, MIN_H - PAD * 2) : 0;
    const listW = this.width - 40 * 2 - (artLeft ? coverSize + PAD : 0);
    this.cols = Math.max(1, Math.min(Math.floor(listW / COL_MIN), Math.ceil(n / 4)));
    const minRows = Math.floor((MIN_H - PAD * 2 - HEAD_H) / ROW_H);
    this.perCol = Math.max(Math.ceil(n / this.cols), Math.min(n, minRows));
    this.height = Math.max(MIN_H, PAD * 2 + HEAD_H + this.perCol * ROW_H);
    this.node.style.height = this.height + 'px';
    this.node.classList.toggle('no-cover', !artLeft);
    this.coverBox.style.width = this.coverBox.style.height = coverSize + 'px';
    this.list.style.gridTemplateRows = `repeat(${this.perCol}, ${ROW_H}px)`;
    this.list.style.gridTemplateColumns = `repeat(${this.cols}, minmax(0, 1fr))`;
  }

  open(group, index) {
    this.group = group;
    this.index = index;
    this.rows = view.groupRows(group);
    this.#measure();
    this.#position();
    this.node.hidden = false;
    this.node.dataset.bg = store.get('listBackground');
    this.refreshHead(group);
    this.#renderRows();
  }

  close() {
    this.group = null;
    this.index = -1;
    this.node.hidden = true;
    this.height = 0;
  }

  #position() {
    const g = this.grid;
    const row = Math.floor(this.index / g.cols);
    const top = g.rowTop(row) + g.tileH;
    this.node.style.transform = `translateY(${top}px)`;
    const col = this.index % g.cols;
    this.notch.style.left = 40 + col * g.tileW + g.tileW / 2 - 12 + 'px';
  }

  refreshHead(group) {
    if (!group || group !== this.group) return;
    const head = group.head;
    const [artist, album] = group.key.split('|');
    this.title.textContent = head?.title || album || '';
    const total = this.#totalLength();
    this.meta.textContent = [head?.artist || artist, head?.year, head?.genre, plural(this.rows.length, 'song'), total ? formatDuration(total) : null].filter(Boolean).join(' · ');
    if (head?.handle) {
      bindArt(this.cover, head.handle, 260, ['front']);
      if (store.get('listBackground') !== 'plain') bindArt(this.bg, head.handle, 160, ['front']);
    }
    clear(this.buttons).append(
      btn('play', 'Play', () => view.play(this.rows[0])),
      btn('add', 'Add to', () => showMenu(addToItems(this.rows))),
      btn('queue', 'Add to queue', () => view.queueRows(this.rows)),
      btn('close', 'Close', () => this.grid.collapse()),
    );
  }

  #totalLength() {
    let t = 0;
    for (const r of this.rows) t += view.cachedTrack(r)?.duration || 0;
    return t;
  }

  async #renderRows() {
    const group = this.group;
    const rows = this.rows;
    clear(this.list);
    const frag = document.createDocumentFragment();
    const nodes = rows.map((r) => {
      const node = el('div.tp-row', { role: 'option', dataset: { row: r }, tabindex: -1 }, el('span.tp-num'), el('span.tp-name.ellipsis'), el('span.tp-len'));
      frag.append(node);
      return node;
    });
    this.list.append(frag);
    this.refreshSelection();
    this.refreshPlaying();
    const tracks = await view.tracks(rows);
    if (this.group !== group) return;
    const albumArtist = group.head?.artist || '';
    tracks.forEach((t, n) => {
      if (!t) return;
      const node = nodes[n];
      node.children[0].textContent = t.formats?.n || (t.trackNumber ? t.trackNumber : '');
      const name = node.children[1];
      name.textContent = t.title || t.handle.split('\\').pop();
      if (t.artist && albumArtist && t.artist.toLowerCase() !== albumArtist.toLowerCase()) {
        name.append(el('span.tp-artist', { text: ` · ${t.artist}` }));
      }
      name.title = name.textContent;
      node.children[2].textContent = formatTime(t.duration);
    });
    this.refreshHead(group);
  }

  refreshSelection() {
    for (const node of this.list.children) node.classList.toggle('selected', view.selection.has(Number(node.dataset.row)));
  }

  refreshPlaying() {
    const playing = player.playingPlaylist === view.playlist?.index ? player.playingIndex : -1;
    for (const node of this.list.children) {
      const on = Number(node.dataset.row) === playing;
      node.classList.toggle('playing', on);
      const num = node.children[0];
      if (on && !num.querySelector('.icon')) num.replaceChildren(icon(player.state === 'paused' ? 'pause' : 'nowPlaying'));
      else if (!on && num.querySelector('.icon')) {
        const t = view.cachedTrack(Number(node.dataset.row));
        num.textContent = t?.formats?.n || '';
      }
    }
  }
}

function rowOf(e) {
  const node = e.target.closest('.tp-row');
  return node ? Number(node.dataset.row) : null;
}

function btn(name, label, onclick) {
  return el('button.btn-icon.round', { title: label, 'aria-label': label, onclick }, icon(name));
}
