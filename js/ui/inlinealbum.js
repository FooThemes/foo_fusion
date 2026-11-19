// An album opened in place, under the tile that was clicked, outside the
// Collection's own grid: the home shelves and Listening stats use it. It is
// the same album panel the grid opens (TrackPanel), in a box of its own that
// slides open and shut, with its pointer kept under the tile.
//
// The grid opens its albums itself (it lays its tiles out around the panel);
// everything else that opens an album in place uses this.

import { el } from '../core/util.js';
import * as store from '../core/store.js';
import { TrackPanel } from './trackpanel.js';

const SLIDE_MS = 260; // .inline-album height transition, plus a little

export class InlineAlbum {
  /**
   * @param {object} o
   * @param {HTMLElement} o.scroller  the scrolling page (to bring the album into view)
   * @param {string} [o.className]  extra class for the box
   * @param {() => void} [o.onSize]  the box's height is changing (lay out what's below)
   * @param {(on: boolean) => void} [o.onSlide]  a slide starts / ends
   */
  constructor({ scroller, className = '', onSize, onSlide }) {
    this.scroller = scroller;
    this.onSize = onSize;
    this.onSlide = onSlide;
    this.box = el('div.inline-album' + (className ? '.' + className : ''));
    this.panel = new TrackPanel(this.#host());
    this.box.append(this.panel.node);
    this.key = null;
    this.tile = null;
    this.target = 0;
  }

  get isOpen() {
    return !!this.key;
  }

  /**
   * How much taller the box is about to be than it is now (while it slides):
   * what's laid out below it can go straight to where it will end up.
   */
  get pending() {
    return this.box.isConnected ? this.target - this.box.offsetHeight : 0;
  }

  /** What the panel needs from a "grid": one row, its pointer under the tile. */
  #host() {
    const self = this;
    return {
      cols: 1,
      tileH: 0,
      rowTop: () => 0,
      tileW: 0,
      // The pointer goes under the middle of the clicked tile.
      tileCenterX: () => {
        const t = self.tile;
        if (!t?.isConnected) return 0;
        return Math.max(0, t.getBoundingClientRect().left + t.offsetWidth / 2 - self.box.getBoundingClientRect().left);
      },
      relayout: () => self.#resized(),
      collapse: () => self.close(),
    };
  }

  /** Open (or close, if it's the open one) the album of `tile`. */
  toggle(tile, group, after, opts) {
    if (this.tile === tile && this.key) return this.close();
    this.open(tile, group, after, opts);
  }

  /**
   * Open `group`'s album under `after` (an element the box goes after),
   * pointing at `tile`. `animate: false` opens it at full height at once
   * (the page was redrawn with it open).
   */
  open(tile, group, after, { animate = true } = {}) {
    this.tile?.classList.remove('expanded');
    this.tile = tile;
    this.key = group.key;
    tile.classList.add('expanded');
    clearTimeout(this.closeTimer);
    if (this.box.previousElementSibling !== after || !this.box.isConnected) {
      // Starts shut where it now goes, and slides open.
      this.box.style.height = '0px';
      this.target = 0;
      after.after(this.box);
      void this.box.offsetHeight;
    }
    this.panel.layout(this.box.clientWidth);
    this.panel.open(group, 0);
    this.#resized(animate);
    // Keep the pointer under the tile when its row scrolls sideways.
    this.offRowScroll?.();
    const row = tile.parentElement;
    const follow = () => this.panel.layout(this.box.clientWidth);
    row.addEventListener('scroll', follow, { passive: true });
    this.offRowScroll = () => row.removeEventListener('scroll', follow);
  }

  /** Close it: slides shut, then goes (`animate: false`: at once). */
  close({ animate = true } = {}) {
    if (!this.key) return;
    this.key = null;
    this.tile?.classList.remove('expanded');
    this.tile = null;
    this.offRowScroll?.();
    if (!animate || !this.box.isConnected) {
      this.panel.close();
      this.box.remove();
      this.target = 0;
      this.onSize?.();
      return;
    }
    this.#size(0);
    this.onSize?.();
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      if (this.key) return; // opened again meanwhile
      this.panel.close();
      this.box.remove();
      this.onSize?.();
    }, SLIDE_MS - 20);
  }

  /** The page's width changed. */
  layout() {
    if (!this.key) return;
    this.panel.layout(this.box.clientWidth);
    this.#size(this.panel.height);
  }

  refreshPlaying() {
    if (this.key) this.panel.refreshPlaying();
  }

  refreshSelection() {
    if (this.key) this.panel.refreshSelection();
  }

  refreshHead(group) {
    if (this.key) this.panel.refreshHead(group);
  }

  destroy() {
    this.close({ animate: false });
    clearTimeout(this.closeTimer);
    clearTimeout(this.slideTimer);
    this.panel.destroy();
  }

  /** The box's height, animated (the panel itself is laid out at full size). */
  #size(h, animate = true) {
    if (this.target === h) return;
    this.target = h;
    if (!animate) {
      this.box.style.height = h + 'px';
      return;
    }
    this.box.classList.add('sliding');
    this.box.style.height = h + 'px';
    this.onSlide?.(true);
    clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(() => {
      this.box.classList.remove('sliding');
      this.onSlide?.(false);
    }, SLIDE_MS);
  }

  /** The panel's height changed (songs arrived, a disc picked). */
  #resized(animate = true) {
    if (!this.key) return;
    this.#size(this.panel.height, animate);
    this.onSize?.();
    // Show it all, if it isn't (the songs arrive a moment after opening).
    if (!animate) return;
    const sc = this.scroller;
    const box = this.box.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    const bottom = box.top + this.target;
    if (bottom > view.bottom) sc.scrollBy({ top: Math.min(bottom - view.bottom + 16, box.top - view.top - 120), behavior: store.get('smoothScroll') ? 'smooth' : 'auto' });
  }
}
