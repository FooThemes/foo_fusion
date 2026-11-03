// Album and artist art.
//
// foo_ui_webview2 can hand out fb2k://artwork/ URLs that it resolves (and
// scales) lazily when an <img> loads them, so no image bytes cross the bridge.
// Requests made in the same frame are batched into one host call (up to 100
// entries each), and URLs are cached for the session.

import { tryCall } from '../core/bridge.js';
import { logInfo } from '../core/log.js';
import { artPatterns, pickByPatterns } from './artpatterns.js';
import { artistFolder, artistFiles, pictureUrl } from './artistinfo.js';
import { cachedUrl, isCachedAlpha, forget, storeCover, knownCover, rememberCover, clearArtCache } from './artcache.js';

const cache = new Map(); // key -> Promise<string|null>
const resolved = new Map(); // key -> string|null, once known (for instant reuse)
const loadedUrls = new Set(); // URLs the browser has already decoded once
// Holding an Image per loaded URL keeps it in the browser's in-memory image
// cache, so a tile that is handed an album seen before shows it the same
// frame instead of fetching fb2k:// again (that refetch was the "flash").
const keepAlive = new Map(); // url -> HTMLImageElement, oldest first
const KEEP = 1500; // small covers (mostly the disk cache's copies)
function markLoaded(url, decoded = null) {
  loadedUrls.add(url);
  if (keepAlive.has(url)) {
    const im = keepAlive.get(url);
    keepAlive.delete(url);
    keepAlive.set(url, im);
    return;
  }
  const im = decoded || new Image();
  if (!decoded) im.src = url;
  keepAlive.set(url, im);
  while (keepAlive.size > KEEP) {
    const [old] = keepAlive.keys();
    keepAlive.delete(old);
    loadedUrls.delete(old);
  }
}
let pending = []; // { key, path, type, size, resolve }
let scheduled = false;

// Bucket sizes so a resize doesn't create a new URL for every pixel.
const BUCKETS = [96, 160, 240, 320, 480, 640, 960, 1400];

export function sizeBucket(cssPx) {
  const px = Math.ceil(cssPx * (window.devicePixelRatio || 1));
  return BUCKETS.find((b) => b >= px) || BUCKETS[BUCKETS.length - 1];
}

/**
 * Resolve an artwork URL for a track handle (path, optionally with |subsong:N).
 * type: front | back | disc | artist. Resolves to null when none can be built.
 */
