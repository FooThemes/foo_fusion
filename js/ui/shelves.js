// Home shelves: rows of albums above the Collection's album grid —
// recently added, recently played, not heard in a while… Each can be turned
// off and they can be put in any order (Settings > Albums).
//
// Worked out from the Collection itself (the play statistics of every song,
// read once and kept), not from extra playlists: autoplaylists would show up
// in foobar2000's own playlist list and be re-run on every library change.
// Play counts and dates come from foo_playcount, or Playcount 2003 when only
// that is installed; without either, only "Random picks" has anything to show.

import { el, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt, albumArtTypes } from '../data/artwork.js';
import { pickVersion } from '../data/versions.js';
import { setTitle, versionText } from './titles.js';
import { listening, listeningData, knownData } from '../data/listening.js';
import { trackContextMenu } from './menus.js';
import { TrackPanel } from './trackpanel.js';

export const SHELVES = {
  added: { label: 'Recently added', hint: 'Newest in your library first' },
  played: { label: 'Recently played', hint: 'Albums you played from lately' },
  forgotten: { label: 'Haven’t heard in a while', hint: 'Albums you played a lot, not in the last six months' },
  most: { label: 'Most played', hint: 'Every play of every song, added up' },
  unplayed: { label: 'Never played', hint: 'Newest first' },
  random: { label: 'Random picks', hint: 'A new set each day' },
};
const PER_SHELF = 24;
const FORGOTTEN_DAYS = 182;
const GAP = 16;

let reroll = 0; // "Random picks" picked again this many times
// The shelves stay drawn between visits (a new grid takes them over), so
// coming back to the Collection shows them, covers and all, at once.
let kept = null; // { node, sig }

/** foobar2000 date text for `days` ago ("2026-05-01 12:00:00"), comparable as text. */
function daysAgo(days) {
  const d = new Date(Date.now() - days * 864e5);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Each album's added date, last play and plays, from every song's statistics
// (data/listening.js, shared with Listening stats and kept on disk).
let memo = { tracks: null, key: '', stats: null };
function statsFrom(tracks) {
  const key = `${view.groups.length}|${store.get('separateDiscs')}|${view.playlist?.guid}`;
  if (memo.tracks === tracks && memo.key === key) return memo.stats;
  const disc = !!store.get('separateDiscs');
  const byKey = new Map();
  for (const t of tracks) {
    const k = disc ? t.discKey : t.albumKey;
    const g = byKey.get(k) || { added: '', last: '', plays: 0, songs: 0 };
    if (t.added > g.added) g.added = t.added;
    if (t.last > g.last) g.last = t.last;
    g.plays += t.plays;
    g.songs++;
    byKey.set(k, g);
  }
  const stats = { groups: view.groups.map((g) => byKey.get(g.key) || { added: '', last: '', plays: 0, songs: 0 }) };
  memo = { tracks, key, stats };
  return stats;
}

/** The statistics already read (no waiting), or null. */
function cachedStats() {
  const tracks = view.playlist && knownData(view.playlist);
  return tracks ? statsFrom(tracks) : null;
}

async function readStats() {
  const tracks = await listeningData(view.playlist);
  return tracks ? statsFrom(tracks) : null;
}

/** Group indexes for a shelf, best first. */
function pick(id, s) {
  const all = s.groups.map((g, i) => ({ ...g, i }));
  const top = (list, by) => list.sort(by).slice(0, PER_SHELF).map((g) => g.i);
  switch (id) {
    case 'added':
      return top(all.filter((g) => g.added), (a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));
    case 'played':
      return top(all.filter((g) => g.last), (a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
    case 'forgotten': {
      const cut = daysAgo(FORGOTTEN_DAYS);
      // "A lot": at least a play for every other song, and 3 in all.
      return top(all.filter((g) => g.last && g.last < cut && g.plays >= Math.max(3, Math.ceil(g.songs / 2))), (a, b) => b.plays - a.plays);
    }
    case 'most':
      return top(all.filter((g) => g.plays > 0), (a, b) => b.plays - a.plays);
    case 'unplayed':
      return top(all.filter((g) => !g.plays && !g.last), (a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));
    case 'random': {
      // The same picks all day (seeded by the date), new ones tomorrow, or
      // whenever the shelf's "pick again" button is pressed.
      let seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, '')) + reroll * 7919;
      const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0) >>> 0) / 4294967296;
      const order = all.map((g) => [rnd(), g.i]).sort((a, b) => a[0] - b[0]);
      return order.slice(0, PER_SHELF).map(([, i]) => i);
    }
  }
  return [];
}

