// Header for an artist's page (Artists > an artist): picture, name, genres and
// years, biography, over the artist's fanart, from the artist information
// folder (Settings > Library) or the artist's own music folder. Hidden when
// neither has anything for the artist.

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall } from '../core/bridge.js';
import { artistFiles, artistDetails, pictureUrl } from '../data/artistinfo.js';
import { refreshArtist } from '../data/artwork.js';
import { showMenu } from './menus.js';

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
    this.links = el('div.ah-links');
    this.node = el(
      'div.artist-hero',
      { hidden: true },
      el('div.ah-back', null, this.fanart),
      el('div.ah-inner', null, this.pictureBox, el('div.ah-text', null, this.logo, this.title, this.meta, this.bio, el('div.ah-foot', null, this.more, this.links))),
    );
    this.node.addEventListener('contextmenu', (e) => {
      if (!this.name) return;
      e.preventDefault();
      showMenu([{ label: 'Refresh artist information', run: () => refreshArtist(this.name, this.handle ? [this.handle] : []) }]);
    });
    // Read the artist's files again (right-click > Refresh, or Settings).
    window.addEventListener('fusion:artistrefresh', (e) => {
      const name = e.detail?.name;
      if (!this.name || (name && name.toLowerCase() !== this.name.toLowerCase())) return;
      this.key = null;
      this.found = false;
      this.show(this.name, this.handle);
    });
  }

  /** handle: one of the artist's tracks (for their own music folder). */
  async show(name, handle = null) {
    const key = `${name}|${handle || ''}`;
    if (key === this.key) return;
    this.handle = handle;
    // Same artist, already found: a later handle changes nothing.
    if (name === this.name && this.found) return;
    this.key = key;
    if (name !== this.name) this.expanded = false;
    this.name = name;
    this.found = false;
    if (!name) return this.#hide();
    const [files, nfo] = await Promise.all([artistFiles(name, handle), artistDetails(name, handle)]);
    // MusicBrainz placeholders ("[unknown]", "[dialogue]", Various Artists)
    // aren't artists: no biography (any found is about the word), pictures only.
    const info = /^\[.+\]$|^various artists$/i.test(name.trim()) ? null : nfo;
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
    // Where the biography came from, and the artist on MusicBrainz.
    clear(this.links);
    const link = (label, url) => el('button.ah-link', { title: url, onclick: () => tryCall('shell.openExternal', { url }) }, label, icon('link'));
    if (/^https?:\/\//.test(info?.wikipedia || '')) this.links.append(link('Wikipedia', info.wikipedia));
    if (/^[0-9a-f-]{36}$/i.test(info?.musicbrainz || '')) this.links.append(link('MusicBrainz', `https://musicbrainz.org/artist/${info.musicbrainz}`));
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
    const url = await pictureUrl(file, px, { trim: img === this.logo });
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
