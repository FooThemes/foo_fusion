// The expanded album: cover, details and the album's tracks laid out in
// columns, drawn under the row of the clicked tile.
//
// Multi-disc albums get a disc bar: "All discs" shows each disc as its own
// section (header with DISCSUBTITLE, its own cover thumbnail), and picking a
// disc shows just that one with its cover in the big art slot.

import { setTitle, setVersioned, versionText } from './titles.js';
import { softBackdrop } from './backdrop.js';
import { pickVersion, parseVersions } from '../data/versions.js';
import { albumColours } from '../data/albumcolours.js';
import { splitValues } from '../data/view.js';
import { el, clear, formatTime, formatDuration, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt, albumArtTypes, preloadArt } from '../data/artwork.js';
import { addToItems, trackContextMenu, refreshAlbums } from './menus.js';
import { dropdown } from './dropdown.js';
import { prefetchWave } from './waveform.js';
import { RowSelector } from './rowselect.js';
import { heartButton, refreshHearts } from './heart.js';
import { draggableRows, selectionOr } from './dnd.js';
import { favourites } from '../data/favourites.js';
import { valueLink } from './links.js';

const ROW_H = 35;
const COL_MIN = 300;
const COL_GAP = 30; // .tp-grid column-gap
const ROW_CHROME = 150; // number, heart, length, padding and gaps around a title
const PLAYS_W = 76; // a song's plays (Listening stats): .tp-plays and its gap
const ROW_H2 = 52; // two-line rows for albums of long titles
const MAX_ROWS = 22; // fewer columns, but not longer than this per column
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
    // The artwork handler allows cross-origin reads, so with CORS the cover's
    // pixels can be sampled for Album colours without reading the file again.
    this.cover.crossOrigin = 'anonymous';
    this.coverBox = el('div.art.ph-album.tp-cover', null, this.cover);
    // Right-click the cover: foobar2000's menu for the album (or the disc shown).
    this.coverBox.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.group) trackContextMenu(this.visibleRows(), this.#refreshItems(this.rows), { select: false });
    });
    // Covers loaded again ("Refresh artwork"): colours from the new cover.
    this.onArtRefresh = () => this.group && this.#renderCover();
    window.addEventListener('fusion:artrefresh', this.onArtRefresh);
    this.coverLabel = el('div.tp-cover-label', { hidden: true });
    this.title = el('h2.tp-title.ellipsis');
    // The title too (the whole album, nothing selected).
    this.title.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.group) trackContextMenu(this.visibleRows(), this.#refreshItems(this.rows), { select: false });
    });
    this.meta = el('div.tp-meta.ellipsis');
    this.buttons = el('div.tp-buttons');
    this.discBar = el('div.tp-discs', { role: 'tablist', 'aria-label': 'Discs', hidden: true });
    this.list = el('div.tp-list', { role: 'listbox', 'aria-multiselectable': 'true' });
    this.notch = el('div.tp-notch');
    this.topline = el('div.tp-topline');
    this.node = el(
      'div.trackpanel',
      { hidden: true },
      el('div.tp-bg-wrap', null, this.bg),
      this.topline,
      this.notch,
      el(
        'div.tp-inner',
        null,
        el('div.tp-left', null, this.coverBox, this.coverLabel),
        el('div.tp-body', null, el('div.tp-head', null, this.title, this.meta, this.buttons), this.discBar, this.list),
      ),
    );
    softBackdrop(this.bg, { blur: 40, at: 1400 });
    this.selector = new RowSelector(this.list, () => this.visibleRows());
    this.offFav = favourites.on('change', ({ handles, state }) => refreshHearts(this.list, handles, state));
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
    // As many columns as the song count suggests, then fewer while too many
    // titles would be cut off (long titles get wider columns, more rows).
    let cols = Math.max(1, Math.min(maxCols, Math.ceil(biggest / 4)));
    const widths = this.#labelWidths();
    const colWidth = (c) => (listW - COL_GAP * (c - 1)) / c - ROW_CHROME - (this.group?.plays ? PLAYS_W : 0);
    const fitShare = (c, lines = 1) => (widths.length ? widths.filter((w) => w <= colWidth(c) * lines).length / widths.length : 1);
    const floor = Math.max(1, Math.min(cols, Math.ceil(biggest / MAX_ROWS)));
    while (cols > floor && fitShare(cols) < 0.9) cols--;
    // Mostly long titles even so (classical works, say): give rows two lines.
    this.twoLine = widths.length > 0 && fitShare(cols) < 0.5;
    this.rowH = this.twoLine ? ROW_H2 : ROW_H;
    this.cols = cols;
    this.perCol = sections.map((n) => Math.ceil(n / this.cols));
    this.node.classList.toggle('two-line', this.twoLine);

    let body = this.perCol.reduce((h, rows) => h + rows * this.rowH, 0);
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

  destroy() {
    this.group = null; // pending retries and loads stop here
    this.offFav();
    window.removeEventListener('fusion:artrefresh', this.onArtRefresh);
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
    const nx = 40 + col * g.tileW + g.tileW / 2;
    this.notch.style.left = nx - 8 + 'px';
    this.node.style.setProperty('--nx', nx + 'px');
  }

  /** The album title: its lead version, then the others smaller after it. */
  #renderTitle(head, album) {
    const v = head?.versions?.album;
    const pick = pickVersion(v, 'albums');
    if (!pick) {
      setTitle(this.title, head?.title || album || '');
      this.title.title = '';
      return;
    }
    setTitle(this.title, pick.base + (pick.other ? '' : head.albumSuffix || ''));
    if (pick.other) {
      this.title.append(' ', el('span.alt-version', { text: pick.other }));
      const end = [pick.suffix, head.albumSuffix].filter(Boolean).join(' ').trim();
      if (end) this.title.append(' ', el('span', { text: end }));
    }
    this.title.title = pick.tip;
  }

  /**
   * Only some of the album's songs here (an artist's page, Favourites, a
   * search): offer the whole album, from the Collection.
   */
  async #offerFullAlbum(group) {
    if (view.isFullCollection) return;
    const total = (await view.albumTotals()).get(group.key.toLowerCase()) || 0;
    if (group !== this.group || total <= this.rows.length) return;
    this.buttons.querySelector('.tp-full')?.remove();
    this.buttons.prepend(
      el('button.btn-outline.tp-full', { title: `Open the whole album (${plural(total, 'song')}) in the Collection`, onclick: () => view.goTo('albums', group.key) }, icon('collection'), el('span', { text: `Full album · ${total}` })),
    );
  }

  refreshHead(group) {
    if (!group || group !== this.group) return;
    const head = group.head;
    const [artist, album] = group.key.split('|');
    this.#renderTitle(head, album);
    const total = this.#totalLength(this.rows);
    const discs = this.multiDisc ? plural(this.discs.length, 'disc') : null;
    // Artist and genres link to their own pages; blank genres are left out.
    const link = (kind, value, label = value) => valueLink(kind, value, { label, go: () => view.showValue(kind, value, this.group) });
    const parts = [];
    const who = head?.artist || artist;
    // With versions, the link shows the lead one and opens the original
    // (the name the Artists tab lists, from the untouched ARTISTS tag).
    const whoV = head?.versions?.albumArtist;
    if (who) {
      const a = link('artists', whoV?.orig || who, versionText(who, whoV, 'artists'));
      setVersioned(a, who, whoV, 'artists'); // the lead name, then the others dimmed
      parts.push(a);
    }
    if (head?.date || head?.year) parts.push(head.date || head.year);
    for (const g of splitValues(head?.genre || '', 'genres')) parts.push(link('genres', g));
    for (const t of [discs, plural(this.rows.length, 'song'), total ? formatDuration(total) : null]) if (t) parts.push(t);
    if (group.playsTotal) parts.push(plural(group.playsTotal, 'play')); // opened from Listening stats
    clear(this.meta);
    parts.forEach((p, i) => this.meta.append(...(i ? [' · '] : []), p));
    this.#offerFullAlbum(group);
    this.#renderCover();
    const rows = () => this.visibleRows();
    clear(this.buttons).append(
      btn('play', 'Play', () => view.play(rows()[0])),
      btn('add', 'Add to', (e) => dropdown(e.currentTarget, addToItems(rows()), { align: 'right' })),
      btn('queue', 'Add to queue', () => view.queueRows(rows())),
      btn('close', 'Close', () => this.grid.collapse()),
    );
  }

  // "Album colours": background and text colours taken from the cover.
  async #applyColours(handle, variant = '') {
    const st = this.node.style;
    const clearVars = () => ['--list-bg', '--list-text', '--list-text2', '--accent', '--accent-text'].forEach((v) => st.removeProperty(v));
    this.colourFor = variant + handle;
    if (!handle) return clearVars();
    // The previous album's colours only briefly while this cover loads.
    const want = variant + handle;
    const stale = setTimeout(() => this.colourFor === want && clearVars(), 300);
    const pal = await albumColours(handle, this.cover, variant);
    clearTimeout(stale);
    if (this.colourFor !== variant + handle) return; // another disc/album was picked meanwhile
    if (!pal) return clearVars();
    st.setProperty('--list-bg', pal.bg);
    st.setProperty('--list-text', pal.text);
    st.setProperty('--list-text2', pal.text2);
    st.setProperty('--accent', pal.accent);
    st.setProperty('--accent-text', pal.accentText);
  }

  #refreshItems(rows) {
    return [{ label: 'Refresh album', run: () => refreshAlbums(rows) }];
  }

  #renderCover() {
    const disc = this.disc !== 'all' && this.discs.find((d) => d.number === this.disc);
    const handle = disc?.first?.handle || this.group?.head?.handle;
    // "All discs" prefers the box-set cover in the folder above the discs.
    const types = disc ? ['front'] : albumArtTypes(store.get('separateDiscs'));
    // The previous cover stays until this one has loaded (no placeholder flash).
    if (handle) bindArt(this.cover, handle, 260, types, { hold: true });
    // The blurred background follows the cover shown too.
    if (handle && store.get('listBackground') === 'blur') bindArt(this.bg, handle, 160, types, { hold: true });
    // Album colours follow the cover shown: a disc's own cover when one is picked.
    this.#applyColours(store.get('listBackground') === 'art' ? handle : null, disc ? `disc${disc.number}` : 'all');
    this.coverLabel.hidden = !disc;
    this.coverLabel.textContent = disc ? discLabel(disc) : '';
  }

  reload() {
    if (this.group) this.#load();
  }

  /** Width each loaded song's title (plus its artist note) needs, in px. */
  #labelWidths() {
    if (!this.tracks) return [];
    const key = this.group?.key + '|' + this.disc + '|' + this.tracks.length;
    if (this.widthsKey === key) return this.widths;
    const ctx = (measureCtx ||= new OffscreenCanvas(1, 1).getContext('2d'));
    ctx.font = `14px ${getComputedStyle(document.body).fontFamily}`;
    const head = this.group?.head;
    const albumArtist = versionText(head?.artist || '', head?.versions?.albumArtist, 'artists');
    const want = new Set(this.visibleRows());
    this.widths = this.tracks
      .filter((t) => t && want.has(t.index))
      .map((t) => {
        const note = artistNote(t.artist, albumArtist);
        return ctx.measureText((t.title || '') + (note ? ` · ${note}` : '')).width;
      });
    this.widthsKey = key;
    return this.widths;
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
    // The list reloaded underneath (e.g. a re-sort on opening): nothing came
    // back; read the songs again rather than leave empty rows.
    if (this.rows.length && tracks.every((t) => !t)) {
      this.retries = (this.retries || 0) + 1;
      if (this.retries <= 8) setTimeout(() => this.group === group && this.#load(), 250);
      return;
    }
    this.retries = 0;
    this.tracks = tracks;
    // Opened from outside the album list (Listening stats): the heading's
    // year and genre from the songs, now they're read.
    if (group.partialHead && tracks[0]) {
      group.head.date ||= tracks[0].date;
      group.head.genre ||= tracks[0].genre;
      group.partialHead = false;
    }
    // Likely to be played next: its first song's waveform, ready for then.
    if (store.get('waveformSeekbar') && tracks[0]?.handle) setTimeout(() => this.group === group && prefetchWave(tracks[0].handle), 600);
    const discs = splitDiscs(this.rows, tracks);
    const fresh = this.discs.length !== discs.length;
    this.discs = discs;
    if (fresh) this.disc = 'all';
    this.#renderDiscBar();
    // Get every disc's cover ready, so picking a disc shows it at once.
    if (this.multiDisc) for (const d of this.discs) if (d.first?.handle) preloadArt(d.first.handle, 260, ['front']);
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
        {
          role: 'tab',
          'aria-selected': String(on),
          title,
          dataset: { disc: String(key) },
          onclick: () => this.showDisc(key),
          // Right-click: foobar2000's menu for that disc (or the whole album).
          oncontextmenu: (e) => {
            e.preventDefault();
            const d = key === 'all' ? null : this.discs.find((x) => x.number === key);
            trackContextMenu(d ? d.rows : this.rows, this.#refreshItems(this.rows), { select: false });
          },
        },
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
    // Just move the highlight; rebuilding the chips reloaded their pictures.
    for (const b of this.discBar.children) {
      const on = b.dataset.disc === String(key);
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
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
      const grid = el('div.tp-grid', { style: { gridTemplateRows: `repeat(${perCol}, ${this.rowH || ROW_H}px)` } });
      for (const r of rows) grid.append(trackRow(r, byRow.get(r), albumArtist, this.group?.plays));
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
            {
              style: { height: SECTION_H + 'px' },
              oncontextmenu: (e) => {
                e.preventDefault();
                trackContextMenu(d.rows, this.#refreshItems(this.rows), { select: false });
              },
            },
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
    // Titles still cut off scroll into view on hover (see .tp-name.clipped).
    requestAnimationFrame(() => {
      for (const n of this.list.querySelectorAll('.tp-name')) {
        const over = this.twoLine ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth;
        n.classList.toggle('clipped', over > 2 && !this.twoLine);
        if (over > 2 && !this.twoLine) {
          n.style.setProperty('--mq-dist', -over - 6 + 'px');
          n.style.setProperty('--mq-dur', Math.max(1.2, over / 90 + 0.6) + 's');
        }
      }
    });
    this.refreshSelection();
    this.refreshPlaying();
  }

  refreshSelection() {
    for (const node of this.list.querySelectorAll('.tp-row')) node.classList.toggle('selected', view.selection.has(Number(node.dataset.row)));
  }

  refreshPlaying() {
    const playing = player.playingPlaylist === view.playlist?.index ? player.playingIndex : -1;
    // By the song itself when its data is here (a row number can be stale
    // for a moment after the playlist changes), else by row.
    const handle = player.active ? player.track?.handle : null;
    for (const node of this.list.querySelectorAll('.tp-row')) {
      const t = view.cachedTrack(Number(node.dataset.row));
      const on = t && handle && !t.quick ? t.handle === handle : Number(node.dataset.row) === playing;
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
      d = { number: n, subtitle: discSubtitle(t), rows: [], tracks: [], first: t };
      byNumber.set(n, d);
      discs.push(d);
    }
    d.rows.push(r);
    d.tracks.push(t);
    if (!d.subtitle && t?.formats?.ds) d.subtitle = discSubtitle(t);
  });
  discs.sort((a, b) => a.number - b.number);
  return discs.length > 1 ? discs : [];
}

/** A disc's subtitle, in its lead version when it has versions. */
function discSubtitle(t) {
  return versionText(t?.formats?.ds || '', parseVersions(t?.formats?.vd), 'discs');
}

function discLabel(d) {
  if (!d) return '';
  return `Disc ${d.number || '?'}${d.subtitle ? ` · ${d.subtitle}` : ''}`;
}

function trackNum(t) {
  return t ? t.formats?.n || (t.trackNumber ? String(t.trackNumber).padStart(2, '0') : '') : '';
}

/** `plays`: each song's plays by handle, shown before its length (Listening stats). */
function trackRow(r, t, albumArtist, plays) {
  // The text sits in an inner span so a cut-off title can slide on hover.
  const text = el('span.tp-name-in');
  const name = el('span.tp-name.ellipsis', null, text);
  const node = el(
    'div.row.tp-row',
    { role: 'option', dataset: { row: r }, tabindex: -1 },
    el('span.tp-num', { text: trackNum(t) }),
    name,
    t ? heartButton(t.handle, favourites.state(t)) : null,
    plays ? el('span.tp-plays', { text: t && plays.get(t.handle) ? plural(plays.get(t.handle), 'play') : '' }) : null,
    el('span.tp-len', { text: t ? formatTime(t.duration) : '' }),
  );
  if (t) {
    const tip = setVersioned(text, t.title || t.handle.split('\\').pop(), parseVersions(t.formats?.vt), 'titles');
    const note = artistNote(versionText(t.artist, parseVersions(t.formats?.va), 'artists'), albumArtist);
    if (note) text.append(el('span.tp-artist', { text: ` · ${note}` }));
    name.title = tip || name.textContent;
  }
  return node;
}

/**
 * The artist shown after a song title, when it differs from the album artist:
 * "Jeff Williams feat. Casey Lee Williams" on a Jeff Williams album becomes
 * "feat. Casey Lee Williams"; the same artist shows nothing.
 */
function artistNote(artist, albumArtist) {
  if (!artist) return '';
  if (!albumArtist) return artist;
  const a = artist.trim();
  const aa = albumArtist.trim();
  if (a.toLowerCase() === aa.toLowerCase()) return '';
  if (a.toLowerCase().startsWith(aa.toLowerCase())) {
    const rest = a.slice(aa.length).replace(/^[\s,&;/+x×]+/i, '').trim();
    if (!rest) return '';
    return /^(feat\.?|ft\.?|featuring|with|vs\.?|and)\b/i.test(rest) ? rest : `with ${rest}`;
  }
  return a;
}

let measureCtx = null;

function rowOf(e) {
  const node = e.target.closest('.tp-row');
  return node ? Number(node.dataset.row) : null;
}

function btn(name, label, onclick) {
  return el('button.btn-icon.btn-outline.round', { title: label, 'aria-label': label, onclick }, icon(name));
}
