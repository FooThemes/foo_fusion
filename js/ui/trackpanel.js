// The expanded album: cover, details and the album's tracks laid out in
// columns, drawn under the row of the clicked tile.
//
// Multi-disc albums get a disc bar: "All discs" shows each disc as its own
// section (header with DISCSUBTITLE, its own cover thumbnail), and picking a
// disc shows just that one with its cover in the big art slot.

import { setTitle } from './titles.js';
import { albumColours } from '../data/albumcolours.js';
import { splitValues } from '../data/view.js';
import { el, clear, formatTime, formatDuration, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt } from '../data/artwork.js';
import { showMenu, addToItems, trackContextMenu } from './menus.js';
import { RowSelector } from './rowselect.js';
import { heartButton, refreshHearts } from './heart.js';
import { draggableRows, selectionOr } from './dnd.js';
import { favourites } from '../data/favourites.js';

const ROW_H = 35;
const COL_MIN = 300;
const PAD = 40; // same as the left margin, so the panel is evenly padded
const HEAD_H = 76;
const DISCBAR_H = 52;
const SECTION_H = 48; // disc header inside "All discs"

export class TrackPanel {
  constructor(grid) {
    this.grid = grid;
    this.group = null;
    this.index = -1;
    this.rows = [];
    this.discs = []; // [{ number, subtitle, rows, first }]
    this.disc = 'all'; // 'all' or a disc number
    this.height = 0;
    this.width = 0;
    this.cols = 1;

    this.bg = el('img.tp-bg', { alt: '', decoding: 'async' });
    this.cover = el('img', { alt: '', decoding: 'async' });
    this.coverBox = el('div.art.ph-album.tp-cover', null, this.cover);
    this.coverLabel = el('div.tp-cover-label', { hidden: true });
    this.title = el('h2.tp-title.ellipsis');
    this.meta = el('div.tp-meta.ellipsis');
    this.buttons = el('div.tp-buttons');
    this.discBar = el('div.tp-discs', { role: 'tablist', 'aria-label': 'Discs', hidden: true });
    this.list = el('div.tp-list', { role: 'listbox', 'aria-multiselectable': 'true' });
    this.notch = el('div.tp-notch');
    this.node = el(
      'div.trackpanel',
      { hidden: true },
      el('div.tp-bg-wrap', null, this.bg),
      this.notch,
      el(
        'div.tp-inner',
        null,
        el('div.tp-left', null, this.coverBox, this.coverLabel),
        el('div.tp-body', null, el('div.tp-head', null, this.title, this.meta, this.buttons), this.discBar, this.list),
      ),
    );
    this.selector = new RowSelector(this.list, () => this.visibleRows());
    favourites.on('change', ({ handles, state }) => refreshHearts(this.list, handles, state));
    draggableRows(this.list, (e) => {
      const r = rowOf(e);
      return r == null ? null : selectionOr(r);
    });
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

  /** Rows currently listed (the selected disc, or the whole album). */
  visibleRows() {
    if (this.disc === 'all' || this.discs.length < 2) return this.rows;
    return this.discs.find((d) => d.number === this.disc)?.rows || this.rows;
  }

  get multiDisc() {
    return this.discs.length > 1;
  }

  layout(width) {
    const prev = `${this.cols}|${this.perCol}`;
    this.width = width;
    if (!this.group) return;
    this.#measure();
    this.#position();
    // Column count changed: rebuild the rows so each grid gets its new shape.
    if (prev !== `${this.cols}|${this.perCol}` && this.tracks) this.#renderRows(this.tracks);
  }

  #measure() {
    const artLeft = store.get('listArtLeft') && this.width > 640;
    const coverSize = artLeft ? 260 : 0;
    const listW = this.width - 40 * 2 - (artLeft ? coverSize + PAD : 0);
    const maxCols = Math.max(1, Math.floor(listW / COL_MIN));

    const sections = this.disc === 'all' && this.multiDisc ? this.discs.map((d) => d.rows.length) : [this.visibleRows().length];
    const biggest = Math.max(...sections);
    this.cols = Math.max(1, Math.min(maxCols, Math.ceil(biggest / 4)));
    this.perCol = sections.map((n) => Math.ceil(n / this.cols));

    let body = this.perCol.reduce((h, rows) => h + rows * ROW_H, 0);
    if (sections.length > 1) body += sections.length * SECTION_H;
    // The disc bar wraps onto more lines for big box sets; use its real height.
    const extra = this.multiDisc ? this.discBar.offsetHeight || DISCBAR_H : 0;
    // Fit the content: the cover or the track list, whichever is taller.
    this.height = PAD * 2 + Math.max(coverSize, HEAD_H + extra + body);

    this.node.style.height = this.height + 'px';
    this.node.classList.toggle('no-cover', !artLeft);
    this.coverBox.style.width = this.coverBox.style.height = coverSize + 'px';
    this.node.style.setProperty('--tp-cols', this.cols);
  }

