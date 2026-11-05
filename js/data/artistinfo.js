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

/** Read the artist's (or every artist's) information again. */
export function forgetArtistInfo(name = null) {
  pictures.clear();
  if (!name) {
    found.clear();
    listing.clear();
    details.clear();
    return;
  }
  const n = norm(name);
  const mine = (dir) => dir.toLowerCase().endsWith('\\' + n);
  for (const key of [...found.keys()]) if (key.slice(0, key.lastIndexOf('|')).toLowerCase() === name.toLowerCase()) found.delete(key);
  for (const key of [...listing.keys()]) if (mine(key)) listing.delete(key);
  for (const key of [...details.keys()]) if (mine(key)) details.delete(key);
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
  const people = (tag) =>
    [...root.querySelectorAll(`:scope > ${tag}`)]
      .map((n) => ({ name: n.textContent.trim(), mbid: n.getAttribute('mbid') || '', ended: n.getAttribute('ended') === 'true' }))
      .filter((p) => p.name);
  // Dates: "0" (TheAudioDB's "unknown") or other non-dates count as empty.
  const date = (tag) => (/^[1-9]\d{2,3}\b/.test(one(tag)) ? one(tag) : '');
  const all = (tag) => [...root.querySelectorAll(`:scope > ${tag}`)].map((n) => n.textContent.trim()).filter(Boolean);
  return {
    name: one('name'),
    type: one('type'),
    // English and romanised names (Fusion's own fields; see versions.js).
    nameEn: one('name_en'),
    nameRom: one('name_rom'),
    genres: all('genre'),
    styles: all('style'),
    moods: all('mood'),
    yearsActive: all('yearsactive').filter((y) => !/^0+$/.test(y)).join(', '),
    formed: date('formed'),
    born: date('born'),
    died: date('died'),
    disbanded: date('disbanded'),
    // Reference marks ([2], [citation needed]) left in by some sources.
    biography: one('biography').replace(/\[\s*(?:\d+|[a-z]|citation needed|note \d+|clarification needed)\s*\]/gi, ''),
    musicbrainz: one('musicBrainzArtistID'),
    wikipedia: one('wikipedia'),
    website: one('website'),
    // Bands the artist is in, and a band's members (Fusion's own fields).
    memberOf: people('memberof'),
    members: people('member'),
  };
}

// Bounds of the visible (non-transparent) pixels; faint glows count as blank.
function opaqueBounds(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Load a picture file into a (downscaled) blob URL for display. `trim`
 * crops transparent margins (logos often come with lots of them, which
 * throws them out of line with the text below).
 */
const pictures = new Map(); // path|size|trim -> Promise<blob URL | null>

export function pictureUrl(file, px, { trim = false } = {}) {
  // Kept for the session: an artist's or genre's page opened again shows its
  // pictures at once instead of reading and scaling the files again.
  const key = `${file.path}|${file.size || ''}|${px || 0}|${trim}`;
  let p = pictures.get(key);
  if (!p) {
    p = makePictureUrl(file, px, trim);
    pictures.set(key, p);
    p.then((u) => u || pictures.delete(key));
    if (pictures.size > 300) pictures.delete(pictures.keys().next().value);
  }
  return p;
}

/** Forget the scaled pictures (files replaced or refreshed). */
export function forgetPictures() {
  pictures.clear();
}

async function makePictureUrl(file, px, trim) {
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
  if (!px && !trim) return URL.createObjectURL(blob);
  try {
    const bmp = await createImageBitmap(blob);
    const scale = px ? Math.min(1, px / Math.max(bmp.width, bmp.height)) : 1;
    let c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    const ctx = c.getContext('2d', { willReadFrequently: trim });
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    if (trim && type !== 'image/jpeg') {
      const b = opaqueBounds(ctx, c.width, c.height);
      if (b && (b.w < c.width || b.h < c.height)) {
        const pad = 2; // keep the edge of a glow or shadow
        const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
        const w = Math.min(c.width - x, b.w + pad * 2), h = Math.min(c.height - y, b.h + pad * 2);
        const cut = new OffscreenCanvas(w, h);
        cut.getContext('2d').drawImage(c, x, y, w, h, 0, 0, w, h);
        c = cut;
      }
    }
    return URL.createObjectURL(await c.convertToBlob({ type: type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', quality: 0.88 }));
  } catch {
    return URL.createObjectURL(blob);
  }
}

/** An artist's name versions from their artist.nfo, or null. */
export async function artistNameVersions(name, handle = null) {
  const info = await artistDetails(name, handle);
  if (!info || (!info.nameEn && !info.nameRom)) return null;
  return { orig: name, en: info.nameEn, rom: info.nameRom };
}
