// Album and artist art.
//
// foo_ui_webview2 can hand out fb2k://artwork/ URLs that it resolves (and
// scales) lazily when an <img> loads them, so no image bytes cross the bridge.
// Requests made in the same frame are batched into one host call (up to 100
// entries each), and URLs are cached for the session.

import { tryCall } from '../core/bridge.js';

const cache = new Map(); // key -> Promise<string|null>
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
    p = new Promise((resolve) => pending.push({ path, type, size, resolve }));
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

/** Art for the playing track (cached per track by the caller). */
export async function nowPlayingUrl(cssSize, type = 'front') {
  const res = await tryCall('artwork.getFb2kUrl', { type, maxSize: sizeBucket(cssSize) });
  return res?.available ? res.dataUrl : null;
}

export function clearCache() {
  cache.clear();
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
  img.classList.remove('loaded');
  img.removeAttribute('src');
  const attempt = async (i) => {
    if (i >= types.length || img.dataset.artToken !== token) return;
    const url = await artUrl(path, types[i], cssSize);
    if (img.dataset.artToken !== token) return;
    if (!url) return attempt(i + 1);
    img.onload = () => img.dataset.artToken === token && img.classList.add('loaded');
    img.onerror = () => img.dataset.artToken === token && attempt(i + 1);
    img.src = url;
  };
  attempt(0);
}
