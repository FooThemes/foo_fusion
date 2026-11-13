// Now playing's background, drawn without banding.
//
// It used to be the small blurred cover (backdrop.js) stretched by the
// browser, faded with a mask and laid at 45% over the page. Each of those
// steps rounds to 256 levels per colour, and a slow, dark gradient shows
// those levels as visible bands. (Grain only hid them by adding noise.)
//
// Here the whole thing is worked out at full size in floating point —
// stretched (bilinear), blended over the page colour, faded out at the bottom
// — and rounded to the screen's levels once, with dithering of under one
// level: the steps are spread into the picture, too fine to see as grain.

import { softBackdrop } from './backdrop.js';

/**
 * @param {HTMLCanvasElement} src  the small blurred cover
 * @param {HTMLCanvasElement} out  drawn at its own size on screen
 * @param {object} o
 * @param {number[]} o.bg  the page colour behind it, [r, g, b]
 * @param {number} [o.opacity]  how strongly the cover shows (top of the fade)
 * @param {number} [o.bleed]  px the stretched cover reaches past each edge
 * @param {number} [o.solid]  part of the height before the fade starts
 * @param {HTMLElement} [o.box]  what it fills (its size; `out` may be hidden)
 */
export function drawSmooth(src, out, { bg, opacity = 0.45, bleed = 140, solid = 0.25, box = out.parentElement }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = box.clientWidth;
  const ch = box.clientHeight;
  if (!src.width || !src.height || !cw || !ch) return false;
  const W = Math.max(1, Math.round(cw * dpr));
  const H = Math.max(1, Math.round(ch * dpr));
  const sw = src.width;
  const sh = src.height;
  const sp = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;

  // As CSS's object-fit: cover on a box reaching `bleed` past each edge.
  const b = bleed * dpr;
  const boxW = W + 2 * b;
  const boxH = H + 2 * b;
  const s = Math.max(boxW / sw, boxH / sh);
  const ox = (boxW - sw * s) / 2 - b;
  const oy = (boxH - sh * s) / 2 - b;
  const [br, bgG, bb] = bg;

  // Source x position and weights per column (the same for every row).
  const x0 = new Int32Array(W);
  const x1 = new Int32Array(W);
  const fx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const u = Math.min(sw - 1, Math.max(0, (x + 0.5 - ox) / s - 0.5));
    x0[x] = Math.floor(u);
    x1[x] = Math.min(sw - 1, x0[x] + 1);
    fx[x] = u - x0[x];
  }

  let i = 0;
  for (let y = 0; y < H; y++) {
    const v = Math.min(sh - 1, Math.max(0, (y + 0.5 - oy) / s - 0.5));
    const y0 = Math.floor(v);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = v - y0;
    // The fade: full to `solid`, then eased (smoothstep) down to nothing.
    const t = y / (H - 1 || 1);
    const k = t <= solid ? 1 : 1 - smooth((t - solid) / (1 - solid));
    const a = opacity * k;
    const r0 = y0 * sw * 4;
    const r1 = y1 * sw * 4;
    for (let x = 0; x < W; x++) {
      const p00 = r0 + x0[x] * 4;
      const p01 = r0 + x1[x] * 4;
      const p10 = r1 + x0[x] * 4;
      const p11 = r1 + x1[x] * 4;
      const wx = fx[x];
      for (let c = 0; c < 3; c++) {
        const top = sp[p00 + c] + (sp[p01 + c] - sp[p00 + c]) * wx;
        const bot = sp[p10 + c] + (sp[p11 + c] - sp[p10 + c]) * wx;
        const col = top + (bot - top) * fy;
        const base = c === 0 ? br : c === 1 ? bgG : bb;
        // Triangular dither, under one level either way.
        px[i + c] = base + (col - base) * a + (Math.random() - Math.random()) * 0.75;
      }
      px[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

function smooth(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** The colour actually behind an element: its own, or the nearest parent's. */
export function backgroundOf(node) {
  for (let n = node; n; n = n.parentElement) {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(n).backgroundColor);
    if (!m) continue;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    if (a > 0) return [r, g, b];
  }
  return [34, 34, 34];
}

/**
 * A blurred picture filling `box`, drawn as above: the small blurred copy
 * (backdrop.js) and the full-size canvas, kept in step with the picture
 * loading, the box's size and the theme. `img` is the picture's (hidden)
 * <img>; artwork.js or a URL fills it as before. Options as drawSmooth's,
 * plus blur/at for the small copy. `opacity` may be a function (per theme).
 */
export function smoothBackdrop(img, box, { blur = 60, at = 1600, opacity = 0.45, bleed = 140, solid = 0.25, className = '' } = {}) {
  const full = document.createElement('canvas');
  full.className = 'smooth-bg' + (className ? ' ' + className : '');
  full.setAttribute('aria-hidden', 'true');
  box.append(full);
  let frame = 0;
  let timer = 0;
  const paint = () => {
    cancelAnimationFrame(frame);
    // Next frame: after a theme change has recoloured the page behind it.
    frame = requestAnimationFrame(() => {
      let ok = false;
      try {
        ok = drawSmooth(small, full, { bg: backgroundOf(box), opacity: typeof opacity === 'function' ? opacity() : opacity, bleed, solid, box });
      } catch {
        ok = false; // a picture that can't be read back: the stretched copy shows instead
      }
      box.classList.toggle('smooth', ok);
      full.classList.toggle('loaded', small.classList.contains('loaded'));
    });
  };
  const small = softBackdrop(img, { blur, at, onDraw: paint });
  new MutationObserver(() => full.classList.toggle('loaded', small.classList.contains('loaded'))).observe(small, { attributes: true, attributeFilter: ['class'] });
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(paint, 120);
  });
  ro.observe(box);
  return {
    small,
    full,
    repaint: paint,
    destroy() {
      ro.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    },
  };
}
