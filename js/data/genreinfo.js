// Genre information folder: one subfolder per genre, named after it, holding
//   genre.nfo        XML written by tools/fusion-artist-info.py --genres:
//                    name, summary, description, wikipedia, origin, since,
//                    alias, parent, subgenre (Fusion's own format; Kodi has none)
//   folder.* (or genre.*, thumb.*, poster.*)   the genre's picture (wide works best)
//   fanart.*         optional background for the genre's page
// The folder is Settings > Artists > Genre information folder, or, when that's
// empty, _Genres beside the artist information folder (the script's default).

import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';

const PICTURE = ['folder', 'genre', 'thumb', 'poster', 'cover'];
const FANART = ['fanart', 'backdrop', 'background'];
const files = new Map(); // genre (lower case) -> Promise<{ dir, picture, fanart, hasNfo } | null>
const details = new Map(); // genre (lower case) -> Promise<info | null>

export function genreRoot() {
  const own = String(store.get('genreInfoFolder') || '').trim().replace(/[\\/]+$/, '');
  if (own) return own;
  const artists = String(store.get('artistInfoFolder') || '').trim().replace(/[\\/]+$/, '');
  return artists ? artists.slice(0, artists.lastIndexOf('\\') + 1) + '_Genres' : '';
}

export function genreFolder(name) {
  const root = genreRoot();
  const safe = (name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '');
  return root && safe ? `${root}\\${safe}` : null;
}

/** The genre's files, or null when its folder has none. */
export function genreFiles(name) {
  const key = (name || '').toLowerCase();
  if (!files.has(key)) {
    const dir = genreFolder(name);
    files.set(
      key,
      !dir
        ? Promise.resolve(null)
        : Promise.all([tryCall('artwork.getFolderImages', { directory: dir }), tryCall('file.exists', { path: `${dir}\\genre.nfo` })]).then(([res, nfo]) => {
            const images = res?.images || [];
            const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
            const pick = (names) => names.map((n) => images.find((im) => base(im.name) === n)).find(Boolean) || null;
            const out = { dir, picture: pick(PICTURE), fanart: pick(FANART), hasNfo: !!nfo?.exists };
            return out.picture || out.fanart || out.hasNfo ? out : null;
          }),
    );
  }
  return files.get(key);
}

/** Parsed genre.nfo, or null. */
export async function genreDetails(name) {
  const f = await genreFiles(name);
  if (!f?.hasNfo) return null;
  const key = (name || '').toLowerCase();
  if (!details.has(key)) details.set(key, tryCall('file.read', { path: `${f.dir}\\genre.nfo` }).then((r) => (r?.content ? parseGenreNfo(r.content) : null)));
  return details.get(key);
}

/** Read genre folders again (after the script has run, or the folder changed). */
export function forgetGenreInfo() {
  files.clear();
  details.clear();
  window.dispatchEvent(new CustomEvent('fusion:genrerefresh'));
}

function parseGenreNfo(xml) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return null;
  }
  const root = doc.querySelector('genre');
  if (!root || doc.querySelector('parsererror')) return null;
  const one = (tag) => root.querySelector(`:scope > ${tag}`)?.textContent.trim() || '';
  const all = (tag) => [...root.querySelectorAll(`:scope > ${tag}`)].map((n) => n.textContent.trim()).filter(Boolean);
  return {
    name: one('name'),
    summary: one('summary'),
    description: one('description').replace(/\[\s*(?:\d+|[a-z]|citation needed|note \d+)\s*\]/gi, ''),
    wikipedia: one('wikipedia'),
    musicbrainz: one('musicBrainzGenreID'),
    origins: all('origin'),
    since: one('since'),
    aliases: all('alias'),
    parents: all('parent'),
    subgenres: all('subgenre'),
  };
}
