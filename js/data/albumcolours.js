// Colours taken from album art, as the original Fusion did for its expanded
// album view: a background from the cover's main colour, and a title colour
// from its most vivid colour that still stands out against that background.

import { tryCall } from '../core/bridge.js';
import { logInfo } from '../core/log.js';

let warned = false;

const cache = new Map(); // handle -> Promise<palette|null>
const SIZE = 40; // sample grid; plenty for picking colours

export function albumColours(handle, img) {
  if (!handle) return Promise.resolve(null);
  if (!cache.has(handle)) {
    cache.set(
      handle,
      extract(handle, img).catch((err) => {
        if (!warned) {
          warned = true;
          logInfo(`album colours failed: ${err?.message || err}`);
        }
        return null;
      }),
    );
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  return cache.get(handle);
}

async function extract(handle, img) {
  let pixels = null;
  // The cover on screen is quickest, if the browser lets us read it.
  // Only use the <img> once it shows this album (not the previous one).
  const ours = () => img && (img.dataset.artToken || '').startsWith(handle + '|');
  if (ours() && !(img.complete && img.naturalWidth && img.classList.contains('loaded'))) {
    await new Promise((resolve) => {
      const done = () => (img.removeEventListener('load', done), img.removeEventListener('error', done), resolve());
      img.addEventListener('load', done);
      img.addEventListener('error', done);
      setTimeout(done, 2500);
    });
  }
  if (ours() && img.complete && img.naturalWidth) pixels = read(img);
  if (!pixels) {
    for (const type of ['front', 'disc']) {
      const res = await tryCall('artwork.getByPath', { path: handle, type });
      if (!res?.available || !res.dataUrl) continue;
      // Decode the data URL by hand: the page's security policy may not let
      // fetch() read data: URLs.
      const comma = res.dataUrl.indexOf(',');
      const bin = atob(res.dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: res.mimeType || 'image/jpeg' });
      const bmp = await createImageBitmap(blob, { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'medium' });
      pixels = read(bmp);
      bmp.close();
      if (pixels) break;
    }
  }
  if (!pixels) throw new Error('no readable cover (canvas blocked and no embedded/folder art via getByPath)');
  return palette(pixels);
}

function read(source) {
  try {
    const c = new OffscreenCanvas(SIZE, SIZE);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, SIZE, SIZE);
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return null; // cross-origin image: fall back to reading the bytes
  }
}

function palette(data) {
  // Bucket colours (4 bits per channel) and weigh how common each is.
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++;
    b.r += data[i];
    b.g += data[i + 1];
    b.b += data[i + 2];
    buckets.set(key, b);
  }
  const colours = [...buckets.values()].map((b) => ({ n: b.n, rgb: [b.r / b.n, b.g / b.n, b.b / b.n] })).sort((a, b) => b.n - a.n);
  if (!colours.length) return null;

  // Background: the most common colour, toned down so text stays readable.
  let bg = colours[0].rgb;
  const [h, s, l] = toHsl(bg);
  bg = fromHsl(h, Math.min(s, 0.55), l > 0.5 ? Math.max(0.78, Math.min(l, 0.9)) : Math.min(Math.max(l, 0.1), 0.24));
  const dark = luminance(bg) < 0.35;
  const text = dark ? [240, 240, 240] : [24, 24, 24];

  // Title/accent: a vivid, reasonably common colour with enough contrast.
  let accent = null;
  let best = 0;
  for (const c of colours.slice(0, 40)) {
    const [, cs, cl] = toHsl(c.rgb);
    const ratio = contrast(c.rgb, bg);
    if (ratio < 3) continue;
    const score = cs * 2 + Math.log(c.n + 1) * 0.3 + Math.min(ratio, 7) * 0.1 - Math.abs(cl - 0.5) * 0.5;
    if (score > best) {
      best = score;
      accent = c.rgb;
    }
  }
  if (!accent) {
    // Push the main colour's hue to a lightness that contrasts.
    accent = fromHsl(h, Math.max(s, 0.45), dark ? 0.72 : 0.32);
  }
  return {
    bg: hex(bg),
    text: hex(text),
    text2: hex(mix(text, bg, 0.62)),
    accent: hex(accent),
    accentText: luminance(accent) > 0.6 ? '#111111' : '#ffffff',
    dark,
  };
}

const lin = (v) => {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
function luminance([r, g, b]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function mix(a, b, t) {
  return a.map((v, i) => v * t + b[i] * (1 - t));
}
function hex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
function toHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h, s, l) {
  const f = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
}
