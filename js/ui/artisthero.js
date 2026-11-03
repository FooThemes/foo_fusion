// Header for an artist's page (Artists > an artist): picture, name, genres and
// years, biography, over the artist's fanart, from the artist information
// folder (Settings > Library) or the artist's own music folder. Hidden when
// neither has anything for the artist.

import { el, clear } from '../core/util.js';
import { artistFiles, artistDetails, pictureUrl } from '../data/artistinfo.js';

const GAP = 24; // between the header and the first row of albums

export class ArtistHero {
  constructor(grid) {
    this.grid = grid;
    this.name = null;
    this.expanded = false;
    this.fanart = el('img.ah-fanart', { alt: '' });
    this.picture = el('img', { alt: '' });
    this.pictureBox = el('div.ah-picture', null, this.picture);
    this.title = el('h2.ah-name');
    this.logo = el('img.ah-logo', { alt: '' });
    this.meta = el('div.ah-meta');
    this.bio = el('div.ah-bio');
    this.more = el('button.ah-more', { onclick: () => this.#toggle() });
    this.node = el(
      'div.artist-hero',
      { hidden: true },
      el('div.ah-back', null, this.fanart),
      el('div.ah-inner', null, this.pictureBox, el('div.ah-text', null, this.logo, this.title, this.meta, this.bio, this.more)),
    );
  }

  /** handle: one of the artist's tracks (for their own music folder). */
  async show(name, handle = null) {
    const key = `${name}|${handle || ''}`;
    if (key === this.key) return;
    // Same artist, already found: a later handle changes nothing.
    if (name === this.name && this.found) return;
    this.key = key;
    if (name !== this.name) this.expanded = false;
    this.name = name;
    this.found = false;
    if (!name) return this.#hide();
    const [files, info] = await Promise.all([artistFiles(name, handle), artistDetails(name, handle)]);
    if (this.key !== key) return;
    if (!files || (!files.picture && !files.fanart && !info)) return this.#hide();
    this.found = true;

    this.title.textContent = info?.name || name;
    const life = info?.formed || info?.born ? [info.formed || info.born, info.disbanded || info.died].filter(Boolean).join(' – ') : '';
    const tags = [...(info?.genres || []), ...(info?.styles || [])].filter((t, i, a) => a.indexOf(t) === i).slice(0, 5);
    this.meta.textContent = [tags.join(', '), info?.yearsActive, life].filter(Boolean).join(' · ');
    clear(this.bio);
    for (const para of (info?.biography || '').split(/\n+/).filter(Boolean)) this.bio.append(el('p', { text: para }));
    this.bio.hidden = !info?.biography;
    this.node.classList.toggle('has-fanart', !!files.fanart);
    this.node.classList.toggle('no-picture', !files.picture);
    this.node.hidden = false;
    // A logo, when there is one, stands in for the name (kept for screen readers).
    this.node.classList.toggle('has-logo', !!files.logo);
    this.logo.alt = this.title.textContent;
    this.#setImage(this.logo, files.logo, 800);
    this.#setImage(this.picture, files.picture, 400);
    this.#setImage(this.fanart, files.fanart, 1600);
    this.#measure();
  }

  async #setImage(img, file, px) {
    img.classList.remove('loaded');
    img.removeAttribute('src');
    if (!file) return;
    const name = this.name;
    const url = await pictureUrl(file, px);
    if (!url || this.name !== name) return;
    img.onload = () => {
      img.classList.add('loaded');
      if (img === this.logo) this.#measure(); // the logo can change the header's height
    };
    img.src = url;
  }

  #toggle() {
    this.expanded = !this.expanded;
    this.#measure();
  }

  // Show "More" only if the biography is longer than the clamp; then tell
  // the grid where the albums start.
  #measure() {
    this.node.classList.toggle('expanded', this.expanded);
    requestAnimationFrame(() => {
      const clipped = this.bio.scrollHeight > this.bio.clientHeight + 2;
      this.more.hidden = !this.expanded && !clipped;
      this.more.textContent = this.expanded ? 'Less' : 'More';
      this.grid.top = this.node.offsetHeight + GAP;
      this.grid.layout();
    });
  }

  #hide() {
    this.node.hidden = true;
    if (this.grid.top !== 16) {
      this.grid.top = 16;
      this.grid.layout();
    }
  }
}