export function artUrl(path, type = 'front', cssSize = 200) {
  if (!path) return Promise.resolve(null);
  const size = sizeBucket(cssSize);
  const key = `${type}|${size}|${path}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise((resolve) => pending.push({ path, type, size, resolve })).then((url) => {
      resolved.set(key, url);
      return url;
    });
    cache.set(key, p);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  }
  return p;
}

// --- Transparent and animated covers ---------------------------------------
// foobar2000's artwork handler scales pictures to JPEG, which turns a PNG's
// transparent background black and freezes a GIF on its first frame. So for
// albums whose folder cover is a .png or .gif, Fusion asks for the original
// picture instead (the browser scales it). Which folders those are is found
// by listing the folder once (cached).

const dirKind = new Map(); // folder -> 'keep' (png/gif) | 'scale'
const rawUrls = new Set(); // URLs of unscaled PNG/GIF pictures (may be transparent)

/** Is this an unscaled PNG/GIF picture (shown without a backing square)? */
export function isRawUrl(url) {
  return rawUrls.has(url);
}
const dirProbe = new Map(); // folder -> Promise
let probing = 0;
let probeLogs = 40; // folders with PNG/GIF pictures to note in fusion.log
const probeQueue = [];

function dirOf(handle) {
  const p = handle.replace(/\|subsong:\d+$/, '');
  const i = p.lastIndexOf('\\');
  return i > 0 ? p.slice(0, i) : '';
}

/** Should this track's front cover be loaded unscaled? (undefined = not known yet) */
export function keepOriginal(handle) {
  const dir = dirOf(handle);
  if (dirKind.has(dir)) return dirKind.get(dir) === 'keep';
  const known = knownCover(dir); // remembered from an earlier session
  if (known === undefined) return undefined;
  return !!known && /\.(png|gif)$/i.test(known.name);
}

const dirPick = new Map(); // folder -> its cover file { name, path, size } | null (this session)

/** The cover file for a track's 'front' or 'parent' art: object, null (none) or undefined (unknown). */
function coverFile(type, handle) {
  if (type === 'front') {
    const dir = dirOf(handle);
    return dirPick.has(dir) ? dirPick.get(dir) : knownCover(dir);
  }
  if (type === 'parent') {
    const { parent, folder } = splitPath(handle);
    if (!parent || !DISC_DIR.test(folder)) return null;
    return dirPick.has(parent) ? dirPick.get(parent) : knownCover(parent);
  }
  if (type.startsWith('info:')) {
    // A picture in the artist information folder (see artistinfo.js).
    const dir = artistFolder(type.slice(5));
    if (!dir) return null;
    return dirPick.has(dir) ? dirPick.get(dir) : knownCover(dir);
  }
  if (type === 'artist') {
    // foobar2000 finds artist pictures itself; the cache keys them by track.
    const k = 'artist:' + handle;
    return dirPick.has(k) ? dirPick.get(k) : knownCover(k);
  }
  return undefined;
}

/** Note whether foobar2000 had an artist picture for this track. */
function noteArtist(handle, found) {
  const k = 'artist:' + handle;
  const pick = found ? { name: 'artist.jpg', path: k + '\\artist.jpg', size: 0 } : null;
  dirPick.set(k, pick);
  rememberCover(k, pick);
}

function probeDir(dir, sample) {
  if (!dir) return Promise.resolve('scale');
  if (!dirProbe.has(dir)) {
    dirProbe.set(
      dir,
      new Promise((resolve) => {
        probeQueue.push(async () => {
          const res = await tryCall('artwork.getFolderImages', { directory: dir });
          const images = res?.images || [];
          const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
          // The file foobar2000 itself would use, by its search patterns.
          const pick = await pickByPatterns((await artPatterns()).front, images, sample);
          const kind = pick && /\.(png|gif)$/i.test(pick.name) ? 'keep' : 'scale';
          if (probeLogs-- > 0 && images.some((im) => /\.(png|gif)$/i.test(im.name))) logInfo(`cover check ${dir.split('\\').pop()}: [${images.map((im) => im.name).join(', ')}] -> ${pick?.name || 'none'} (${kind})`);
          dirKind.set(dir, kind);
          dirPick.set(dir, pick ? { name: pick.name, path: pick.path, size: pick.size } : null);
          rememberCover(dir, pick);
          resolve(kind);
        });
        pumpProbes();
      }),
    );
  }
  return dirProbe.get(dir);
}

function pumpProbes() {
  while (probing < 4 && probeQueue.length) {
    probing++;
    probeQueue
      .shift()()
      .finally(() => {
        probing--;
        pumpProbes();
      });
  }
}

/** The unscaled picture's URL (keeps transparency and animation). */
export function originalUrl(path, type = 'front') {
  const key = `${type}|0|${path}`;
  let p = cache.get(key);
  if (!p) {
    p = tryCall('artwork.getFb2kUrlByPath', { path, type, maxSize: 0 }).then((r) => {
      const url = r?.available ? r.dataUrl : null;
      if (url) rawUrls.add(url);
      resolved.set(key, url);
      return url;
    });
    cache.set(key, p);
  }
  return p;
}

async function flush() {
  scheduled = false;
  const jobs = pending;
  pending = [];
  for (let i = 0; i < jobs.length; i += 100) {
    const chunk = jobs.slice(i, i + 100);
    const res = await tryCall('artwork.getFb2kUrlByPathBatch', {
      items: chunk.map((j) => ({ path: j.path, type: j.type, maxSize: j.size })),
    });
    const rows = res?.artworks || [];
    chunk.forEach((j, n) => j.resolve(rows[n]?.available ? rows[n].dataUrl : null));
  }
}

// --- Box-set covers -------------------------------------------------------
// Multi-disc releases often keep each disc in its own folder ("CD1", "Disc 2 -
// Acoustic", ...) with the box-set cover one level up. foobar2000 only looks
// next to the track, so Fusion checks the parent folder itself.

const DISC_DIR = /^(cd|dis[ck]|dvd|vol(ume)?\.?)\s*[-_.#]?\s*\d+|^\d{1,2}$/i;
const COVER_NAMES = ['cover', 'folder', 'front', 'albumart', 'album'];
const parentCache = new Map(); // parent dir + size -> Promise<string|null>
const parentResolved = new Map(); // same key -> string|null once known

function splitPath(handle) {
  const p = handle.replace(/\|subsong:\d+$/, '');
  const i = p.lastIndexOf('\\');
  const dir = i > 0 ? p.slice(0, i) : '';
  const j = dir.lastIndexOf('\\');
  return { dir, parent: j > 0 ? dir.slice(0, j) : '', folder: j > 0 ? dir.slice(j + 1) : dir };
}

/**
 * Art to try for an album tile or the expanded album. Combined albums prefer
 * the box-set cover above the disc folders; with "Separate albums by disc"
 * each disc is its own album, so its own cover comes first.
 */
export function albumArtTypes(separateDiscs) {
  return separateDiscs ? ['front', 'parent'] : ['parent', 'front'];
}

const infoUrls = new Map(); // picture path + size -> Promise<blob URL>
function infoUrl(pick, px) {
  const key = `${pick.path}|${px}`;
  if (!infoUrls.has(key)) infoUrls.set(key, pictureUrl(pick, px).then((u) => (u && /\.(png|gif|webp)$/i.test(pick.name) && rawUrls.add(u), u)));
  return infoUrls.get(key);
}

/** URL of a cover in the folder above a disc folder, or null. */
export function parentCoverUrl(handle, cssSize) {
  if (!handle) return Promise.resolve(null);
  const { parent, folder } = splitPath(handle);
  if (!parent || !DISC_DIR.test(folder)) return Promise.resolve(null);
  const key = `${parent}|${sizeBucket(cssSize)}`;
  if (!parentCache.has(key)) {
    parentCache.set(
      key,
      loadParentCover(parent, sizeBucket(cssSize)).then((url) => {
        parentResolved.set(key, url);
        return url;
      }),
    );
  }
  return parentCache.get(key);
}

/** undefined: not checked yet; null: no box-set cover; otherwise its URL. */
function parentReady(handle, cssSize) {
  const { parent, folder } = splitPath(handle);
  if (!parent || !DISC_DIR.test(folder)) return null;
  return parentResolved.get(`${parent}|${sizeBucket(cssSize)}`);
}

async function loadParentCover(dir, px) {
  const res = await tryCall('artwork.getFolderImages', { directory: dir });
  const images = res?.images || [];
  if (!images.length) return null;
  const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
  const pick =
    (await pickByPatterns((await artPatterns()).front.filter((p) => !/[%$]/.test(p)), images, null)) ||
    COVER_NAMES.map((c) => images.find((im) => base(im.name) === c)).find(Boolean) ||
    (images.length === 1 ? images[0] : null);
  dirPick.set(dir, pick ? { name: pick.name, path: pick.path, size: pick.size } : null);
  rememberCover(dir, pick);
  if (!pick) return null;
  const file = await tryCall('file.read', { path: pick.path, encoding: 'binary' });
  if (!file?.content) return null;
  let bin;
  try {
    bin = atob(file.content);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // PNG/GIF: keep the original (transparency, animation).
  if (/\.(png|gif)$/i.test(pick.name)) {
    const url = URL.createObjectURL(new Blob([bytes], { type: /\.gif$/i.test(pick.name) ? 'image/gif' : 'image/png' }));
    rawUrls.add(url);
    return url;
  }
  // Scale down once, so a 3000px scan doesn't sit in memory per tile.
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const scale = Math.min(1, px / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }));
  } catch {
    return URL.createObjectURL(new Blob([bytes]));
  }
}

/** Art for the playing track (cached per track by the caller). */
export async function nowPlayingUrl(cssSize, type = 'front', handle = null) {
  // PNG/GIF folder covers unscaled, as for the grid.
  const keep = handle && type === 'front' && (keepOriginal(handle) ?? (await probeDir(dirOf(handle), handle)) === 'keep');
  const res = await tryCall('artwork.getFb2kUrl', { type, maxSize: keep ? 0 : sizeBucket(cssSize) });
  const url = res?.available ? res.dataUrl : null;
  if (url && keep) rawUrls.add(url);
  return url;
}

export function clearCache() {
  clearArtCache();
  dirPick.clear();
  cache.clear();
  parentCache.clear();
  parentResolved.clear();
  dirKind.clear();
  dirProbe.clear();
  resolved.clear();
  loadedUrls.clear();
  keepAlive.clear();
}

function readyRaw(path, type) {
  const url = resolved.get(`${type}|0|${path}`);
  return url && loadedUrls.has(url) ? url : null;
}

/**
 * Fetch and decode a cover ahead of time (e.g. every disc of the open album),
 * so a later bindArt for it shows it in the same frame.
 */
export async function preloadArt(path, cssSize, types = ['front']) {
  for (const type of types) {
    const keep = type === 'front' && keepOriginal(path);
    let url;
    if (type.startsWith('info:')) {
      const files = await artistFiles(type.slice(5));
      const pick = files?.picture || null;
      if (files) {
        dirPick.set(files.dir, pick && { name: pick.name, path: pick.path, size: pick.size });
        rememberCover(files.dir, pick);
      }
      url = pick ? await infoUrl(pick, sizeBucket(cssSize)) : null;
    } else url = type === 'parent' ? await parentCoverUrl(path, cssSize) : keep ? await originalUrl(path, type) : await artUrl(path, type, cssSize);
    if (!url) continue;
    if (loadedUrls.has(url)) return;
    const im = new Image();
    im.crossOrigin = 'anonymous'; // same request mode as the expanded album's cover
    im.src = url;
    try {
      await im.decode();
      markLoaded(url, im);
    } catch {
      /* try the next type */
      continue;
    }
    return;
  }
}

/**
 * Decode, in idle moments, the disk-cached covers of a whole list (e.g. every
 * album of the playlist on screen), so tiles that appear later, or after a
 * playlist switch, show their covers in the first frame instead of fading in.
 */
const warmQueue = [];
const warmSeen = new Set();
let warming = false;
export function warmArt(handles, cssSize, types) {
  const px = sizeBucket(cssSize);
  for (const h of handles) {
    if (!h) continue;
    for (const t of types) {
      const pick = coverFile(t, h);
      if (pick === undefined) break;
      if (pick === null) {
        if (t === 'parent' || t === 'artist' || t.startsWith('info:')) continue;
        break;
      }
      const url = cachedUrl(pick, px, false);
      if (url && !loadedUrls.has(url) && !warmSeen.has(url)) {
        warmSeen.add(url);
        warmQueue.push(url);
      }
      break;
    }
  }
  if (!warming) warmNext();
}

function warmNext() {
  const url = warmQueue.shift();
  if (!url) {
    warming = false;
    return;
  }
  warming = true;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 30));
  idle(() => {
    const im = new Image();
    im.src = url;
    im.decode().then(
      () => (markLoaded(url, im), warmNext()),
      () => warmNext(),
    );
  });
}

/** Synchronous lookup: the URL if it is already known and decoded. */
function readyUrl(path, type, cssSize) {
  const url = resolved.get(`${type}|${sizeBucket(cssSize)}|${path}`);
  return url && loadedUrls.has(url) ? url : null;
}

/**
 * Point an <img> at a track's art. Falls back through `types` in order, then
 * leaves the element's placeholder showing. Ignores late answers if the
 * element has since been reused for another track.
 */
export function bindArt(img, path, cssSize, types = ['front']) {
  const token = `${path}|${types.join(',')}|${cssSize}`;
  if (img.dataset.artToken === token) return;
  img.dataset.artToken = token;
  // Already decoded once (e.g. the same album after a re-sort): show it at
  // once, with no fade, so tiles don't flash.
  let ready = null;
  for (const t of types) {
    const r = t === 'parent' ? parentReady(path, cssSize) : t === 'front' && keepOriginal(path) ? readyRaw(path, t) : readyUrl(path, t, cssSize);
    if (r === undefined) break; // still unknown: load normally
    if (r) {
      ready = r;
      break;
    }
    if (t !== 'parent') break; // a normal type that isn't decoded yet
  }
  // A small copy saved on disk by an earlier session.
  if (!ready) {
    for (const t of types) {
      const pick = coverFile(t, path);
      if (pick === undefined) break;
      if (pick === null) {
        if (t === 'parent' || t === 'artist' || t.startsWith('info:')) continue; // none of this kind: the next type
        break;
      }
      const disk = cachedUrl(pick, sizeBucket(cssSize));
      if (!disk) break;
      const instant = loadedUrls.has(disk);
      img.onload = () => {
        markLoaded(disk);
        if (img.dataset.artToken === token) img.classList.add('loaded');
      };
      img.onerror = () => {
        // The copy is gone (cache cleared by hand?): forget it, load normally.
        forget(pick, sizeBucket(cssSize));
        if (img.dataset.artToken !== token) return;
        delete img.dataset.artToken;
        bindArt(img, path, cssSize, types);
      };
      img.classList.toggle('alpha', isCachedAlpha(pick, sizeBucket(cssSize)));
      img.classList.toggle('instant', instant);
      img.classList.toggle('loaded', instant);
      img.decoding = instant ? 'sync' : 'async';
      img.src = disk;
      // Check the folder again in the background (a cover may have changed).
      if (t === 'front' && !dirPick.has(dirOf(path))) probeDir(dirOf(path), path);
      return;
    }
  }
  if (ready) {
    img.onload = img.onerror = null;
    img.decoding = 'sync';
    img.classList.toggle('alpha', rawUrls.has(ready));
    img.src = ready;
    markLoaded(ready);
    img.classList.add('loaded', 'instant');
    return;
  }
  img.classList.remove('loaded', 'instant', 'alpha');
  img.decoding = 'async';
  img.removeAttribute('src');
  const attempt = async (i) => {
    if (i >= types.length || img.dataset.artToken !== token) return;
    const type = types[i];
    const keep = type === 'front' && keepOriginal(path);
    let url;
    if (type.startsWith('info:')) {
      const files = await artistFiles(type.slice(5));
      const pick = files?.picture || null;
      if (files) {
        dirPick.set(files.dir, pick && { name: pick.name, path: pick.path, size: pick.size });
        rememberCover(files.dir, pick);
      }
      url = pick ? await infoUrl(pick, sizeBucket(cssSize)) : null;
    } else url = type === 'parent' ? await parentCoverUrl(path, cssSize) : keep ? await originalUrl(path, type) : await artUrl(path, type, cssSize);
    // Folder not checked yet: find out, and switch to the original if it's a PNG/GIF.
    if (type === 'front' && keep === undefined && url) {
      probeDir(dirOf(path), path).then(async (kind) => {
        if (kind !== 'keep' || img.dataset.artToken !== token) return;
        const raw = await originalUrl(path, type);
        if (!raw || img.dataset.artToken !== token) return;
        const pre = new Image();
        pre.src = raw;
        pre.decode().then(
          () => {
            if (img.dataset.artToken !== token) return;
            img.src = raw;
            img.classList.add('alpha');
            markLoaded(raw);
            const pick = coverFile('front', path);
            if (pick) storeCover(pick, sizeBucket(cssSize), raw, true);
          },
          () => {},
        );
      });
    }
    if (type === 'artist') noteArtist(path, !!url);
    if (img.dataset.artToken !== token) return;
    if (!url) return attempt(i + 1);
    img.classList.toggle('alpha', rawUrls.has(url));
    img.onload = () => {
      markLoaded(url);
      if (img.dataset.artToken === token) img.classList.add('loaded');
      // Keep a small copy on disk for next time (once the cover file is known).
      const save = () => {
        const pick = coverFile(type, path);
        // A PNG shown from foobar2000's JPEG copy has lost its transparency;
        // the full PNG (swapped in below) is the one to keep.
        if (pick && !(/\.png$/i.test(pick.name) && !rawUrls.has(url))) storeCover(pick, sizeBucket(cssSize), url, rawUrls.has(url));
      };
      if (coverFile(type, path) === undefined && type === 'front') probeDir(dirOf(path), path).then(save);
      else save();
    };
    img.onerror = () => {
      if (type === 'artist') noteArtist(path, false); // URL built, but no picture
      if (img.dataset.artToken === token) attempt(i + 1);
    };
    img.src = url;
  };
  attempt(0);
}
