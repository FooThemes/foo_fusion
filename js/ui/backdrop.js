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

const W = 64; // canvas width; the blur is scaled to it (60px at ~1600px wide)

export function softBackdrop(img, { blur = 60, at = 1600, saturate = 1.3 } = {}) {
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
    ctx.filter = `blur(${r.toFixed(2)}px) saturate(${saturate})`;
    // Drawn past the edges, so the blur doesn't fade them to transparent.
    const o = Math.ceil(r * 2);
    ctx.drawImage(img, -o, -o, W + o * 2, h + o * 2);
  };
  img.addEventListener('load', draw);
  const sync = () => canvas.classList.toggle('loaded', img.classList.contains('loaded') && !!img.getAttribute('src'));
  new MutationObserver(sync).observe(img, { attributes: true, attributeFilter: ['class', 'src'] });
  if (img.complete) draw();
  sync();
  return canvas;
}
