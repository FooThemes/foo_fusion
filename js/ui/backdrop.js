// Blurred cover backgrounds (Now Playing, the open album's panel).
//
// A CSS blur of 40-60px over a full-size cover is one of the heaviest things
// WebView2 draws, and it is drawn again whenever anything above it moves.
// Instead the cover is blurred once into a tiny canvas, which the browser
// stretches to fill the space: stretching a small picture is itself a blur,
// so it looks the same and costs next to nothing to show.
//
// The <img> stays (hidden) so artwork.js loads covers into it as before; the
// canvas copies each new picture and its "loaded" state.

import { el } from '../core/util.js';
import * as store from '../core/store.js';

// Every backdrop's draw, to run again when the theme changes (light and dark
// want different brightness limits).
const drawers = new Set();
store.subscribe((k) => k === 'dark' && drawers.forEach((d) => d()));

// Canvas width; the blur is scaled to it (60px at ~1600px wide). Big enough
// that stretching it stays smooth (64 showed soft blocks when stretched 25x).
const W = 160;

export function softBackdrop(img, { blur = 60, at = 1600, saturate = 1.3 } = {}) {
  // Its pixels are read (keepReadable): the artwork handler allows that
  // when the picture is asked for this way.
  img.crossOrigin = 'anonymous';
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  canvas.className = img.className;
  img.classList.add('backdrop-src');
  img.after(canvas);
  const draw = () => {
    if (!img.naturalWidth) return;
    const h = Math.max(1, Math.round((W * img.naturalHeight) / img.naturalWidth));
    canvas.width = W;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const r = Math.max(1, (blur * W) / at);
    // Twice, half the radius each time: a softer, rounder blur than one pass
    // (no ring of the cover's edge colours), drawn past the edges so the
    // blur doesn't fade them to transparent.
    const o = Math.ceil(r * 3);
    const tmp = new OffscreenCanvas(W, h);
    const t = tmp.getContext('2d');
    t.filter = `blur(${(r * 0.7).toFixed(2)}px) saturate(${saturate})`;
    t.drawImage(img, -o, -o, W + o * 2, h + o * 2);
    ctx.filter = `blur(${(r * 0.7).toFixed(2)}px)`;
    ctx.drawImage(tmp, -o / 2, -o / 2, W + o, h + o);
    try {
      keepReadable(ctx, W, h);
    } catch {
      /* a picture that can't be read back: shown as it is */
    }
  };
  drawers.add(draw);
  img.addEventListener('load', draw);
  const sync = () => canvas.classList.toggle('loaded', img.classList.contains('loaded') && !!img.getAttribute('src'));
  new MutationObserver(sync).observe(img, { attributes: true, attributeFilter: ['class', 'src'] });
  if (img.complete) draw();
  sync();
  return canvas;
}

/**
 * Text sits on these backgrounds: a white cover (The Wall) made the dark
 * theme's background light grey, and its light text hard to read. So the
 * blurred picture is darkened (dark theme) or lightened (light theme) until
 * its average brightness is within a limit, keeping its colours.
 */
function keepReadable(ctx, w, h) {
  const dark = store.get('dark');
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const lum = sum / (px.length / 4) / 255;
  if (dark) {
    const MAX = 0.32;
    if (lum <= MAX) return;
    const k = MAX / lum;
    for (let i = 0; i < px.length; i += 4) {
      px[i] *= k;
      px[i + 1] *= k;
      px[i + 2] *= k;
    }
  } else {
    const MIN = 0.62;
    if (lum >= MIN) return;
    const k = (1 - MIN) / (1 - lum);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 255 - (255 - px[i]) * k;
      px[i + 1] = 255 - (255 - px[i + 1]) * k;
      px[i + 2] = 255 - (255 - px[i + 2]) * k;
    }
  }
  ctx.putImageData(data, 0, 0);
}

/**
 * A tile of fine noise laid over the soft backgrounds: a smooth gradient on
 * a screen has only so many shades, and shows bands between them; a little
 * grain hides the steps. Made once, as a data URL in --grain.
 */
export function installGrain() {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d');
  const data = ctx.createImageData(n, n);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = Math.round(Math.random() * 11); // faint: it only has to break up the steps
  }
  ctx.putImageData(data, 0, 0);
  // A data URL (not a blob: one), which any page setting allows.
  document.documentElement.style.setProperty('--grain', `url(${c.toDataURL('image/png')})`);
}