  open(group, index) {
    const same = this.group && group && this.group.key === group.key && this.group.start === group.start;
    this.group = group;
    this.index = index;
    this.rows = view.groupRows(group);
    if (!same) {
      this.tracks = null;
      this.discs = [];
      this.disc = 'all';
    }
    this.#measure();
    this.#position();
    this.node.hidden = false;
    this.node.dataset.bg = store.get('listBackground');
    this.refreshHead(group);
    this.#load();
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
    setTitle(this.title, head?.title || album || '');
    const total = this.#totalLength(this.rows);
    const discs = this.multiDisc ? plural(this.discs.length, 'disc') : null;
    // Artist and genres link to their own pages; blank genres are left out.
    const link = (kind, value) =>
      el('button.tp-link', { text: value, title: kind === 'artists' ? `Show ${value}'s albums` : `Show ${value} albums`, onclick: () => view.showValue(kind, value) });
    const parts = [];
    const who = head?.artist || artist;
    if (who) parts.push(link('artists', who));
    if (head?.date || head?.year) parts.push(head.date || head.year);
    for (const g of splitValues(head?.genre || '')) parts.push(link('genres', g));
    for (const t of [discs, plural(this.rows.length, 'song'), total ? formatDuration(total) : null]) if (t) parts.push(t);
    clear(this.meta);
    parts.forEach((p, i) => this.meta.append(...(i ? [' · '] : []), p));
    const mode = store.get('listBackground');
    if (head?.handle && mode === 'blur') bindArt(this.bg, head.handle, 160, ['parent', 'front']);
    this.#renderCover();
    this.#applyColours(mode === 'art' ? head?.handle : null);
    const rows = () => this.visibleRows();
    clear(this.buttons).append(
      btn('play', 'Play', () => view.play(rows()[0])),
      btn('add', 'Add to', () => showMenu(addToItems(rows()))),
      btn('queue', 'Add to queue', () => view.queueRows(rows())),
      btn('close', 'Close', () => this.grid.collapse()),
    );
  }

  // "Album colours": background and text colours taken from the cover.
  async #applyColours(handle) {
    const st = this.node.style;
    const clearVars = () => ['--list-bg', '--list-text', '--list-text2', '--accent', '--accent-text'].forEach((v) => st.removeProperty(v));
    if (!handle) return clearVars();
    const group = this.group;
    const pal = await albumColours(handle, this.cover);
    if (this.group !== group) return;
    if (!pal) return clearVars();
    st.setProperty('--list-bg', pal.bg);
    st.setProperty('--list-text', pal.text);
    st.setProperty('--list-text2', pal.text2);
    st.setProperty('--accent', pal.accent);
    st.setProperty('--accent-text', pal.accentText);
  }

  #renderCover() {
    const disc = this.disc !== 'all' && this.discs.find((d) => d.number === this.disc);
    const handle = disc?.first?.handle || this.group?.head?.handle;
    // "All discs" prefers the box-set cover in the folder above the discs.
    if (handle) bindArt(this.cover, handle, 260, disc ? ['front'] : ['parent', 'front']);
    this.coverLabel.hidden = !disc;
    this.coverLabel.textContent = disc ? discLabel(disc) : '';
  }

  reload() {
    if (this.group) this.#load();
  }

  #totalLength(rows) {
    let t = 0;
    for (const r of rows) t += view.cachedTrack(r)?.duration || 0;
    return t;
  }

  async #load() {
    const group = this.group;
    // Draw placeholders straight away so the panel never looks empty.
    if (!this.discs.length) this.#renderRows(null);
    const tracks = await view.tracks(this.rows);
    if (this.group !== group) return;
    this.tracks = tracks;
    const discs = splitDiscs(this.rows, tracks);
    const fresh = this.discs.length !== discs.length;
    this.discs = discs;
    if (fresh) this.disc = 'all';
    this.#renderDiscBar();
    this.#measure();
    this.grid.relayout();
    this.#renderRows(tracks);
    this.refreshHead(group);
  }

  #renderDiscBar() {
    clear(this.discBar);
    this.discBar.hidden = !this.multiDisc;
    if (!this.multiDisc) return;
    const chip = (key, label, title, handle) => {
      const on = this.disc === key;
      const thumb = handle ? el('img', { alt: '', decoding: 'async' }) : null;
      const node = el(
        'button.tp-disc' + (on ? '.on' : ''),
        { role: 'tab', 'aria-selected': String(on), title, onclick: () => this.showDisc(key) },
        thumb ? el('span.art.ph-album.tp-disc-art', null, thumb) : icon('disc'),
        el('span.ellipsis', { text: label }),
      );
      if (thumb) bindArt(thumb, handle, 32, ['front']);
      return node;
    };
    this.discBar.append(chip('all', 'All discs', `All ${this.discs.length} discs`, null));
    for (const d of this.discs) {
      const label = d.subtitle ? `${d.number || '?'} · ${d.subtitle}` : `Disc ${d.number || '?'}`;
      this.discBar.append(chip(d.number, label, `${discLabel(d)} · ${plural(d.rows.length, 'song')}`, d.first?.handle));
    }
  }

  showDisc(key) {
    if (key === this.disc) return;
    this.disc = key;
    this.#renderDiscBar();
    this.#measure();
    this.grid.relayout();
    this.#renderRows(this.tracks);
    this.#renderCover();
  }

  #renderRows(tracks) {
    clear(this.list);
    const byRow = new Map();
    (tracks || []).forEach((t) => t && byRow.set(t.index, t));
    const albumArtist = this.group?.head?.artist || '';
    const makeRows = (rows, perCol) => {
      const grid = el('div.tp-grid', { style: { gridTemplateRows: `repeat(${perCol}, ${ROW_H}px)` } });
      for (const r of rows) grid.append(trackRow(r, byRow.get(r), albumArtist));
      return grid;
    };
    if (this.multiDisc && this.disc === 'all') {
      this.discs.forEach((d, i) => {
        const len = this.#totalLength(d.rows);
        const thumb = el('img', { alt: '', decoding: 'async' });
        if (d.first?.handle) bindArt(thumb, d.first.handle, 40, ['front']);
        this.list.append(
          el(
            'div.tp-section',
            { style: { height: SECTION_H + 'px' } },
            el('span.art.ph-album.tp-section-art', null, thumb),
            el('span.tp-section-title.ellipsis', { text: discLabel(d) }),
            el('span.tp-section-meta', { text: [plural(d.rows.length, 'song'), len ? formatDuration(len) : null].filter(Boolean).join(' · ') }),
            el('button.btn-icon.tp-section-play', { title: `Play ${discLabel(d)}`, onclick: () => view.play(d.rows[0]) }, icon('play')),
          ),
          makeRows(d.rows, this.perCol[i]),
        );
      });
    } else {
      this.list.append(makeRows(this.visibleRows(), this.perCol[0]));
    }
    this.refreshSelection();
    this.refreshPlaying();
  }

  refreshSelection() {
    for (const node of this.list.querySelectorAll('.tp-row')) node.classList.toggle('selected', view.selection.has(Number(node.dataset.row)));
  }

  refreshPlaying() {
    const playing = player.playingPlaylist === view.playlist?.index ? player.playingIndex : -1;
    for (const node of this.list.querySelectorAll('.tp-row')) {
      const on = Number(node.dataset.row) === playing;
      node.classList.toggle('playing', on);
      const num = node.children[0];
      if (on && !num.querySelector('.icon')) num.replaceChildren(icon(player.state === 'paused' ? 'pause' : 'nowPlaying'));
      else if (!on && num.querySelector('.icon')) num.textContent = trackNum(view.cachedTrack(Number(node.dataset.row)));
    }
  }
}

