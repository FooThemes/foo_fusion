// Artist information folder, in Kodi's layout (also read by Jellyfin, Emby,
// Symfonium and MediaElch): one subfolder per artist, named after the artist,
// holding
//   artist.nfo                       XML: biography, genres, styles, years…
//   artist.* / folder.* / thumb.*    the artist's picture
//   fanart.*                         a wide background picture
//   logo.*                           the artist's logo (shown in place of the name)
// Fusion reads it for artist tiles and the artist page. Like Kodi, an artist
// missing from that folder is looked for in their own music folder (the one
// above their albums) next; after that, foobar2000's artist art and then
// album covers.

import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';

const PICTURE = ['artist', 'folder', 'thumb', 'poster', 'photo'];
const FANART = ['fanart', 'backdrop', 'background'];
const LOGO = ['logo', 'clearlogo'];
const found = new Map(); // artist name (lower case) -> Promise<info|null>

/** The artist's folder: Windows-unsafe characters become "_", as Kodi's export does. */
export function artistFolder(name) {
  const root = String(store.get('artistInfoFolder') || '').trim().replace(/[\\/]+$/, '');
  if (!root || !name) return null;
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '');
  return safe ? `${root}\\${safe}` : null;
}

const DISC_DIR = /^(cd|dis[ck]|dvd|vol(ume)?\.?)\s*[-_.#]?\s*\d+|^\d{1,2}$/i;
const norm = (s) => s.toLowerCase().replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '');

/**
 * Kodi's fallback: the folder above the artist's album folder (above the disc
 * folders, for box sets), used only when it's named after the artist, so a
 * compilation's "Various Artists" or the music root is never taken for one.
 */
export function musicArtistFolder(name, handle) {
  if (!name || !handle) return null;
  let dir = handle.replace(/\|subsong:\d+$/, '');
  dir = dir.slice(0, dir.lastIndexOf('\\')); // album (or disc) folder
  if (DISC_DIR.test(dir.slice(dir.lastIndexOf('\\') + 1))) dir = dir.slice(0, dir.lastIndexOf('\\'));
  const parent = dir.slice(0, dir.lastIndexOf('\\'));
  const folderName = parent.slice(parent.lastIndexOf('\\') + 1);
  return parent && norm(folderName) === norm(name) ? parent : null;
}

const listing = new Map(); // folder (lower case) -> Promise<{ dir, picture, fanart, hasNfo }>

function readFolder(dir) {
  const key = dir.toLowerCase();
  if (!listing.has(key)) {
    listing.set(
      key,
      Promise.all([tryCall('artwork.getFolderImages', { directory: dir }), tryCall('file.exists', { path: `${dir}\\artist.nfo` })]).then(([res, nfo]) => {
        const images = res?.images || [];
        const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
        const pick = (names) => names.map((n) => images.find((im) => base(im.name) === n)).find(Boolean) || null;
        return { dir, picture: pick(PICTURE), fanart: pick(FANART), logo: pick(LOGO), hasNfo: !!nfo?.exists };
      }),
    );
  }
  return listing.get(key);
}

/**
 * Where this artist's information lives, as Kodi looks: the artist
 * information folder first, then the artist's own folder above their albums
 * (needs a track `handle` of theirs). Resolves to { dir, picture, fanart,
 * hasNfo } or null when neither has anything.
 */
export function artistFiles(name, handle = null) {
  const key = `${name}|${handle ? musicArtistFolder(name, handle) || '' : ''}`;
  if (!found.has(key)) {
    found.set(
      key,
      (async () => {
        const dirs = [artistFolder(name), musicArtistFolder(name, handle)].filter(Boolean);
        for (const dir of dirs) {
          const f = await readFolder(dir);
          if (f.picture || f.fanart || f.hasNfo) return f;
        }
        return null;
      })(),
    );
  }
  return found.get(key);
}

const details = new Map();

/** Parsed artist.nfo from wherever artistFiles found the artist, or null. */
export async function artistDetails(name, handle = null) {
  const files = await artistFiles(name, handle);
  if (!files?.hasNfo) return null;
  const key = files.dir.toLowerCase();
  if (!details.has(key)) {
    details.set(
      key,
      tryCall('file.read', { path: `${files.dir}\\artist.nfo` }).then((res) => (res?.content ? parseNfo(res.content) : null)),
    );
  }
  return details.get(key);
}

export function forgetArtistInfo() {
  found.clear();
  listing.clear();
  details.clear();
}

function parseNfo(xml) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return null;
  }
  const root = doc.querySelector('artist');
  if (!root || doc.querySelector('parsererror')) return null;
  const one = (tag) => root.querySelector(`:scope > ${tag}`)?.textContent.trim() || '';
  const all = (tag) => [...root.querySelectorAll(`:scope > ${tag}`)].map((n) => n.textContent.trim()).filter(Boolean);
  return {
    name: one('name'),
    genres: all('genre'),
    styles: all('style'),
    moods: all('mood'),
    yearsActive: all('yearsactive').join(', '),
    formed: one('formed'),
    born: one('born'),
    died: one('died'),
    disbanded: one('disbanded'),
    biography: one('biography'),
    musicbrainz: one('musicBrainzArtistID'),
  };
}

/** Load a picture file into a (downscaled) blob URL for display. */
export async function pictureUrl(file, px) {
  const res = await tryCall('file.read', { path: file.path, encoding: 'binary' });
  if (!res?.content) return null;
  let bin;
  try {
    bin = atob(res.content);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = /\.png$/i.test(file.name) ? 'image/png' : /\.gif$/i.test(file.name) ? 'image/gif' : /\.webp$/i.test(file.name) ? 'image/webp' : 'image/jpeg';
  const blob = new Blob([bytes], { type });
  if (!px) return URL.createObjectURL(blob);
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, px / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return URL.createObjectURL(await c.convertToBlob({ type: type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', quality: 0.88 }));
  } catch {
    return URL.createObjectURL(blob);
  }
}
