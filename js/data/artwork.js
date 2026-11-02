// Album and artist art.
//
// foo_ui_webview2 can hand out fb2k://artwork/ URLs that it resolves (and
// scales) lazily when an <img> loads them, so no image bytes cross the bridge.
// Requests made in the same frame are batched into one host call (up to 100
// entries each), and URLs are cached for the session.

import { tryCall } from '../core/bridge.js';

const cache = new Map(); // key -> Promise<string|null>
const resolved = new Map(); // key -> string|null, once known (for instant reuse)
const loadedUrls = new Set(); // URLs the browser has already decoded once
// Holding an Image per loaded URL keeps it in the browser's in-memory image
// cache, so a tile that is handed an album seen before shows it the same
// frame instead of fetching fb2k:// again (that refetch was the "flash").
const keepAlive = new Map(); // url -> HTMLImageElement, oldest first
const KEEP = 400;
function markLoaded(url) {
  loadedUrls.add(url);
  if (keepAlive.has(url)) {
    const im = keepAlive.get(url);
    keepAlive.delete(url);
    keepAlive.set(url, im);
    return;
  }
  const im = new Image();
  im.src = url;
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
  const pick = COVER_NAMES.map((c) => images.find((im) => base(im.name) === c)).find(Boolean) || (images.length === 1 ? images[0] : null);
  if (!pick) return null;
  const file = await tryCall('file.read', { path: pick.path, encoding: 'binary' });
  if (!file?.content) return null;
  const bin = atob(file.content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
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
export async function nowPlayingUrl(cssSize, type = 'front') {
  const res = await tryCall('artwork.getFb2kUrl', { type, maxSize: sizeBucket(cssSize) });
  return res?.available ? res.dataUrl : null;
}

export function clearCache() {
  cache.clear();
  parentCache.clear();
  parentResolved.clear();
  resolved.clear();
  loadedUrls.clear();
  keepAlive.clear();
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
    const r = t === 'parent' ? parentReady(path, cssSize) : readyUrl(path, t, cssSize);
    if (r === undefined) break; // still unknown: load normally
    if (r) {
      ready = r;
      break;
    }
    if (t !== 'parent') break; // a normal type that isn't decoded yet
  }
  if (ready) {
    img.onload = img.onerror = null;
    img.decoding = 'sync';
    img.src = ready;
    markLoaded(ready);
    img.classList.add('loaded', 'instant');
    return;
  }
  img.classList.remove('loaded', 'instant');
  img.decoding = 'async';
  img.removeAttribute('src');
  const attempt = async (i) => {
    if (i >= types.length || img.dataset.artToken !== token) return;
    const url = types[i] === 'parent' ? await parentCoverUrl(path, cssSize) : await artUrl(path, types[i], cssSize);
    if (img.dataset.artToken !== token) return;
    if (!url) return attempt(i + 1);
    img.onload = () => {
      markLoaded(url);
      if (img.dataset.artToken === token) img.classList.add('loaded');
    };
    img.onerror = () => img.dataset.artToken === token && attempt(i + 1);
    img.src = url;
  };
  attempt(0);
}