/** Split an album's rows by DISCNUMBER, keeping playlist order. */
function splitDiscs(rows, tracks) {
  const discs = [];
  const byNumber = new Map();
  rows.forEach((r, i) => {
    const t = tracks[i];
    const n = t?.discNumber || 0;
    let d = byNumber.get(n);
    if (!d) {
      d = { number: n, subtitle: t?.formats?.ds || '', rows: [], tracks: [], first: t };
      byNumber.set(n, d);
      discs.push(d);
    }
    d.rows.push(r);
    d.tracks.push(t);
    if (!d.subtitle && t?.formats?.ds) d.subtitle = t.formats.ds;
  });
  discs.sort((a, b) => a.number - b.number);
  return discs.length > 1 ? discs : [];
}

function discLabel(d) {
  if (!d) return '';
  return `Disc ${d.number || '?'}${d.subtitle ? ` · ${d.subtitle}` : ''}`;
}

function trackNum(t) {
  return t ? t.formats?.n || (t.trackNumber ? String(t.trackNumber).padStart(2, '0') : '') : '';
}

function trackRow(r, t, albumArtist) {
  const name = el('span.tp-name.ellipsis');
  const node = el(
    'div.tp-row',
    { role: 'option', dataset: { row: r }, tabindex: -1, draggable: true },
    el('span.tp-num', { text: trackNum(t) }),
    name,
    t ? heartButton(t.handle, favourites.state(t)) : null,
    el('span.tp-len', { text: t ? formatTime(t.duration) : '' }),
  );
  if (t) {
    setTitle(name, t.title || t.handle.split('\\').pop());
    if (t.artist && albumArtist && t.artist.toLowerCase() !== albumArtist.toLowerCase()) name.append(el('span.tp-artist', { text: ` · ${t.artist}` }));
    name.title = name.textContent;
  }
  return node;
}

function rowOf(e) {
  const node = e.target.closest('.tp-row');
  return node ? Number(node.dataset.row) : null;
}

function btn(name, label, onclick) {
  return el('button.btn-icon.round', { title: label, 'aria-label': label, onclick }, icon(name));
}
