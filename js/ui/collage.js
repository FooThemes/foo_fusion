// Pictures for genre tiles: the genre's own picture (from its folder), or a
// collage of its biggest albums' covers: rounded cards on a blurred backdrop.

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

// The look (square tiles): up to four covers as rounded cards with a soft
// shadow, on a dark background made from the covers themselves, blurred.
async function make(handles, w, h) {
  if (!handles.length) return null;
  const dpr = window.devicePixelRatio || 1;
  // Try the four biggest albums; some may have no cover.
  const urls = await Promise.all(handles.slice(0, 4).map((hd) => artUrl(hd, 'front', Math.ceil(w / 2))));
  const images = (await Promise.all(urls.map(load))).filter(Boolean);
  if (!images.length) return null;
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  // Background: the covers, stretched over quarters, heavily blurred and darkened.
  ctx.fillStyle = '#10141c';
  ctx.fillRect(0, 0, W, H);
  ctx.filter = `blur(${Math.round(W / 10)}px) saturate(1.3) brightness(0.55)`;
  images.forEach((im, i) => {
    const n = images.length;
    const col = n === 1 ? 0 : i % 2;
    const row = n <= 2 ? 0 : Math.floor(i / 2);
    const cw = n === 1 ? W : W / 2;
    const ch = n <= 2 ? H : H / 2;
    ctx.drawImage(im, col * cw - W * 0.1, row * ch - H * 0.1, cw + W * 0.2, ch + H * 0.2);
  });
  ctx.filter = 'none';
  // A gentle vignette, darker at the edges.
  const vig = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  // Cards: 2×2 (four covers), two on top and one below (three), two side by
  // side (two), or one in the middle. Each is turned a little, at random but
  // the same every time for these albums (it's seeded by them).
  const pad = Math.round(Math.min(W, H) * 0.08);
  const gap = Math.round(Math.min(W, H) * 0.055);
  const n = Math.min(4, images.length);
  const card = n === 1 ? Math.round(Math.min(W, H) * 0.7) : Math.round((Math.min(W, H) - pad * 2 - gap) / 2);
  const span = card * 2 + gap;
  const x0 = Math.round((W - span) / 2);
  const y0 = Math.round((H - span) / 2);
  const spots =
    n === 1
      ? [[(W - card) / 2, (H - card) / 2]]
      : n === 2
        ? [
            [x0, (H - card) / 2],
            [x0 + card + gap, (H - card) / 2],
          ]
        : n === 3
          ? [
              [x0, y0],
              [x0 + card + gap, y0],
              [(W - card) / 2, y0 + card + gap],
            ]
          : [
              [x0, y0],
              [x0 + card + gap, y0],
              [x0, y0 + card + gap],
              [x0 + card + gap, y0 + card + gap],
            ];
  const rand = seeded(handles.slice(0, n).join('|'));
  const radius = Math.max(2, Math.round(card * 0.035));
  images.slice(0, n).forEach((im, i) => {
    const [x, y] = spots[i];
    // Up to 4° either way.
    const turn = ((rand() * 2 - 1) * 4 * Math.PI) / 180;
    ctx.save();
    ctx.translate(x + card / 2, y + card / 2);
    ctx.rotate(turn);
    ctx.translate(-card / 2, -card / 2);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.round(card * 0.08);
    ctx.shadowOffsetY = Math.round(card * 0.025);
    roundRect(ctx, 0, 0, card, card, radius);
    ctx.fillStyle = '#222';
    ctx.fill();
    ctx.restore();
    roundRect(ctx, 0, 0, card, card, radius);
    ctx.clip();
    // Cover the card, cropping the longer side.
    const r = Math.max(card / im.naturalWidth, card / im.naturalHeight);
    const sw = card / r;
    const sh = card / r;
    ctx.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, 0, 0, card, card);
    // A hairline edge, as on records in a crate.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.stroke();
    ctx.restore();
  });
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/webp', quality: 0.88 }));
}

/** A small random-number generator seeded by a string (same string, same numbers). */
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
