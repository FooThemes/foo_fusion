// foobar2000's own album art search patterns (Preferences > Display > Album
// art), read from its config database, so Fusion picks the same cover file
// foobar2000 does. Only needed to know a cover's file type: foobar2000 shrinks
// covers to JPEG for display, which loses PNG transparency and GIF animation.

import { tryCall } from '../core/bridge.js';

// album_art_ids from the foobar2000 SDK.
const IDS = {
  front: 'F1E66F4E-FE09-4B94-91A3-67C23ED1445E',
  disc: '3DBA9F36-F928-4FA4-879C-D3404759587E',
};
// foobar2000's defaults, used if the config can't be read.
const DEFAULTS = {
  front: ['folder.jpg', 'cover.jpg', 'front.jpg', '*.jpg', 'folder.png', 'cover.png', 'front.png'],
  disc: ['disc.jpg', 'cd.jpg', 'disc.png', 'cd.png'],
};

let loaded = null;

/** { front: [...], disc: [...] } — patterns in foobar2000's order. */
export function artPatterns() {
  if (!loaded) loaded = read().catch(() => DEFAULTS);
  return loaded;
}

async function read() {
  const prof = await tryCall('misc.getProfilePath');
  const dir = (prof?.path || prof?.value || '').replace(/[\\/]$/, '');
  if (!dir) return DEFAULTS;
  const found = {};
  // The write-ahead log can hold a newer value than the main file.
  for (const path of [`${dir}\\config.sqlite`, `${dir}\\config.sqlite-wal`]) {
    const res = await tryCall('file.read', { path, encoding: 'binary' });
    if (!res?.content) continue;
    const bytes = fromBase64(res.content);
    for (const [type, id] of Object.entries(IDS)) {
      const v = lastValue(bytes, `albumArt.${id}.pattern`);
      if (v != null) found[type] = v;
    }
  }
  const out = {};
  for (const type of Object.keys(IDS)) {
    out[type] = found[type] != null ? found[type].split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : DEFAULTS[type];
  }
  return out;
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The text value stored with `key` in a (name, value) SQLite row: the record
 * header just before the key gives both column types, and the value follows
 * the key. Takes the last copy in the file (the newest page wins in a WAL).
 */
function lastValue(bytes, key) {
  const k = new TextEncoder().encode(key);
  let result = null;
  for (let i = indexOf(bytes, k, 0); i >= 0; i = indexOf(bytes, k, i + 1)) {
    for (let start = i - 2; start >= Math.max(0, i - 12); start--) {
      const h = varint(bytes, start);
      if (start + h.value !== i) continue;
      let p = start + h.size;
      const t1 = varint(bytes, p);
      p += t1.size;
      const t2 = varint(bytes, p);
      p += t2.size;
      if (p !== i || t1.value !== k.length * 2 + 13 || t2.value < 13 || t2.value % 2 === 0) continue;
      const len = (t2.value - 13) / 2;
      result = new TextDecoder().decode(bytes.subarray(i + k.length, i + k.length + len));
      break;
    }
  }
  return result;
}

function varint(bytes, p) {
  let value = 0;
  for (let n = 0; n < 9; n++) {
    const b = bytes[p + n];
    if (b === undefined) return { value: -1, size: n + 1 };
    if (n === 8) return { value: value * 256 + b, size: 9 };
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) return { value, size: n + 1 };
  }
  return { value, size: 9 };
}

function indexOf(hay, needle, from) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Which of a folder's pictures foobar2000 would use, following the patterns
 * in order. Patterns with title formatting (%…%) are evaluated for the track;
 * patterns with a path part (sub\x.jpg, ..\x.jpg) are skipped.
 */
export async function pickByPatterns(patterns, images, handle) {
  const byName = new Map(images.map((im) => [im.name.toLowerCase(), im]));
  for (let pat of patterns) {
    if (/[%$]/.test(pat)) {
      const r = await tryCall('titleformat.evalBatch', { paths: [handle], pattern: pat });
      pat = r?.results?.[0]?.result || '';
      if (!pat) continue;
    }
    if (/[\\/]/.test(pat)) continue;
    if (/[*?]/.test(pat)) {
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const hit = images.find((im) => re.test(im.name));
      if (hit) return hit;
      continue;
    }
    const hit = byName.get(pat.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
