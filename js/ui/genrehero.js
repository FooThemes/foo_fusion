// Header for a genre's page (Genres > a genre): its picture (or a collage of
// its biggest albums), name, description from genre.nfo (written by
// fusion-artist-info.py --genres), the genres it belongs to and includes, and
// what the library has of it: albums, artists, songs, length, years, and its
// top artists. Uses the artist header's look (ah-* classes).

import { el, clear, plural, formatDuration } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall } from '../core/bridge.js';
import { genreFiles, genreDetails, forgetGenreInfo } from '../data/genreinfo.js';
import { pictureUrl } from '../data/artistinfo.js';
import { collageUrl } from './collage.js';
import { showMenu } from './menus.js';
import { view } from '../data/view.js';

const GAP = 24; // between the header and the first row of albums
const PIC_W = 320;
const PIC_H = 160;

export class GenreHero {
  constructor(grid) {
    this.grid = grid;
    this.name = null;
    this.expanded = false;
    this.fanart = el('img.ah-fanart', { alt: '' });
    this.picture = el('img', { alt: '' });
    this.pictureBox = el('div.ah-picture.gh-picture', null, this.picture);
    this.title = el('h2.ah-name');
    this.meta = el('div.ah-meta');
    this.stats = el('div.gh-stats');
    this.assoc = el('div.ah-assoc');
    this.bio = el('div.ah-bio');
    this.bio.addEventListener('click', (e) => {
      if (e.target.closest('a, button') || getSelection()?.toString()) return;
      if (this.expanded || this.bio.classList.contains('clipped')) this.#toggle();
    });
    this.more = el('button.ah-more', { onclick: () => this.#toggle() });
    this.links = el('div.ah-links');
    this.node = el(
      'div.artist-hero.genre-hero',
      { hidden: true },
      el('div.ah-back', null, this.fanart),
      el('div.ah-inner', null, this.pictureBox, el('div.ah-text', null, this.title, this.meta, this.stats, this.assoc, this.bio, el('div.ah-foot', null, this.more, this.links))),
    );
    this.node.addEventListener('contextmenu', (e) => {
      if (!this.name) return;
      e.preventDefault();
      showMenu([{ label: 'Refresh genre information', run: () => forgetGenreInfo() }]);
    });
    window.addEventListener('fusion:genrerefresh', () => {
      if (!this.name) return;
      const name = this.name;
      this.name = null;
      this.key = null;
      this.show(name);
    });
  }

  /** Called whenever the genre page's albums change (heads arriving too). */
  async show(name) {
    if (!name) return this.#hide();
    const sig = `${name}|${view.groups.length}|${view.groups.filter((g) => g.head).length}`;
    if (sig === this.key) return;
    this.key = sig;
    const fresh = name !== this.name;
    if (fresh) this.expanded = false;
    this.name = name;
    const key = sig;
    this.title.textContent = name;
    this.node.hidden = false;
    this.#renderStats(key, fresh);
    if (!fresh && this.info !== undefined) return this.#renderPicture(key);
    if (fresh) {
      this.info = undefined;
      clear(this.meta);
      clear(this.assoc);
      clear(this.bio);
      clear(this.links);
      this.fanart.classList.remove('loaded');
      this.fanart.removeAttribute('src');
      delete this.fanart.dataset.src;
      this.picture.classList.remove('loaded');
      this.picture.removeAttribute('src');
      this.pictureFor = null;
      this.#measure();
    }
    const [files, info] = await Promise.all([genreFiles(name), genreDetails(name)]);
    if (this.name !== name) return;
    this.files = files;
    this.info = info;
    // "genre of popular music · United States, United Kingdom · since 1950"
    clear(this.meta);
    const parts = [info?.summary && info.summary[0].toUpperCase() + info.summary.slice(1), info?.origins?.length && info.origins.join(', '), /^\d{4}/.test(info?.since || '') && `since ${info.since.slice(0, 4)}`].filter(Boolean);
    this.meta.textContent = parts.join(' · ');
    this.meta.hidden = !parts.length;
    this.title.title = info?.aliases?.length ? `Also known as ${info.aliases.join(', ')}` : '';
    await this.#renderAssoc(info, name);
    clear(this.bio);
    for (const para of (info?.description || '').split(/\n+/).filter(Boolean)) this.bio.append(el('p', { text: para }));
    this.bio.hidden = !info?.description;
    clear(this.links);
    const link = (label, url) => el('button.ah-link', { title: url, onclick: () => tryCall('shell.openExternal', { url }) }, label, icon('link'));
    if (/^https?:\/\//.test(info?.wikipedia || '')) this.links.append(link('Wikipedia', info.wikipedia));
    if (/^[0-9a-f-]{36}$/i.test(info?.musicbrainz || '')) this.links.append(link('MusicBrainz', `https://musicbrainz.org/genre/${info.musicbrainz}`));
    const back = files?.fanart || files?.picture;
    this.node.classList.toggle('has-fanart', !!back);
    if (back) this.#setImage(this.fanart, back, 1600);
    this.#renderPicture(this.key);
    this.#measure();
  }

  /** The genre's own picture, else its biggest albums' covers. */
  async #renderPicture(key) {
    const name = this.name;
    if (this.files?.picture) {
      if (this.pictureFor !== 'own') {
        this.pictureFor = 'own';
        this.#setImage(this.picture, this.files.picture, PIC_W * 2);
      }
      return;
    }
    const top = [...view.groups].filter((g) => g.head?.handle).sort((a, b) => b.count - a.count).slice(0, 4);
    const handles = top.map((g) => g.head.handle);
    const sig = handles.join('|');
    if (!handles.length || sig === this.pictureFor) return;
    this.pictureFor = sig;
    const url = await collageUrl(handles, PIC_W, PIC_H);
    if (this.name !== name || this.pictureFor !== sig || !url) return;
    this.picture.onload = () => this.picture.classList.add('loaded');
    this.picture.src = url;
    // No fanart: the collage behind the header too.
    if (!this.files?.fanart && !this.files?.picture && this.fanart.dataset.src !== url) {
      this.fanart.dataset.src = url;
      this.fanart.onload = () => this.fanart.classList.add('loaded');
      this.fanart.src = url;
    }
    void key;
  }

  /** "Part of Pop, Blues" / "Includes Metal, Punk": genres the library has are links. */
  async #renderAssoc(info, name) {
    clear(this.assoc);
    const groups = [
      ['Part of', info?.parents || []],
      ['Includes', info?.subgenres || []],
    ].filter(([, list]) => list.length);
    this.assoc.hidden = !groups.length;
    if (!groups.length) return;
    const genres = await view.libraryValues('genres');
    if (this.name !== name) return;
    for (const [label, list] of groups) {
      const line = el('div', null, el('span.ah-assoc-label', { text: label + ' ' }));
      // In the library first (they're links), then up to a handful of the rest.
      const known = list.filter((g) => genres.has(g.toLowerCase()));
      const rest = list.filter((g) => !genres.has(g.toLowerCase()));
      const shown = [...known, ...rest.slice(0, Math.max(0, 8 - known.length))];
      shown.forEach((g, i) => {
        const lib = genres.get(g.toLowerCase());
        line.append(...(i ? [', '] : []), lib ? this.#valueLink('genres', lib) : g);
      });
      const more = list.length - shown.length;
      if (more > 0) line.append(el('span.ah-assoc-label', { text: ` and ${more} more` }));
      this.assoc.append(line);
    }
  }

  /** Albums, artists, songs, length and years in the library; top artists. */
  async #renderStats(key, fresh) {
    const groups = view.groups;
    const years = groups.map((g) => parseInt(g.head?.year, 10)).filter((y) => y > 0);
    const songs = groups.reduce((n, g) => n + g.count, 0);
    const span = years.length ? (Math.min(...years) === Math.max(...years) ? `${Math.min(...years)}` : `${Math.min(...years)}–${Math.max(...years)}`) : '';
    const line = (extra = []) => [plural(groups.length, 'album'), ...extra, span].filter(Boolean).join(' · ');
    if (fresh || !this.statsDone) {
      this.stats.textContent = line([plural(songs, 'song')]);
      clear(this.top || (this.top = el('div.gh-top')));
    }
    // Songs' artists and lengths: one read of the page's songs (once per genre).
    if (this.statsFor === this.name) return;
    const name = this.name;
    const rows = groups.flatMap((g) => view.groupRows(g));
    if (!rows.length || !view.playlist) return;
    this.statsFor = name;
    this.statsDone = false;
    let seconds = 0;
    const byArtist = new Map();
    for (let i = 0; i < rows.length; i += 2000) {
      const res = await tryCall('playlist.getTracksAt', { playlist: view.playlist.index, rows: rows.slice(i, i + 2000), fields: ['duration', 'albumArtist', 'artist'] });
      if (this.name !== name) return;
      for (const t of res?.tracks || []) {
        seconds += Number(t.duration) || 0;
        const who = (t.albumArtist || t.artist || '').trim();
        if (who && !/^various artists$/i.test(who)) byArtist.set(who, (byArtist.get(who) || 0) + 1);
      }
    }
    if (this.name !== name) return;
    this.statsDone = true;
    this.stats.textContent = line([plural(byArtist.size, 'artist'), plural(songs, 'song'), seconds ? formatDuration(seconds) : '']);
    const top = [...byArtist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    clear(this.top);
    if (top.length > 1) {
      const artists = await view.libraryValues('artists');
      if (this.name !== name) return;
      this.top.append(el('span.ah-assoc-label', { text: 'Top artists ' }));
      top.forEach(([who], i) => this.top.append(...(i ? [', '] : []), artists.has(who.toLowerCase()) ? this.#valueLink('artists', artists.get(who.toLowerCase())) : who));
      this.stats.after(this.top);
    }
    this.#measure();
    void key;
  }

  #valueLink(kind, value) {
    return el('button.ah-value', { text: value, title: kind === 'artists' ? `Show ${value}` : `Show ${value} albums`, onclick: () => view.showValue(kind, value) });
  }

  async #setImage(img, file, px) {
    img.classList.remove('loaded');
    const name = this.name;
    const url = await pictureUrl(file, px);
    if (!url || this.name !== name) return;
    img.onload = () => img.classList.add('loaded');
    img.src = url;
  }

  #toggle() {
    this.expanded = !this.expanded;
    this.#measure();
  }

  #measure() {
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

  #hide() {
    this.name = null;
    this.key = null;
    this.statsFor = null;
    if (this.node.hidden) return;
    this.node.hidden = true;
    if (this.grid.top !== 16) {
      this.grid.top = 16;
      this.grid.layout();
    }
  }
}
