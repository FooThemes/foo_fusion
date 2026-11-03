// On-disk cache of shrunk album covers.
//
// Covers are often large (100 KB–1 MB, some scans far bigger). foobar2000
// shrinks them for display, but only in memory and only for the session, so
// every start reads and decodes the originals again; and PNG covers are loaded
// at full size to keep their transparency. Fusion keeps small WebP copies
// (transparency kept) in an "art-cache" folder inside its own template
// folder. The page can load those directly, as plain files, so after the
// first time a cover costs a small file read.
//
// Each copy is named after the cover file's path and size (so a replaced
// cover gets a new copy) and the display size it was made for. An index
// (art-cache/index.json) lists what's there and which file is each album
// folder's cover, so a start needs no folder listings for albums seen before.

import { tryCall } from '../core/bridge.js';
import { logInfo } from '../core/log.js';
import { hash } from '../core/util.js';

const FOLDER = 'art-cache';
let base = null; // Windows path of the cache folder, or null when unavailable
let index = { v: 1, gen: 1, dirs: {}, files: {} };
let ready = null;
let dirty = false;
let saveTimer = 0;
const stats = { hits: 0, made: 0, failed: 0 };

/** Load the index (once). Resolves to whether the cache can be used. */
export function initArtCache() {
  if (!ready) ready = load().catch(() => false);
  return ready;
}

async function load() {
  const src = await tryCall('webview.getSource');
  if (!src?.directory) return false;
  base = `${src.directory.replace(/[\\/]$/, '')}\\${FOLDER}`;
  try {
    const res = await fetch(`/${FOLDER}/index.json`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data?.v === 1) index = { gen: 1, dirs: {}, files: {}, ...data };
    }
  } catch {
    /* first run: no index yet */
  }
  setTimeout(() => logInfo(`art cache: ${Object.keys(index.files).length} covers, ${Object.keys(index.dirs).length} folders known`), 3000);
  setInterval(() => {
    if (stats.hits || stats.made || stats.failed) {
      logInfo(`art cache: ${stats.hits} served from cache, ${stats.made} added, ${stats.failed} failed`);
      stats.hits = stats.made = stats.failed = 0;
    }
  }, 60000);
  return true;
}

export const cacheReady = () => base != null;

/** Cover file remembered for a folder: { name, size } | null (none) | undefined (unknown). */
export function knownCover(dir) {
  const d = index.dirs[dir];
  return d === undefined ? undefined : d ? { name: d[0], size: d[1], path: `${dir}\\${d[0]}` } : null;
}

export function rememberCover(dir, pick) {
  if (!base) return;
  const v = pick ? [pick.name, pick.size || 0] : 0;
  const cur = index.dirs[dir];
  if (JSON.stringify(cur) === JSON.stringify(v)) return;
  index.dirs[dir] = v;
  scheduleSave();
}

function keyFor(pick, px) {
  const id = `${pick.path.toLowerCase()}|${pick.size || 0}`;
  return `${hash(id).toString(36)}${hash(id + '#').toString(36)}-${px}`;
}

/** URL of the cached copy of this cover at this size, or null. */
const SIZES = [96, 160, 240, 320, 480, 640, 960, 1400]; // artwork.js buckets

/** The copy made for this size, or else the nearest bigger one (scaled down
 *  by the browser), so a cover seen at one size isn't fetched again for another. */
function bestKey(pick, px) {
  const exact = keyFor(pick, px);
  if (index.files[exact]) return exact;
  for (const s of SIZES) {
    if (s <= px) continue;
    const k = keyFor(pick, s);
    if (index.files[k]) return k;
  }
  return null;
}

export function cachedUrl(pick, px, count = true) {
  if (!base || !pick) return null;
  const key = bestKey(pick, px);
  if (!key) return null;
  if (count) stats.hits++;
  return `/${FOLDER}/${index.gen}/${key}.webp`;
}

export function isCachedAlpha(pick, px) {
  const key = pick && bestKey(pick, px);
  return !!key && index.files[key] === 'a';
}

/** A cached copy turned out to be missing: forget it. */
export function forget(pick, px) {
  if (!pick) return;
  delete index.files[keyFor(pick, px)];
  scheduleSave();
}

// Making copies: one at a time, when the page is idle.
const queue = [];
const queued = new Set();
let working = false;

/** Make a cached copy of `url` (an image already on screen) for this cover. */
export function storeCover(pick, px, url, alpha) {
  if (!base || !pick || /\.gif$/i.test(pick.name)) return; // GIFs may be animated
  const key = keyFor(pick, px);
  if (index.files[key] || queued.has(key)) return;
  queued.add(key);
  queue.push({ key, px, url, alpha });
  pump();
}

function pump() {
  if (working || !queue.length) return;
  working = true;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(async () => {
    const job = queue.shift();
    try {
      await make(job);
      stats.made++;
    } catch {
      stats.failed++;
    }
    queued.delete(job.key);
    working = false;
    pump();
  });
}

async function make({ key, px, url, alpha }) {
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.src = url;
  await im.decode();
  const scale = Math.min(1, px / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * scale));
  const h = Math.max(1, Math.round(im.naturalHeight * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(im, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
  const b64 = await blobToBase64(blob);
  const res = await tryCall('file.write', { path: `${base}\\${index.gen}\\${key}.webp`, content: 'base64:' + b64, encoding: 'binary' });
  if (!res) throw new Error('write failed');
  index.files[key] = alpha ? 'a' : 1;
  scheduleSave();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 3000);
}

async function save() {
  if (!dirty || !base) return;
  dirty = false;
  await tryCall('file.write', { path: `${base}\\index.json`, content: JSON.stringify(index), atomic: true });
}

/** "Refresh artwork": start a fresh cache and delete the old copies. */
export async function clearArtCache() {
  if (!base) return;
  const old = `${base}\\${index.gen}`;
  index = { v: 1, gen: index.gen + 1, dirs: {}, files: {} };
  dirty = true;
  await save();
  const list = await tryCall('file.list', { path: old });
  for (const f of list?.files || []) await tryCall('file.delete', { path: `${old}\\${f}`, moveToTrash: false });
  await tryCall('file.delete', { path: old, moveToTrash: false });
}
