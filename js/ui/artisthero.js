// Header for an artist's page (Artists > an artist): picture, name, genres and
// years, biography, over the artist's fanart, from the artist information
// folder (Settings > Library) or the artist's own music folder. Hidden when
// neither has anything for the artist.

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall } from '../core/bridge.js';
import { artistFiles, artistDetails } from '../data/artistinfo.js';
import { pickVersion, VERSION_KEYS } from '../data/versions.js';
import * as store from '../core/store.js';
import { refreshArtist } from '../data/artwork.js';
import { refreshAlbums } from './menus.js';
import { Hero, preload } from './hero.js';
import { view } from '../data/view.js';
import { editArtist } from './infoeditor.js';

export class ArtistHero extends Hero {
  constructor(grid) {
    const logo = el('img.ah-logo', { alt: '' });
    super(grid, { above: [logo], refreshEvent: 'fusion:artistrefresh' });
    this.logo = logo;
    this.offStore = store.subscribe((k) => {
      if (!VERSION_KEYS.includes(k) || !this.name) return;
      this.key = null;
      this.found = false;
      this.show(this.name, this.handle);
    });
  }

  menuItems() {
    return [
      { label: 'Edit artist information…', run: () => editArtist(this.name, this.handle) },
      { label: 'Refresh artist information', run: () => (refreshArtist(this.name, this.handle ? [this.handle] : []), refreshAlbums(view.groups.flatMap((g) => view.groupRows(g)))) },
    ];
  }

  /** Read the artist's files again (right-click > Refresh, or Settings). */
  refresh(e) {
    const name = e.detail?.name;
    if (!this.name || (name && name.toLowerCase() !== this.name.toLowerCase())) return;
    this.key = null;
    this.found = false;
    this.show(this.name, this.handle);
  }

  loaded(img) {
    if (img === this.logo) this.measure(); // the logo can change the header's height
  }

  /** Read an artist's files and pictures ahead of opening their page. */
  async warm(name, handle) {
    const files = await artistFiles(name, handle);
    artistDetails(name, handle);
    if (files) preload([[files.logo, 800, true], [files.picture, 400], [files.fanart, 1600]], 5000);
  }

  /** handle: one of the artist's tracks (for their own music folder). */
  destroy() {
    super.destroy();
    this.offStore();
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
    if (!name) return this.hide();
    const [files, nfo] = await Promise.all([artistFiles(name, handle), artistDetails(name, handle)]);
    // MusicBrainz placeholders ("[unknown]", "[dialogue]", Various Artists)
    // aren't artists: no biography (any found is about the word), pictures only.
    const info = /^\[.+\]$|^various artists$/i.test(name.trim()) ? null : nfo;
    if (this.key !== key) return;
    if (!files || (!files.picture && !files.fanart && !info)) return this.hide();
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
    this.setImage(this.logo, files.logo, 800, ready[0], { trim: true });
    this.setImage(this.picture, files.picture, 400, ready[1]);
    this.setImage(this.fanart, files.fanart, 1600, ready[2]);
    this.measure();
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
        g.append(...(i ? [', '] : []), known ? this.valueLink('genres', known) : genreCase(t));
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
      sorted.forEach((p, i) => line.append(...(i ? [', '] : []), artists.has(p.name.toLowerCase()) ? this.valueLink('artists', p.name) : p.name));
      this.assoc.append(line);
    }
    this.measure();
  }
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