export class Shelves {
  constructor(grid, parent) {
    this.grid = grid;
    this.ac = new AbortController();
    const signal = this.ac.signal;
    this.node = kept?.node || el('div.shelves', { hidden: true });
    this.sig = kept?.sig || '';
    this.shown = !!kept && !this.node.hidden;
    parent.append(this.node);
    // An album opened from a shelf opens there, under its shelf.
    this.panelHost = this.#panelHost();
    this.panel = new TrackPanel(this.panelHost);
    this.panelBox = el('div.shelf-panel');
    this.panelBox.append(this.panel.node);
    this.openKey = null;
    this.node.addEventListener('click', (e) => this.#click(e), { signal });
    this.node.addEventListener(
      'dblclick',
      (e) => {
        const g = this.#group(e);
        if (g && !e.target.closest('.tile-play')) view.playGroup(g);
      },
      { signal },
    );
    this.node.addEventListener(
      'contextmenu',
      (e) => {
        const g = this.#group(e);
        if (!g) return;
        e.preventDefault();
        const tile = e.target.closest('.shelf-tile');
        tile.classList.add('menu-open');
        Promise.resolve(trackContextMenu(view.groupRows(g), [], { select: false })).finally(() => tile.classList.remove('menu-open'));
      },
      { signal },
    );
    this.offStore = store.subscribe((k) => {
      if (k === 'shelves' || k === 'homeShelves') this.update(true);
    });
    // Songs played (or new ones read): "Recently played" and the rest move.
    this.offListening = listening.on('change', () => this.update());
  }

  destroy() {
    this.offStore();
    this.offListening();
    this.ac.abort();
    this.#closePanel(false);
    this.panel.destroy();
    this.panelBox.remove();
    kept = this.shown ? { node: this.node, sig: this.sig } : null;
    this.node.remove();
  }

  /** Is this where shelves go (the whole Collection's Albums tab)? */
  #wanted() {
    return store.get('homeShelves') !== false && this.grid.kind === 'albums' && view.isFullCollection && view.groups.length > PER_SHELF;
  }

