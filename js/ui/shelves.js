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
import { tryCall } from '../core/bridge.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt, albumArtTypes } from '../data/artwork.js';
import { pickVersion } from '../data/versions.js';
import { setTitle, versionText } from './titles.js';
import { TF } from '../data/patterns.js';
import { trackContextMenu } from './menus.js';

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

let stats = null; // { key, groups: [{ added, last, plays }] }
let statsPromise = null;
let staleAt = 0; // a song started since the statistics were read

player.on?.('track', () => (staleAt = Date.now()));

/** foobar2000 date text for `days` ago ("2026-05-01 12:00:00"), comparable as text. */
function daysAgo(days) {
  const d = new Date(Date.now() - days * 864e5);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Added date, last played and play count of each album, from every song. */
async function readStats() {
  const pl = view.playlist;
  const groups = view.groups;
  const key = `${pl.guid}|${pl.trackCount}|${groups.length}|${store.get('separateDiscs')}`;
  if (stats?.key === key && !(staleAt > stats.at && Date.now() - stats.at > 30000)) return stats;
  if (statsPromise?.key === key) return statsPromise.promise;
  const promise = (async () => {
    const rowGroup = new Int32Array(pl.trackCount).fill(-1);
    groups.forEach((g, i) => {
      for (const r of view.groupRows(g)) if (r < rowGroup.length) rowGroup[r] = i;
    });
    const out = groups.map(() => ({ added: '', last: '', plays: 0 }));
    const formats = { a: TF.addedAny, l: TF.lastPlayedAny, c: TF.playCountAny };
    for (let from = 0; from < pl.trackCount; from += 2000) {
      const rows = Array.from({ length: Math.min(2000, pl.trackCount - from) }, (_, i) => from + i);
      const res = await tryCall('playlist.getTracksAt', { playlist: pl.index, rows, fields: ['handle'], formats });
      if (!res || view.playlist?.guid !== pl.guid) return null;
      for (const t of res.tracks) {
        const g = out[rowGroup[t.index]];
        if (!g) continue;
        const f = t.formats || {};
        if (f.a > g.added) g.added = f.a;
        if (f.l > g.last) g.last = f.l;
        g.plays += parseInt(f.c, 10) || 0;
      }
    }
    stats = { key, at: Date.now(), groups: out };
    return stats;
  })().finally(() => (statsPromise = null));
  statsPromise = { key, promise };
  return promise;
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
      // "A lot": at least a play per song, and at least 3 in all.
      const len = (i) => view.groupRows(view.groups[i]).length;
      return top(all.filter((g) => g.last && g.last < cut && g.plays >= Math.max(3, len(g.i))), (a, b) => b.plays - a.plays);
    }
    case 'most':
      return top(all.filter((g) => g.plays > 0), (a, b) => b.plays - a.plays);
    case 'unplayed':
      return top(all.filter((g) => !g.plays && !g.last), (a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));
    case 'random': {
      // The same picks all day (seeded by the date), new ones tomorrow.
      let seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
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
    this.node = el('div.shelves', { hidden: true });
    parent.append(this.node);
    this.shown = false;
    this.sig = '';
    this.node.addEventListener('click', (e) => this.#click(e));
    this.node.addEventListener('dblclick', (e) => {
      const g = this.#group(e);
      if (g && !e.target.closest('.tile-play')) view.playGroup(g);
    });
    this.node.addEventListener('contextmenu', (e) => {
      const g = this.#group(e);
      if (!g) return;
      e.preventDefault();
      const tile = e.target.closest('.shelf-tile');
      tile.classList.add('menu-open');
      Promise.resolve(trackContextMenu(view.groupRows(g), [], { select: false })).finally(() => tile.classList.remove('menu-open'));
    });
    this.offStore = store.subscribe((k) => {
      if (k === 'shelves' || k === 'homeShelves') this.update(true);
    });
  }

  destroy() {
    this.offStore();
    this.node.remove();
  }

  /** Is this where shelves go (the whole Collection's Albums tab)? */
  #wanted() {
    return store.get('homeShelves') !== false && this.grid.kind === 'albums' && view.isFullCollection && view.groups.length > PER_SHELF;
  }

  /** The list changed (or a setting): show, refresh or hide the shelves. */
  async update(force = false) {
    if (!this.#wanted()) return this.#hide();
    const order = (store.get('shelves') || []).filter(([id, on]) => on && SHELVES[id]).map(([id]) => id);
    if (!order.length) return this.#hide();
    const s = await readStats();
    if (!s || !this.#wanted()) return;
    const shelves = order.map((id) => ({ id, items: pick(id, s) })).filter((x) => x.items.length);
    const sig = JSON.stringify(shelves) + '|' + view.groups.length;
    if (!force && sig === this.sig && this.shown) return this.refreshHeads();
    this.sig = sig;
    this.shelves = shelves;
    this.#draw();
  }

  #draw() {
    const rows = this.shelves.map(({ id, items }) => {
      const row = el('div.shelf-row', null, ...items.map((i) => this.#tile(i)));
      const scroll = (dir) => row.scrollBy({ left: dir * Math.max(this.grid.tileW, row.clientWidth - this.grid.tileW), behavior: store.get('smoothScroll') ? 'smooth' : 'auto' });
      const prev = el('button.btn-icon.shelf-arrow', { title: 'Back', onclick: () => scroll(-1) }, icon('back'));
      const next = el('button.btn-icon.shelf-arrow', { title: 'More', onclick: () => scroll(1) }, icon('chevronRight'));
      const ends = () => {
        prev.disabled = row.scrollLeft < 4;
        next.disabled = row.scrollLeft + row.clientWidth > row.scrollWidth - 4;
      };
      row.addEventListener('scroll', ends, { passive: true });
      requestAnimationFrame(ends);
      return el('section.shelf', { dataset: { shelf: id } }, el('div.shelf-head', null, el('h3', { text: SHELVES[id].label }), el('div.shelf-arrows', null, prev, next)), row);
    });
    this.node.replaceChildren(...rows, el('h3.shelf-all', { text: 'All albums' }));
    this.node.hidden = false;
    this.shown = true;
    this.layout();
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
    const r = player.playingPlaylist === view.playlist?.index ? player.playingIndex : -1;
    for (const node of this.node.querySelectorAll('.shelf-tile')) {
      const g = view.groups.find((x) => x.key === node.dataset.key);
      node.classList.toggle('playing', !!g && r >= 0 && view.groupRows(g).includes(r));
    }
  }

  /** Tile sizes follow the grid's; the albums start below the shelves. */
  layout(fromGrid = false) {
    if (!this.shown || !this.grid.tileW) return;
    this.node.style.setProperty('--tile-w', this.grid.tileW + 'px');
    this.node.style.setProperty('--art', this.grid.artSize + 'px');
    const top = this.node.offsetHeight + GAP;
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

  /** A shelf album: open it in the grid below (or play it). */
  #click(e) {
    const g = this.#group(e);
    if (!g) return;
    if (e.target.closest('.tile-play')) return view.playGroup(g);
    const i = view.groups.indexOf(g);
    if (i >= 0) this.grid.toggle(i);
  }
}

