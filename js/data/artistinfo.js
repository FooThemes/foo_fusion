// Artist information folder, in Kodi's layout (also read by Jellyfin, Emby,
// Symfonium and MediaElch): one subfolder per artist, named after the artist,
// holding
//   artist.nfo                       XML: biography, genres, styles, years…
//   artist.* / folder.* / thumb.*    the artist's picture
//   fanart.*                         a wide background picture
// Fusion reads it for artist tiles and the artist page. Artists without a
// folder fall back to foobar2000's own artist art and then album covers.

import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';

const PICTURE = ['artist', 'folder', 'thumb', 'poster', 'photo'];
const FANART = ['fanart', 'backdrop', 'background'];
const found = new Map(); // artist name (lower case) -> Promise<info|null>

/** The artist's folder: Windows-unsafe characters become "_", as Kodi's export does. */
export function artistFolder(name) {
  const root = String(store.get('artistInfoFolder') || '').trim().replace(/[\\/]+$/, '');
  if (!root || !name) return null;
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '');
  return safe ? `${root}\\${safe}` : null;
}

/**
 * { dir, picture, fanart } (picture/fanart: { name, path, size } or null),
 * or null when the artist has no folder. Pictures only; the .nfo is read
 * separately (artistDetails) since only the artist page needs it.
 */
export function artistFiles(name) {
  const dir = artistFolder(name);
  if (!dir) return Promise.resolve(null);
  const key = dir.toLowerCase();
  if (!found.has(key)) {
    found.set(
      key,
      tryCall('artwork.getFolderImages', { directory: dir }).then((res) => {
        const images = res?.images || [];
        const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
        const pick = (names) => names.map((n) => images.find((im) => base(im.name) === n)).find(Boolean) || null;
        return { dir, picture: pick(PICTURE), fanart: pick(FANART) };
      }),
    );
  }
  return found.get(key);
}

const details = new Map();

/** Parsed artist.nfo, or null. */
export function artistDetails(name) {
  const dir = artistFolder(name);
  if (!dir) return Promise.resolve(null);
  const key = dir.toLowerCase();
  if (!details.has(key)) {
    details.set(
      key,
      // Check first: most artists won't have one, and a failed read is logged.
      tryCall('file.exists', { path: `${dir}\\artist.nfo` })
        .then((r) => (r?.exists ? tryCall('file.read', { path: `${dir}\\artist.nfo` }) : null))
        .then((res) => (res?.content ? parseNfo(res.content) : null)),
    );
  }
  return details.get(key);
}

export function forgetArtistInfo() {
  found.clear();
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