  /** The list changed (or a setting): show, refresh or hide the shelves. */
  update(force = false) {
    if (!this.#wanted()) {
      // Still loading the Collection: keep what's there rather than flash.
      if (this.shown && view.loading && view.isFullCollection) return;
      return this.#hide();
    }
    const order = (store.get('shelves') || []).filter(([id, on]) => on && SHELVES[id]).map(([id]) => id);
    if (!order.length) return this.#hide();
    const apply = (s) => {
      if (!s || !this.#wanted()) return;
      const shelves = order.map((id) => ({ id, items: pick(id, s) })).filter((x) => x.items.length);
      const sig = shelves.map((x) => `${x.id}:${x.items.map((i) => view.groups[i].key).join(',')}`).join('/');
      if (!force && sig === this.sig && this.shown) {
        this.shelves = shelves;
        this.refreshHeads();
        return this.layout();
      }
      this.sig = sig;
      this.shelves = shelves;
      this.#draw();
    };
    // Read before: drawn now, before the grid's first frame (no pop-in).
    const now = cachedStats();
    if (now) apply(now);
    else readStats().then(apply);
  }

  #draw() {
    const openKey = this.openKey;
    this.#closePanel(false);
    const rows = this.shelves.map(({ id, items }) => {
      const row = el('div.shelf-row', null, ...items.map((i) => this.#tile(i)));
      const scroll = (dir) => row.scrollBy({ left: dir * Math.max(this.grid.tileW, row.clientWidth - this.grid.tileW), behavior: store.get('smoothScroll') ? 'smooth' : 'auto' });
      const prev = el('button.btn-icon.shelf-arrow', { title: 'Back', onclick: () => scroll(-1) }, icon('back'));
      const next = el('button.btn-icon.shelf-arrow', { title: 'More', onclick: () => scroll(1) }, icon('forward'));
      const ends = () => {
        prev.disabled = row.scrollLeft < 4;
        next.disabled = row.scrollLeft + row.clientWidth > row.scrollWidth - 4;
      };
      row.addEventListener('scroll', ends, { passive: true });
      requestAnimationFrame(ends);
      const tools = [];
      if (id === 'random') tools.push(el('button.btn-icon.shelf-arrow', { title: 'Pick again', onclick: () => this.#reroll() }, icon('refresh')));
      return el('section.shelf', { dataset: { shelf: id } }, el('div.shelf-head', null, el('h3', { text: SHELVES[id].label }), el('div.shelf-arrows', null, ...tools, prev, next)), row);
    });
    this.node.replaceChildren(el('div.shelves-band', null, ...rows), el('h3.shelf-all', { text: 'All albums' }));
    this.node.hidden = false;
    this.shown = true;
    if (openKey) {
      const tile = this.node.querySelector(`.shelf-tile[data-key="${CSS.escape(openKey)}"]`);
      if (tile) this.#openPanel(tile);
    }
    this.layout();
  }

  #reroll() {
    reroll++;
    const s = cachedStats();
    const shelf = this.shelves?.find((x) => x.id === 'random');
    if (!s || !shelf) return;
    shelf.items = pick('random', s);
    this.sig = '';
    this.#draw();
  }

  #tile(i) {
    const g = view.groups[i];
    const img = el('img', { alt: '', decoding: 'async', draggable: false });
    const node = el(
      'div.tile.shelf-tile',
      { tabindex: 0, role: 'button', dataset: { key: g.key } },
      el('div.art.ph-album', null, img, el('button.tile-play', { title: 'Play', tabindex: -1 }, icon('play'))),
      el('div.tile-t1.ellipsis'),
      el('div.tile-t2.ellipsis'),
    );
    this.#fill(node, g);
    return node;
  }

  #fill(node, g) {
    const head = g.head;
    const [t1, t2] = node.querySelectorAll('.tile-t1, .tile-t2');
    const [artist, album] = [g.key.split('|')[0] || '', g.key.split('|')[1] || ''];
    const pv = pickVersion(head?.versions?.album, 'albums');
    const who = versionText(head?.artist || artist, head?.versions?.albumArtist, 'artists');
    setTitle(t1, pv ? pv.lead + (head.albumSuffix || '') : head?.title || album);
    t2.textContent = (pv?.other ? `${pv.other} · ` : '') + who;
    node.title = `${t1.textContent}\n${who}\n${plural(g.count ?? view.groupRows(g).length, 'song')}`;
    const img = node.querySelector('img');
    if (head?.handle && img.dataset.handle !== head.handle) {
      img.dataset.handle = head.handle;
      bindArt(img, head.handle, this.grid.artSize, albumArtTypes(store.get('separateDiscs')));
    }
  }

  /** Album text and covers arrived: fill in tiles still waiting for them. */
  refreshHeads() {
    if (!this.shown) return;
    for (const node of this.node.querySelectorAll('.shelf-tile')) {
      const g = view.groups.find((x) => x.key === node.dataset.key);
      if (g) this.#fill(node, g);
    }
  }

  refreshPlaying() {
    if (!this.shown) return;
    if (this.openKey) this.panel.refreshPlaying();
    const r = player.playingPlaylist === view.playlist?.index ? player.playingIndex : -1;
    for (const node of this.node.querySelectorAll('.shelf-tile')) {
      const g = view.groups.find((x) => x.key === node.dataset.key);
      node.classList.toggle('playing', !!g && r >= 0 && view.groupRows(g).includes(r));
    }
  }

  refreshSelection() {
    if (this.openKey) this.panel.refreshSelection();
  }

  /** Tile sizes follow the grid's; the albums start below the shelves. */
  layout(fromGrid = false) {
    if (!this.shown || !this.grid.tileW) return;
    this.node.style.setProperty('--tile-w', this.grid.tileW + 'px');
    this.node.style.setProperty('--art', this.grid.artSize + 'px');
    if (this.openKey) {
      this.panel.layout(this.grid.scroller.clientWidth);
      this.#sizeBox(this.panel.height);
    }
    // While the open album slides, the albums below go straight to where
    // they'll be (gliding there with it), not to where the slide is now.
    const sliding = this.panelBox.isConnected ? (this.boxTarget ?? 0) - this.panelBox.offsetHeight : 0;
    const top = this.node.offsetHeight + sliding + GAP;
    if (top === this.grid.top) return;
    this.grid.top = top;
    if (!fromGrid) this.grid.layout();
  }

  /** Where the albums start when no shelves (or header) are above them. */
  get height() {
    return this.shown ? this.node.offsetHeight + GAP : 0;
  }

  #hide() {
    if (!this.shown) return;
    this.#closePanel(false);
    this.shown = false;
    this.sig = '';
    this.node.hidden = true;
    this.node.replaceChildren();
    if (this.grid.top !== 16) {
      this.grid.top = 16;
      this.grid.layout();
    }
  }

  #group(e) {
    const tile = e.target.closest('.shelf-tile');
    return tile ? view.groups.find((g) => g.key === tile.dataset.key) : null;
  }

