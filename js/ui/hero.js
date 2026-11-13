// What an artist's and a genre's page header share (artisthero.js,
// genrehero.js): a picture beside the name, a line of details and a
// biography that folds at a few lines, over a backdrop picture; right-click
// for its menu. The grid's albums start below it.

import { el } from '../core/util.js';
import { showMenu } from './menus.js';
import { pictureUrl } from '../data/artistinfo.js';
import { valueLink } from './links.js';
import { smoothBackdrop } from './smoothbg.js';
import * as store from '../core/store.js';

const GAP = 24; // between the header and the first row of albums

export class Hero {
  /**
   * @param {object} grid
   * @param {object} o
   * @param {string} [o.className]  extra class for the header
   * @param {string} [o.pictureClass]  extra class for the picture's box
   * @param {Node[]} [o.above]  above the name (the artist's logo)
   * @param {Node[]} [o.details]  between the details line and the related names
   * @param {string} o.refreshEvent  window event that reads its files again
   */
  constructor(grid, { className = '', pictureClass = '', above = [], details = [], refreshEvent }) {
    this.grid = grid;
    this.name = null;
    this.expanded = false;
    this.fanart = el('img.ah-fanart', { alt: '' });
    this.picture = el('img', { alt: '' });
    this.pictureBox = el('div.ah-picture' + pictureClass, null, this.picture);
    this.title = el('h2.ah-name');
    this.meta = el('div.ah-meta');
    this.assoc = el('div.ah-assoc');
    this.bio = el('div.ah-bio');
    // Click anywhere on a cut-off biography to read it all (and again to fold it).
    this.bio.addEventListener('click', (e) => {
      if (e.target.closest('a, button') || getSelection()?.toString()) return;
      if (this.expanded || this.bio.classList.contains('clipped')) this.toggle();
    });
    this.more = el('button.ah-more', { onclick: () => this.toggle() });
    this.links = el('div.ah-links');
    this.node = el(
      'div.artist-hero' + className,
      { hidden: true },
      (this.back = el('div.ah-back', null, this.fanart)),
      el('div.ah-inner', null, this.pictureBox, el('div.ah-text', null, ...above, this.title, this.meta, ...details, this.assoc, this.bio, el('div.ah-foot', null, this.more, this.links))),
    );
    this.node.addEventListener('contextmenu', (e) => {
      if (!this.name) return;
      e.preventDefault();
      showMenu(this.menuItems());
    });
    // Its height changes on its own too: the window resized, or shown again
    // after being hidden (the mini player hides the page). The albums move.
    this.resize = new ResizeObserver(() => !this.node.hidden && this.measure());
    this.resize.observe(this.node);
    // A backdrop picture much smaller than the header (a genre's collage or
    // small picture) looked pixelated stretched across it: those are shown
    // blurred instead, drawn without banding (smoothbg.js). Real fanart
    // stays sharp.
    this.softImg = el('img', { alt: '' });
    this.back.append(this.softImg);
    this.soft = smoothBackdrop(this.softImg, this.back, { blur: 40, at: 1400, opacity: () => (store.get('dark') ? 0.35 : 0.45), bleed: 60, solid: 1 });
    this.fanart.addEventListener('load', () => this.checkSoft());
    this.refreshEvent = refreshEvent;
    this.onRefresh = (e) => this.refresh(e);
    window.addEventListener(refreshEvent, this.onRefresh);
  }

  /** Low-resolution backdrop: blurred; otherwise the picture as it is. */
  checkSoft() {
    const f = this.fanart;
    const low = !!f.getAttribute('src') && f.naturalWidth > 0 && f.naturalWidth < this.back.clientWidth * 0.6;
    if (low) {
      if (this.softImg.src !== f.src) this.softImg.src = f.src;
      this.softImg.classList.add('loaded');
    } else {
      this.back.classList.remove('smooth');
      this.softImg.classList.remove('loaded');
      this.softImg.removeAttribute('src');
    }
  }

  destroy() {
    this.soft.destroy();
    this.resize.disconnect();
    window.removeEventListener(this.refreshEvent, this.onRefresh);
  }

  /** Its right-click menu. */
  menuItems() {
    return [];
  }

  /** Its files were changed or asked to be read again. */
  refresh() {}

  /** A name the Collection has: a link to its page. */
  valueLink(kind, value) {
    return valueLink(kind, value);
  }

  /** A picture from a file, scaled; `ready`: already scaled and decoded (no fade). */
  async setImage(img, file, px, ready = null, { trim = false } = {}) {
    if (ready) return this.showUrl(img, ready);
    img.classList.remove('loaded', 'instant');
    img.removeAttribute('src');
    if (!file) return;
    const name = this.name;
    const url = await pictureUrl(file, px, { trim });
    if (!url || this.name !== name) return;
    img.onload = () => {
      img.classList.add('loaded');
      this.loaded(img);
    };
    img.src = url;
  }

  /** A picture whose URL is ready: shown at once, no fade. */
  showUrl(img, url) {
    img.classList.add('instant');
    img.onload = null;
    if (!url) {
      img.classList.remove('loaded');
      img.removeAttribute('src');
      return;
    }
    if (img.src !== url) img.src = url;
    img.classList.add('loaded');
  }

  /** A picture faded in (a logo can change the header's height). */
  loaded() {}

  toggle() {
    this.expanded = !this.expanded;
    this.measure();
  }

  // "More" only if the biography is longer than the fold; then tell the grid
  // where the albums start.
  measure() {
    this.node.classList.toggle('expanded', this.expanded);
    requestAnimationFrame(() => {
      if (this.node.hidden) return;
      const clipped = this.bio.scrollHeight > this.bio.clientHeight + 2;
      this.bio.classList.toggle('clipped', clipped && !this.expanded);
      this.bio.classList.toggle('foldable', this.expanded);
      this.more.hidden = !this.expanded && !clipped;
      this.more.textContent = this.expanded ? 'Less' : 'More';
      const top = this.node.offsetHeight + GAP;
      if (top !== this.grid.top) {
        this.grid.top = top;
        this.grid.layout();
      }
    });
  }

  hide() {
    this.node.hidden = true;
    const rest = this.grid.restTop();
    if (this.grid.top !== rest) {
      this.grid.top = rest;
      this.grid.layout();
    }
  }
}

/**
 * Scaled picture URLs for [file, px, trim] entries, each decoded, waiting at
 * most a moment: entries not ready by then are null (they fade in later).
 */
export async function preload(entries, wait = 350) {
  const out = entries.map(() => null);
  const jobs = entries.map(async ([file, px, trim], i) => {
    if (!file) return;
    const url = await pictureUrl(file, px, { trim: !!trim });
    if (!url) return;
    const im = new Image();
    im.src = url;
    await im.decode().catch(() => {});
    out[i] = url;
  });
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, wait))]);
  return out.slice();
}
