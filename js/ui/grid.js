// Tile grid for Albums / Artists / Genres, with the original skin's
// "expand in place" track list under the clicked album.
//
// Virtualised: only tiles near the viewport exist in the DOM, and tile nodes
// are recycled while scrolling, so a library with thousands of albums costs
// the same as one with fifty.

import { setTitle, versionText } from './titles.js';
import { pickVersion } from '../data/versions.js';
import { artistNameVersions } from '../data/artistinfo.js';
import { el, rafThrottle, plural, hash } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view, firstRow } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt, albumArtTypes, warmArt, refreshArtist } from '../data/artwork.js';
import { ArtistHero } from './artisthero.js';
import { GenreHero } from './genrehero.js';
import { Shelves } from './shelves.js';
import { musicArtistFolder, onPictureRevoked } from '../data/artistinfo.js';
import { trackContextMenu, handlesOf, refreshAlbums } from './menus.js';
import { TrackPanel } from './trackpanel.js';
import { genreFiles, forgetGenreInfo } from '../data/genreinfo.js';
import { editArtist, editGenre } from './infoeditor.js';
import { genrePictureUrl, collageUrl, forgetCollages } from './collage.js';
import { draggableRows } from './dnd.js';

const genreTiles = new Map(); // genre|size -> picture or collage URL (null: none)
// Those pictures, decoded and held (their own store, so browsing albums
// can't push them out): a tile handed one draws it the same frame.
const genreDecoded = new Map(); // url -> HTMLImageElement
function holdDecoded(url) {
  if (!url || genreDecoded.has(url)) return;
  const im = new Image();
  im.src = url;
  im.decode().catch(() => {});
  genreDecoded.set(url, im);
}
// Whether or not a grid is showing: URLs that are no longer valid go.
window.addEventListener('fusion:genrerefresh', () => {
  forgetCollages();
  genreTiles.clear();
  genreDecoded.clear();
});
onPictureRevoked((url) => {
  for (const [k, v] of genreTiles) if (v === url) genreTiles.delete(k);
  genreDecoded.delete(url);
});
const MARGIN = 32; // left/right margin: with the tile padding (PAD), covers line up with the tabs above
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
    this.top = 16; // where the first row starts (below the artist header, if any)
    // Everything this grid listens to outside its own nodes ends with it
    // (see destroy), or every visit to Songs and back would keep a grid alive.
    this.ac = new AbortController();
    const signal = this.ac.signal;
    this.hero = new ArtistHero(this);
    this.genreHero = new GenreHero(this);
    this.layer.append(this.hero.node, this.genreHero.node);
    // Home shelves above the Collection's albums (outside the tile layer, so
    // the grid's own clicks and drags never see them).
    this.shelves = new Shelves(this, this.sizer);

    // Genre pictures or information changed (the script ran, the folder moved).
    window.addEventListener(
      'fusion:genrerefresh',
      () => {
        if (this.kind !== 'genres') return;
        for (const node of this.tiles.values()) delete node.querySelector('.art img').dataset.artToken;
        this.refreshHeads();
      },
      { signal },
    );

    this.onScroll = rafThrottle(() => this.render());
    const stopReveal = () => (this.revealUntil = 0);
    scroller.addEventListener('wheel', stopReveal, { passive: true, signal });
    scroller.addEventListener('pointerdown', (e) => e.target === scroller && stopReveal(), { signal });
    scroller.addEventListener('keydown', stopReveal, { signal });
    scroller.addEventListener('scroll', this.onScroll, { passive: true, signal });
    // Resizing the window: when the number of columns changes, the tiles
    // glide to their new places (as they do when a panel slides).
    this.ro = new ResizeObserver(
      rafThrottle(() => {
        if (this.sliding || this.rowCount == null || store.get('animations') === false) return this.layout();
        const w = this.scroller.clientWidth;
        const min = this.kind === 'artists' ? store.get('artistTileSize') : store.get('tileSize');
        const cols = Math.max(1, Math.floor((w - MARGIN * 2) / (min + PAD * 2)));
        if (cols !== this.cols && w) this.#glideTo(null);
        else this.layout();
      }),
    );
    this.ro.observe(scroller);
    // The side panels slide open and shut (the info panel, the sidebar): as
    // the slide starts, the tiles move once, straight to where they'll be at
    // the end, gliding there alongside the panel (no reflow on every frame).
    const app = document.getElementById('app');
    if (app) {
      const sliding = (e) => e.target === app && e.propertyName === 'grid-template-columns';
      let safety = 0;
      const stop = (e) => {
        if ((e && !sliding(e)) || !this.sliding) return;
        clearTimeout(safety);
        this.sliding = false;
        this.forcedWidth = null;
        this.layout();
      };
      app.addEventListener(
        'transitionrun',
        (e) => {
          if (!sliding(e)) return;
          clearTimeout(safety);
          safety = setTimeout(() => stop(null), 700); // in case no end event comes
          const target = this.#widthAfterSlide(app);
          this.sliding = true;
          if (target && this.rowCount != null) this.#glideTo(target);
        },
        { signal },
      );
      app.addEventListener('transitionend', stop, { signal });
      app.addEventListener('transitioncancel', stop, { signal });
    }

    this.layer.addEventListener('click', (e) => this.#click(e));
    // Hovering an artist or genre: read its folder (pictures, information)
    // already, so its page opens with its header straight away.
    let hoverTimer = 0;
    this.layer.addEventListener('pointerover', (e) => {
      if (this.kind !== 'artists' && this.kind !== 'genres') return;
      const i = this.#indexOf(e);
      clearTimeout(hoverTimer);
      if (i < 0) return;
      hoverTimer = setTimeout(() => {
        const g = view.groups[i];
        if (g) (this.kind === 'artists' ? this.hero : this.genreHero).warm(g.key, g.head?.handle);
      }, 120);
    });
    this.layer.addEventListener('dblclick', (e) => this.#dblclick(e));
    this.layer.addEventListener('contextmenu', (e) => this.#context(e));
    this.layer.addEventListener('keydown', (e) => this.#key(e));
    draggableRows(this.layer, (e) => {
      const i = this.#indexOf(e);
      return i < 0 ? null : view.groupRows(view.groups[i]);
    });
  }

  destroy() {
    this.ac.abort();
    this.ro.disconnect();
    clearTimeout(this.warmTimer);
    this.hero.destroy();
    this.genreHero.destroy();
    this.shelves.destroy();
    this.panel.destroy();
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
      // (Two tiles with one key: keep one; a node dropped here would stay on
      // screen, stuck, over every later page.)
      if (kind === this.kind && node.dataset.key != null && !this.stale.has(node.dataset.key)) this.stale.set(node.dataset.key, node);
      else this.#recycle(node);
    }
    this.kind = kind;
    this.tiles.clear();
    this.#showHero();
    this.shelves.update();
    // The open album stays open by key (a re-sort moves it to another index),
    // and where it was on screen.
    const openOffset = keepScroll && this.expanded >= 0 && this.rowCount != null ? this.rowTop(this.expandedRow) - this.scroller.scrollTop : null;
    this.expanded = this.expanded >= 0 && this.expandedKey != null ? view.groups.findIndex((g) => g.key === this.expandedKey) : -1;
    if (!keepScroll) {
      this.expanded = -1;
      this.scroller.scrollTop = 0;
    }
    this.panel.close(true);
    if (this.expanded >= 0) this.panel.open(view.groups[this.expanded], this.expanded);
    this.layout();
    if (openOffset != null && this.expanded >= 0) {
      this.scroller.scrollTop = Math.max(0, this.rowTop(this.expandedRow) - openOffset);
      this.render();
    }
  }

  layout() {
    // Mid-slide the layout is already the end one (see #glideTo).
    if (this.sliding && this.forcedWidth == null && this.rowCount != null) return;
    const w = this.forcedWidth ?? this.scroller.clientWidth;
    if (!w) return;
    // Keep the open album (or the first visible tile) where it was on screen
    // while the columns reflow, instead of jumping to wherever its row lands.
    const hadLayout = this.rowCount != null && this.lastWidth;
    let anchor = -1;
    let anchorOffset = 0;
    if (hadLayout) {
      anchor = this.expanded >= 0 ? this.expanded : Math.max(0, Math.floor((this.scroller.scrollTop - this.top) / this.tileH)) * this.cols;
      anchorOffset = this.rowTop(Math.floor(anchor / this.cols)) - this.scroller.scrollTop;
    }
    this.lastWidth = w;
    const round = this.kind === 'artists';
    const wide = false; // genre tiles were 2:1 once; square reads better
    const min = round ? store.get('artistTileSize') : store.get('tileSize');
    const inner = w - MARGIN * 2;
    this.cols = Math.max(1, Math.floor(inner / (min + PAD * 2)));
    this.tileW = Math.floor(inner / this.cols);
    const art = this.tileW - PAD * 2;
    const artH = wide ? Math.round(art / 2) : art;
    this.tileH = artH + PAD + (round ? 58 : 54);
    this.artSize = art;
    this.artH = artH;
    this.layer.style.setProperty('--tile-w', this.tileW + 'px');
    this.layer.style.setProperty('--art', art + 'px');
    this.layer.style.setProperty('--art-h', artH + 'px');
    this.shelves?.layout(true); // may move this.top (the albums start below the shelves)
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

  /** The grid's width once the side panels finish sliding: the content
   *  column's end width (the panels' widths are set at once; only the
   *  columns animate), less what the grid's own box takes off it. */
  #widthAfterSlide(app) {
    let col = this.scroller;
    while (col.parentElement && col.parentElement !== app) col = col.parentElement;
    if (col.parentElement !== app) return 0;
    const css = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const px = (v) => parseFloat(v) || 0;
    const side = document.body.classList.contains('no-sidebar') ? 0 : px(css.getPropertyValue('--sidebar-w'));
    const info = px(body.getPropertyValue('--info-w'));
    const end = app.clientWidth - side - info;
    return Math.max(0, this.scroller.clientWidth + (end - col.getBoundingClientRect().width));
  }

  /** Lay out for this width now, tiles gliding from where they are on screen
   *  to their new places (new ones fade in), as long as the panel's slide. */
  #glideTo(width = null) {
    const l0 = this.layer.getBoundingClientRect();
    const before = new Map();
    for (const [i, node] of this.tiles) {
      const r = node.getBoundingClientRect();
      before.set(node, { i, x: r.left - l0.left, y: r.top - l0.top });
    }
    this.forcedWidth = width;
    this.layout();
    if (width == null) this.forcedWidth = null;
    if (store.get('animations') === false) return;
    const l1 = this.layer.getBoundingClientRect();
    for (const [i, node] of this.tiles) {
      for (const a of node.getAnimations()) a.cancel();
      const was = before.get(node);
      if (was && was.i === i) {
        const x = was.x + l0.left - l1.left;
        const y = was.y + l0.top - l1.top;
        if (Math.abs(x - this.#x(node)) < 1 && Math.abs(y - this.#y(node)) < 1) continue;
        node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: node.style.transform }], { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
      } else node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    }
  }

  #x(node) {
    return Number(/translate\(([-\d.]+)px/.exec(node.style.transform)?.[1] || 0);
  }

  #y(node) {
    return Number(/translate\([-\d.]+px, ([-\d.]+)px/.exec(node.style.transform)?.[1] || 0);
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
    this.sizer.style.height = this.top - 16 + this.rowCount * this.tileH + extra + 60 + 'px';
  }

  rowTop(row) {
    const er = this.expandedRow;
    return this.top + row * this.tileH + (er >= 0 && row > er ? this.panelSpace : 0);
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
      if (er >= 0 && y > this.top + (er + 1) * this.tileH) y = Math.max(this.top + (er + 1) * this.tileH, y - ph);
      return Math.floor((y - this.top) / this.tileH);
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
    this.#sweep();
  }

  /** Hide any tile node that no group is using (belt and braces against
   *  tiles left behind on screen). */
  #sweep() {
    const used = new Set(this.tiles.values());
    for (const node of this.layer.children) {
      if (!node.classList.contains('tile') || node.hidden || used.has(node)) continue;
      this.#recycle(node);
    }
  }

  /** The artist's or genre's header on their page (hide one before showing
   *  the other: hiding puts the albums back at the top). */
  #showHero() {
    const kind = view.drill?.kind;
    let shown;
    if (kind === 'genres') {
      this.hero.show(null);
      shown = this.genreHero.show(view.drill.key);
    } else {
      this.genreHero.show(null);
      shown = this.hero.show(kind === 'artists' ? view.drill.key : null, this.#artistTrack());
    }
    // A new artist's or genre's page: its albums appear with its header, not
    // under the previous one's for a moment (at most a short wait).
    const page = view.drill ? `${view.drill.kind}|${view.drill.key}` : '';
    if (page && page !== this.heroPage && view.groups.length) {
      this.heroPage = page;
      this.layer.classList.add('await-hero');
      Promise.race([shown, new Promise((r) => setTimeout(r, 200))]).finally(() => this.heroPage === page && this.layer.classList.remove('await-hero'));
    } else if (!page) {
      this.heroPage = '';
      this.layer.classList.remove('await-hero');
    }
  }

  /** On an artist's page: a track from an album in the artist's own folder
   *  (not a guest spot on someone else's album), for Kodi's folder fallback. */
  #artistTrack() {
    const name = view.drill?.key;
    const handles = view.groups.map((g) => g.head?.handle).filter(Boolean);
    return handles.find((h) => musicArtistFolder(name, h)) || handles[0] || null;
  }

  /** Art to try for a tile, in order. */
  #types(g) {
    // Artists: their picture, foobar2000's artist art, then (unless that's
    // turned off) one of their album covers.
    if (this.kind === 'artists') return store.get('artistNoPicture') === 'placeholder' ? [`info:${g.key}`, 'artist'] : [`info:${g.key}`, 'artist', 'front'];
    if (this.kind === 'albums') return albumArtTypes(store.get('separateDiscs'));
    return ['front'];
  }

  /** Get every cover of this list ready in the background (disk cache). */
  #warm() {
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      if (!this.artSize || this.kind === 'genres') return;
      for (const g of view.groups) if (g.head?.handle) warmArt([g.head.handle], this.artSize, this.#types(g));
    }, 300);
  }

  /** Text/art arrived for groups [from, to). */
  refreshHeads() {
    this.#warm();
    this.shelves.refreshHeads();
    if (view.drill) this.#showHero();
    for (const [i, node] of this.tiles) this.#fill(node, i);
    if (this.expanded >= 0) this.panel.refreshHead(view.groups[this.expanded]);
  }

  /** Tags changed: re-read the open album's songs. */
  refreshTracks() {
    if (this.expanded >= 0) this.panel.reload();
  }

  /** Where the albums start with no artist or genre header: below the shelves. */
  restTop() {
    return this.shelves?.shown ? this.shelves.height : 16;
  }

  refreshPlaying() {
    this.shelves.refreshPlaying();
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
    if (!this.free.includes(node)) this.free.push(node);
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
      // Original / English / romanised: the lead version as the title, the
      // other at the start of the second line ("狂言 · Ado").
      const pick = pickVersion(head?.versions?.album, 'albums');
      const who = versionText(head?.artist || artist, head?.versions?.albumArtist, 'artists');
      setTitle(t1, pick ? pick.lead + (head.albumSuffix || '') : head?.title || album);
      const year = store.get('showAlbumYear') && head?.year ? ` · ${head.year}` : '';
      t2.textContent = (pick?.other ? `${pick.other} · ` : '') + who + year + (store.get('showTrackCounts') ? ` · ${plural(g.count, 'song')}` : '');
      art.classList.add('ph-album');
      node.title = `${t1.textContent}\n${who}` + (pick?.tip ? `\n\n${pick.tip}` : '');
    } else if (this.kind === 'artists') {
      const albums = plural(g.albumCount || g.sub?.length || 1, 'album');
      t1.textContent = g.key;
      t2.textContent = albums;
      art.classList.add('round', 'ph-artist');
      // Each artist's own colour, so pictureless artists don't all look alike.
      art.style.setProperty('--ph-hue', hueOf(g.key));
      node.title = g.key;
      // English / romanised names from the artist's artist.nfo, when it has them.
      artistNameVersions(g.key, head?.handle).then((v) => {
        const pick = pickVersion(v, 'artists');
        if (!pick || node.dataset.key !== g.key) return;
        t1.textContent = pick.lead;
        t2.textContent = (pick.other ? `${pick.other} · ` : '') + albums;
        node.title = pick.tip || g.key;
      });
    } else {
      const albums = plural(g.albumCount || g.sub?.length || 1, 'album');
      t1.textContent = g.key;
      t2.textContent = albums;
      art.classList.add('ph-genre');
      node.title = `${g.key}\n${albums}`;
      this.#genreArt(node, g, sameAlbum);
      return;
    }
    art.dataset.label = '';
    if (head?.handle) bindArt(img, head.handle, this.artSize, this.#types(g));
    else if (!sameAlbum) {
      delete img.dataset.artToken;
      img.removeAttribute('src');
      img.classList.remove('loaded');
    }
  }

  /** A genre's own picture, else a collage of its biggest albums, else a plain
   *  tile with its name. */
  async #genreArt(node, g, same) {
    const art = node.querySelector('.art');
    const img = art.querySelector('img');
    const w = this.artSize;
    const h = this.artH;
    const token = `genre|${g.key}|${w}x${h}`;
    if (img.dataset.artToken === token) return;
    img.dataset.artToken = token;
    if (!same) {
      img.removeAttribute('src');
      img.classList.remove('loaded');
    }
    art.dataset.label = '';
    const live = () => img.dataset.artToken === token;
    // Drawn before (another tab, a re-sort): straight back, no fade.
    const known = genreTiles.get(token);
    if (known !== undefined) {
      if (known) {
        img.classList.add('instant', 'loaded');
        // Seen before: paint it with the tile (the tile waits for the picture
        // rather than showing an empty frame first).
        img.decoding = 'sync';
        img.src = known;
        // Not decoded yet after all: no coloured placeholder meanwhile.
        if (!img.complete) {
          art.classList.add('decoding');
          img.decode().catch(() => {}).finally(() => art.classList.remove('decoding'));
        }
      } else art.dataset.label = g.key;
      return;
    }
    img.classList.remove('instant');
    img.decoding = 'async';
    let url = null;
    const files = await genreFiles(g.key);
    if (!live()) return;
    if (files?.picture) url = await genrePictureUrl(files.picture, Math.max(w, h) * (window.devicePixelRatio || 1));
    if (!url && g.collageRows?.length) {
      const tracks = await view.tracks(g.collageRows);
      if (!live()) return;
      const handles = tracks.map((t) => t?.handle).filter(Boolean);
      url = await collageUrl(handles, w, h);
    }
    if (!live()) return;
    genreTiles.set(token, url);
    // Decoded and kept: a new grid (coming back from Songs or Folders) shows
    // it the same frame, not the placeholder first.
    holdDecoded(url);
    if (!url) {
      img.removeAttribute('src');
      img.classList.remove('loaded');
      art.dataset.label = g.key;
      return;
    }
    img.onload = () => live() && img.classList.add('loaded');
    img.onerror = () => {
      if (live()) art.dataset.label = g.key;
    };
    img.src = url;
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
    const g = view.groups[i];
    const rows = view.groupRows(g);
    // The tile keeps its hover look while the menu is open (the menu takes
    // the mouse), and the album's songs aren't selected.
    const tile = e.target.closest('.tile');
    tile?.classList.add('menu-open');
    Promise.resolve(trackContextMenu(rows, this.#refreshItems(g, rows), { select: false })).finally(() => tile?.classList.remove('menu-open'));
  }

  /** "Refresh artwork" for an album or genre; artist information for an artist. */
  #refreshItems(g, rows) {
    if (this.kind === 'artists') {
      return [
        { label: 'Edit artist information…', run: () => editArtist(g.key, g.head?.handle) },
        // The artist's own folder, and their albums' tags and covers too.
        { label: 'Refresh artist information', run: async () => (refreshArtist(g.key, [g.head?.handle, ...(await handlesOf(rows, 50))].filter(Boolean)), refreshAlbums(rows)) },
      ];
    }
    if (this.kind === 'genres') return [{ label: 'Edit genre information…', run: () => editGenre(g.key) }, { label: 'Refresh genre information', run: () => (forgetGenreInfo(), refreshAlbums(rows)) }];
    return [{ label: 'Refresh album information', run: () => refreshAlbums(rows) }];
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

  /** Open the album with this key (if it's in the list). `jump`: already
   *  open, at the top of the page, with no animation or scrolling. */
  expandKey(key, { jump = false } = {}) {
    const lower = (key || '').toLowerCase();
    const i = view.groups.findIndex((g) => g.key === key || g.key.toLowerCase() === lower);
    if (i < 0) return false;
    if (jump) {
      this.expanded = i;
      this.expandedKey = view.groups[i].key;
      this.panel.open(view.groups[i], i);
      this.#updateHeight();
      for (const [j, node] of this.tiles) this.#place(node, j);
      this.scroller.scrollTop = Math.max(0, this.rowTop(this.expandedRow) - 8);
      this.render();
      for (const [j, node] of this.tiles) node.classList.toggle('expanded', j === i);
      return true;
    }
    if (this.expanded !== i) this.toggle(i);
    return true;
  }

  toggle(i) {
    if (this.expanded === i) {
      this.collapse();
      return;
    }
    const prevRow = this.expandedRow;
    const wasOpen = this.expanded >= 0;
    this.expanded = i;
    this.expandedKey = view.groups[i].key;
    this.layer.classList.toggle('shift', wasOpen && prevRow === this.expandedRow);
    this.panel.open(view.groups[i], i);
    this.#relayoutTiles();
    // The songs arrive a moment later and make the panel taller: show it
    // again then (unless the user has scrolled meanwhile).
    this.revealUntil = performance.now() + 2000;
    this.#reveal();
  }

  /** The open album list changed height (disc picked, tracks loaded). */
  relayout() {
    if (this.expanded < 0) return;
    this.#relayoutTiles();
    if (performance.now() < (this.revealUntil || 0)) this.#reveal();
  }

  collapse() {
    if (this.expanded < 0) return;
    this.expanded = -1;
    this.expandedKey = null;
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
    // Taller than the window: its row of tiles at the top, the rest album.
    if (bottom - top > viewH) target = Math.abs(viewTop - (top - 8)) > 2 ? top : null;
    else if (bottom > viewTop + viewH) target = Math.min(top, bottom - viewH);
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

/** A hue for a name. The hash is mixed first: its low bits alone bunch similar names together. */
function hueOf(name) {
  let h = hash(name.toLowerCase());
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % 360;
}