  /** A shelf album: open (or close) it under its shelf, or play it. */
  #click(e) {
    const g = this.#group(e);
    if (!g) return;
    if (e.target.closest('.tile-play')) return view.playGroup(g);
    const tile = e.target.closest('.shelf-tile');
    if (this.openTile === tile) return this.#closePanel();
    this.#openPanel(tile);
  }

  /** What the album panel needs from a "grid": here, one row (the shelf's)
   *  with the pointer under the clicked tile wherever it has scrolled to. */
  #panelHost() {
    const self = this;
    return {
      cols: 1,
      tileH: 0,
      rowTop: () => 0,
      get tileW() {
        // The panel puts its pointer at 40 + tileW / 2: aim it at the tile.
        const t = self.openTile;
        if (!t) return 0;
        const x = t.getBoundingClientRect().left + t.offsetWidth / 2 - self.node.getBoundingClientRect().left;
        return Math.max(0, (x - 40) * 2);
      },
      relayout: () => self.#panelResized(),
      collapse: () => self.#closePanel(),
    };
  }

  #openPanel(tile) {
    const g = view.groups.find((x) => x.key === tile.dataset.key);
    if (!g) return;
    this.grid.collapse(); // one open album at a time
    this.openTile?.classList.remove('expanded');
    this.openTile = tile;
    this.openKey = g.key;
    tile.classList.add('expanded');
    const shelf = tile.closest('.shelf');
    clearTimeout(this.closeTimer);
    if (this.panelBox.previousElementSibling !== shelf) {
      // Starts shut, under its shelf, and slides open.
      this.panelBox.style.height = '0px';
      this.boxTarget = 0;
      shelf.after(this.panelBox);
      void this.panelBox.offsetHeight;
    }
    this.panel.layout(this.grid.scroller.clientWidth);
    this.panel.open(g, 0);
    this.#panelResized();
    // Keep the pointer under the tile as the shelf scrolls sideways.
    const row = tile.parentElement;
    this.offRowScroll?.();
    const follow = () => this.panel.layout(this.grid.scroller.clientWidth);
    row.addEventListener('scroll', follow, { passive: true });
    this.offRowScroll = () => row.removeEventListener('scroll', follow);
  }

  /** Close an album opened from a shelf (the grid is opening one). */
  closeAlbum() {
    this.#closePanel();
  }

  #closePanel(relayout = true) {
    if (!this.openKey) return;
    this.openKey = null;
    this.openTile?.classList.remove('expanded');
    this.openTile = null;
    this.offRowScroll?.();
    const box = this.panelBox;
    const panel = this.panel;
    if (!relayout || !box.isConnected) {
      panel.close();
      box.remove();
      this.boxTarget = 0;
      return;
    }
    // Slides shut (as the grid's own album list does), then goes.
    this.#sizeBox(0);
    this.layout();
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      if (this.openKey) return; // opened again meanwhile
      panel.close();
      box.remove();
      this.layout();
    }, 240);
  }

  /** The open album's space: animated, with the albums below gliding along. */
  #sizeBox(h) {
    if (this.boxTarget === h) return;
    this.boxTarget = h;
    this.panelBox.classList.add('sliding');
    this.panelBox.style.height = h + 'px';
    this.grid.layer.classList.add('animating');
    clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(() => {
      this.panelBox.classList.remove('sliding');
      this.grid.layer.classList.remove('animating');
    }, 260);
  }

  /** The open album changed height (songs arrived, a disc picked). */
  #panelResized() {
    if (!this.openKey) return;
    this.#sizeBox(this.panel.height);
    this.layout();
    // Show it all, if it isn't (the songs arrive a moment after opening).
    const sc = this.grid.scroller;
    const box = this.panelBox.getBoundingClientRect();
    const view_ = sc.getBoundingClientRect();
    if (box.bottom > view_.bottom) sc.scrollBy({ top: Math.min(box.bottom - view_.bottom + 16, box.top - view_.top - 120), behavior: store.get('smoothScroll') ? 'smooth' : 'auto' });
  }
}

