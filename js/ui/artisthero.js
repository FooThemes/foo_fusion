// Header for an artist's page (Artists > an artist): picture, name, genres and
// years, biography, over the artist's fanart, from the artist information
// folder (Settings > Library) or the artist's own music folder. Hidden when
// neither has anything for the artist.

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall } from '../core/bridge.js';
import { artistFiles, artistDetails, pictureUrl } from '../data/artistinfo.js';
import { pickVersion, VERSION_KEYS } from '../data/versions.js';
import * as store from '../core/store.js';
import { refreshArtist } from '../data/artwork.js';
import { showMenu, refreshAlbums } from './menus.js';
import { view } from '../data/view.js';
import { editArtist } from './infoeditor.js';

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
    this.assoc = el('div.ah-assoc');
    // Click anywhere on a cut-off biography to read it all (and again to fold it).
    this.bio.addEventListener('click', (e) => {
      if (e.target.closest('a, button') || getSelection()?.toString()) return;
      if (this.expanded || this.bio.classList.contains('clipped')) this.#toggle();
    });
    this.more = el('button.ah-more', { onclick: () => this.#toggle() });
    this.links = el('div.ah-links');
    this.node = el(
      'div.artist-hero',
      { hidden: true },
      el('div.ah-back', null, this.fanart),
      el('div.ah-inner', null, this.pictureBox, el('div.ah-text', null, this.logo, this.title, this.meta, this.assoc, this.bio, el('div.ah-foot', null, this.more, this.links))),
    );
    this.node.addEventListener('contextmenu', (e) => {
      if (!this.name) return;
      e.preventDefault();
      showMenu([
        { label: 'Edit artist information…', run: () => editArtist(this.name, this.handle) },
        { label: 'Refresh artist information', run: () => (refreshArtist(this.name, this.handle ? [this.handle] : []), refreshAlbums(view.groups.flatMap((g) => view.groupRows(g)))) },
      ]);
    });
    this.offStore = store.subscribe((k) => {
      if (!VERSION_KEYS.includes(k) || !this.name) return;
      this.key = null;
      this.found = false;
      this.show(this.name, this.handle);
    });
    // Read the artist's files again (right-click > Refresh, or Settings).
    this.onRefresh = (e) => {
      const name = e.detail?.name;
      if (!this.name || (name && name.toLowerCase() !== this.name.toLowerCase())) return;
      this.key = null;
      this.found = false;
      this.show(this.name, this.handle);
    };
    window.addEventListener('fusion:artistrefresh', this.onRefresh);
  }

  /** Read an artist's files and pictures ahead of opening their page. */
  async warm(name, handle) {
    const files = await artistFiles(name, handle);
    artistDetails(name, handle);
    if (files) preload([[files.logo, 800, true], [files.picture, 400], [files.fanart, 1600]], 5000);
  }

  /** handle: one of the artist's tracks (for their own music folder). */
  destroy() {
    this.offStore();
    window.removeEventListener('fusion:artistrefresh', this.onRefresh);
  }

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
    // The pictures first (usually already scaled and decoded this session),
    // so the header changes in one go instead of text, then pictures.
    const ready = await preload([
      [files.logo, 800, true],
      [files.picture, 400],
      [files.fanart, 1600],
    ]);
    if (this.key !== key) return;
    this.found = true;

    // English / romanised names (name_en, name_rom), like titles: the lead
    // version, then the others smaller.
    const pick = pickVersion(info && (info.nameEn || info.nameRom) ? { orig: name, en: info.nameEn, rom: info.nameRom } : null, 'artists');
    this.title.textContent = pick ? pick.lead : info?.name || name;
    if (pick?.other) this.title.append(' ', el('span.alt-version', { text: pick.other }));
    this.title.title = pick?.tip || '';
    this.#renderMeta(info, key);
    this.#renderAssoc(info, key);
    clear(this.bio);
    for (const para of (info?.biography || '').split(/\n+/).filter(Boolean)) this.bio.append(el('p', { text: para }));
    this.bio.hidden = !info?.biography;
    // Where the biography came from, and the artist on MusicBrainz.
    clear(this.links);
    const link = (label, url) => el('button.ah-link', { title: url, onclick: () => tryCall('shell.openExternal', { url }) }, label, icon('link'));
    if (/^https?:\/\//.test(info?.website || '')) this.links.append(link('Website', info.website));
    if (/^https?:\/\//.test(info?.wikipedia || '')) this.links.append(link('Wikipedia', info.wikipedia));
    if (/^[0-9a-f-]{36}$/i.test(info?.musicbrainz || '')) this.links.append(link('MusicBrainz', `https://musicbrainz.org/artist/${info.musicbrainz}`));
    this.node.classList.toggle('has-fanart', !!files.fanart);
    this.node.classList.toggle('no-picture', !files.picture);
    this.node.hidden = false;
    // A logo, when there is one, stands in for the name (kept for screen readers).
    this.node.classList.toggle('has-logo', !!files.logo);
    this.logo.alt = pick ? pick.lead : this.title.textContent;
    this.#setImage(this.logo, files.logo, 800, ready[0]);
    this.#setImage(this.picture, files.picture, 400, ready[1]);
    this.#setImage(this.fanart, files.fanart, 1600, ready[2]);
    this.#measure();
  }

  /** Genres (linked to their pages when the library has them), years, dates. */
  async #renderMeta(info, key) {
    clear(this.meta);
    const tags = [...(info?.genres || []), ...(info?.styles || [])].filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i).slice(0, 5);
    // A person is born and dies; a band forms and disbands. Older files have
    // no <type>, so a band is also known by its members or a formed date
    // (and its "born" / "died" then read as formed / disbanded).
    const type = (info?.type || '').toLowerCase();
    const person = type ? type === 'person' || type === 'character' : !(info?.members?.length || info?.formed || info?.disbanded) && !!(info?.born || info?.died);
    const life = person
      ? [info.born && `Born ${formatDate(info.born)}`, info.died && `died ${formatDate(info.died)}`]
      : [(info?.formed || info?.born) && `Formed ${formatDate(info.formed || info.born)}`, (info?.disbanded || info?.died) && `disbanded ${formatDate(info.disbanded || info.died)}`];
    const lifeText = life.filter(Boolean).join(', ');
    const genres = tags.length ? await view.libraryValues('genres') : new Map();
    if (this.key !== key) return;
    const parts = [];
    if (tags.length) {
      const g = el('span');
      // In the library's spelling when it has the genre ("J-Pop" for "j-pop"),
      // else capitalised.
      tags.forEach((t, i) => {
        const known = genres.get(t.toLowerCase());
        g.append(...(i ? [', '] : []), known ? this.#valueLink('genres', known) : genreCase(t));
      });
      parts.push(g);
    }
    if (info?.yearsActive) parts.push(info.yearsActive);
    if (lifeText) parts.push(lifeText);
    parts.forEach((p, i) => this.meta.append(...(i ? [' · '] : []), p));
  }

  /** "Member of Nickelback" for a solo artist; a band's members. */
  async #renderAssoc(info, key) {
    clear(this.assoc);
    const groups = [
      ['Member of', (info?.memberOf || []).filter((p) => !p.ended)],
      ['Formerly in', (info?.memberOf || []).filter((p) => p.ended)],
      ['Members', (info?.members || []).filter((p) => !p.ended)],
      ['Former members', (info?.members || []).filter((p) => p.ended)],
    ].filter(([, list]) => list.length);
    this.assoc.hidden = !groups.length;
    if (!groups.length) return;
    const artists = await view.libraryValues('artists');
    if (this.key !== key) return;
    for (const [label, list] of groups) {
      const line = el('div', null, el('span.ah-assoc-label', { text: label + ' ' }));
      // Artists in the library first (they're links), then the rest.
      const sorted = [...list].sort((a, b) => artists.has(b.name.toLowerCase()) - artists.has(a.name.toLowerCase()));
      sorted.forEach((p, i) => line.append(...(i ? [', '] : []), artists.has(p.name.toLowerCase()) ? this.#valueLink('artists', p.name) : p.name));
      this.assoc.append(line);
    }
    this.#measure();
  }

  #valueLink(kind, value) {
    return el('button.ah-value', { text: value, title: kind === 'artists' ? `Show ${value}` : `Show ${value} albums`, onclick: () => view.showValue(kind, value) });
  }

  async #setImage(img, file, px, ready = null) {
    // Ready (decoded): shown at once, no fade.
    img.classList.toggle('instant', !!ready);
    if (ready) {
      img.onload = null;
      if (img.src !== ready) img.src = ready;
      img.classList.add('loaded');
      return;
    }
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
      this.bio.classList.toggle('clipped', clipped && !this.expanded);
      this.bio.classList.toggle('foldable', this.expanded);
      this.more.hidden = !this.expanded && !clipped;
      this.more.textContent = this.expanded ? 'Less' : 'More';
      this.grid.top = this.node.offsetHeight + GAP;
      this.grid.layout();
    });
  }

  #hide() {
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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "1974-11-15" -> "15 November 1974"; "1996-11" -> "November 1996"; anything else as is. */
function formatDate(text) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(text || '');
  if (!m) return text;
  const [, y, mo, d] = m;
  const month = mo ? MONTHS[Number(mo) - 1] : '';
  return [d ? String(Number(d)) : '', month, y].filter(Boolean).join(' ');
}

const GENRE_UPPER = new Set(['r&b', 'edm', 'idm', 'ebm', 'uk', 'us', 'dj', 'rpg', 'vgm', 'nwobhm']);
const GENRE_SMALL = new Set(['and', 'of', 'the', 'n', "'n'", 'in', 'with']);

/** "j-pop" -> "J-Pop", "hard rock" -> "Hard Rock", "r&b" -> "R&B"; already capitalised names stay. */
export function genreCase(name) {
  if (!name || name !== name.toLowerCase()) return name;
  return name
    .split(' ')
    .map((w, i) => (GENRE_UPPER.has(w) ? w.toUpperCase() : i && GENRE_SMALL.has(w) ? w : w.replace(/(^|[-/])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase())))
    .join(' ');
}
