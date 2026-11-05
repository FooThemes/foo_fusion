// Pictures for genre tiles: the genre's own picture (from its folder), or a
// collage of its biggest albums' covers: two side by side on a wide tile, a
// 2×2 grid on a square one.

import { artUrl } from '../data/artwork.js';
import { pictureUrl } from '../data/artistinfo.js';

const pictures = new Map(); // file path + size -> Promise<blob URL>
const collages = new Map(); // key -> Promise<blob URL | null>

/** The genre's own picture, scaled for display (cached). */
export function genrePictureUrl(file, px) {
  const key = `${file.path}|${px}`;
  if (!pictures.has(key)) pictures.set(key, pictureUrl(file, px));
  return pictures.get(key);
}

/** A collage of these tracks' covers, w × h CSS pixels (cached). */
export function collageUrl(handles, w, h) {
  const key = `${handles.join('|')}|${w}x${h}`;
  if (!collages.has(key)) {
    collages.set(key, make(handles, w, h).catch(() => null));
    if (collages.size > 300) collages.delete(collages.keys().next().value);
  }
  return collages.get(key);
}

export function forgetCollages() {
  pictures.clear();
  collages.clear();
}

async function make(handles, w, h) {
  if (!handles.length) return null;
  const dpr = window.devicePixelRatio || 1;
  const wide = w > h * 1.4;
  // Wide: two squares side by side; square: a 2×2 grid (fewer than four
  // covers: one fills it).
  // Try the four biggest albums; some may have no cover.
  const cell = wide ? h : w / 2;
  const urls = await Promise.all(handles.slice(0, 4).map((hd) => artUrl(hd, 'front', cell)));
  const images = (await Promise.all(urls.map(load))).filter(Boolean);
  if (!images.length) return null;
  const canvas = new OffscreenCanvas(Math.round(w * dpr), Math.round(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const draw = (im, x, y, s) => {
    // Cover the square, cropping the longer side.
    const r = Math.max(s / im.naturalWidth, s / im.naturalHeight);
    const sw = s / r;
    const sh = s / r;
    ctx.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, x * dpr, y * dpr, s * dpr, s * dpr);
  };
  if (wide) {
    // Two covers; with one, it fills the middle over a blurred copy of itself.
    if (images.length === 1) {
      ctx.filter = 'blur(18px) brightness(0.7)';
      ctx.drawImage(images[0], 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none';
      draw(images[0], (w - h) / 2, 0, h);
    } else {
      draw(images[0], 0, 0, h);
      draw(images[1], w - h, 0, h);
      if (w > 2 * h) draw(images[0], h, 0, w - 2 * h);
    }
  } else if (images.length >= 4) {
    images.slice(0, 4).forEach((im, i) => draw(im, (i % 2) * cell, Math.floor(i / 2) * cell, cell));
  } else {
    const first = urls.findIndex(Boolean);
    const big = await load(await artUrl(handles[first], 'front', w));
    draw(big || images[0], 0, 0, w);
  }
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 }));
}

function load(url) {
  if (!url) return Promise.resolve(null);
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.src = url;
  return im.decode().then(
    () => im,
    () => null,
  );
}
