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
 * The pixels: `sp` the small picture's RGBA (sw × sh), drawn W × H, cover-fit
 * on a box reaching `b` px past each edge, over the colour `bg`, `opacity`
 * strong down to `solid` of the height and eased out below. Self-contained
 * (it's also sent to the worker as source text).
 */
function renderSmooth({ sp, sw, sh, W, H, bg, opacity, b, solid }) {
  const px = new Uint8ClampedArray(W * H * 4);
  const boxW = W + 2 * b;
  const boxH = H + 2 * b;
  const s = Math.max(boxW / sw, boxH / sh);
  const ox = (boxW - sw * s) / 2 - b;
  const oy = (boxH - sh * s) / 2 - b;
  const br = bg[0];
  const bgg = bg[1];
  const bb = bg[2];
  // Dither: triangular noise under one level, from a table (fast).
  const N = 4096;
  const noise = new Float32Array(N);
  for (let n = 0; n < N; n++) noise[n] = (Math.random() - Math.random()) * 0.75 + 0.5;
  // Source x position and weights per column (the same for every row).
  const x0 = new Int32Array(W);
  const x1 = new Int32Array(W);
  const fx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const u = Math.min(sw - 1, Math.max(0, (x + 0.5 - ox) / s - 0.5));
    x0[x] = Math.floor(u) * 4;
    x1[x] = Math.min(sw - 1, Math.floor(u) + 1) * 4;
    fx[x] = u - Math.floor(u);
  }
  let i = 0;
  let d = 0;
  for (let y = 0; y < H; y++) {
    const v = Math.min(sh - 1, Math.max(0, (y + 0.5 - oy) / s - 0.5));
    const y0 = Math.floor(v);
    const fy = v - y0;
    const r0 = y0 * sw * 4;
    const r1 = Math.min(sh - 1, y0 + 1) * sw * 4;
    const t = y / (H - 1 || 1);
    let k = 1;
    if (t > solid) {
      const z = Math.min(1, (t - solid) / (1 - solid));
      k = 1 - z * z * (3 - 2 * z);
    }
    const a = opacity * k;
    const ia = 1 - a;
    const cr = br * ia;
    const cg = bgg * ia;
    const cb = bb * ia;
    d = (y * 1361) % N;
    for (let x = 0; x < W; x++) {
      const a0 = r0 + x0[x];
      const a1 = r0 + x1[x];
      const b0 = r1 + x0[x];
      const b1 = r1 + x1[x];
      const wx = fx[x];
      const w00 = (1 - wx) * (1 - fy) * a;
      const w01 = wx * (1 - fy) * a;
      const w10 = (1 - wx) * fy * a;
      const w11 = wx * fy * a;
      px[i] = cr + sp[a0] * w00 + sp[a1] * w01 + sp[b0] * w10 + sp[b1] * w11 + noise[d] - 0.5;
      px[i + 1] = cg + sp[a0 + 1] * w00 + sp[a1 + 1] * w01 + sp[b0 + 1] * w10 + sp[b1 + 1] * w11 + noise[(d + 1531) % N] - 0.5;
      px[i + 2] = cb + sp[a0 + 2] * w00 + sp[a1 + 2] * w01 + sp[b0 + 2] * w10 + sp[b1 + 2] * w11 + noise[(d + 2843) % N] - 0.5;
      px[i + 3] = 255;
      i += 4;
      d = d + 7 < N ? d + 7 : d + 7 - N;
    }
  }
  return px;
}

// Worked out in a background worker, so drawing never holds up the page
// (opening an album, its slide). Made from renderSmooth's own source; if a
// worker can't start, it's done here instead.
let worker;
let jobs = 0;
const waiting = new Map();
function getWorker() {
  if (worker !== undefined) return worker;
  try {
    const code = `${renderSmooth.toString()}
onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    const px = renderSmooth(job);
    const bitmap = await createImageBitmap(new ImageData(px, job.W, job.H));
    postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};`;
    worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const done = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      done?.(e.data);
    };
    worker.onerror = () => {
      worker = null; // fall back to the page from now on
      for (const done of waiting.values()) done({ error: 'worker' });
      waiting.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

async function render(job) {
  const w = getWorker();
  if (w) {
    const res = await new Promise((resolve) => {
      const id = ++jobs;
      waiting.set(id, resolve);
      w.postMessage({ id, job }, [job.sp.buffer]);
    });
    if (res.bitmap) return res.bitmap;
    job = { ...job, sp: job.spCopy };
  }
  return new ImageData(renderSmooth(job), job.W, job.H);
}

/**
 * Draw `src` (the small blurred picture) into `out`, filling `box`.
 * Resolves true when drawn; `isCurrent()` false drops a result overtaken by
 * a newer one (another cover, the size changed again).
 * @param {object} o
 * @param {number[]} o.bg  the page colour behind it, [r, g, b]
 * @param {number} [o.opacity]  how strongly the picture shows (top of the fade)
 * @param {number} [o.bleed]  px the stretched picture reaches past each edge
 * @param {number} [o.solid]  part of the height before the fade starts
 */
export async function drawSmooth(src, out, { bg, opacity = 0.45, bleed = 140, solid = 0.25, box = out.parentElement, isCurrent = () => true }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = box.clientWidth;
  const ch = box.clientHeight;
  if (!src.width || !src.height || !cw || !ch) return false;
  const W = Math.max(1, Math.round(cw * dpr));
  const H = Math.max(1, Math.round(ch * dpr));
  const sp = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
  const job = { sp, spCopy: sp.slice(), sw: src.width, sh: src.height, W, H, bg, opacity, b: bleed * dpr, solid };
  const pic = await render(job);
  if (!isCurrent()) {
    pic.close?.();
    return false;
  }
  // Sized only now: changing a canvas's size clears it, so it's never blank.
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  if (pic instanceof ImageData) ctx.putImageData(pic, 0, 0);
  else {
    ctx.drawImage(pic, 0, 0);
    pic.close();
  }
  return true;
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
  let gen = 0;
  const paint = () => {
    cancelAnimationFrame(frame);
    // Next frame: after a theme change has recoloured the page behind it.
    frame = requestAnimationFrame(async () => {
      const mine = ++gen;
      // Only once a picture is drawn small: an empty canvas still has a
      // size, and switching to the blurred copy hides whatever the box was
      // showing (an artist header's sharp fanart vanished this way).
      if (!small.classList.contains('loaded')) {
        box.classList.remove('smooth');
        full.classList.remove('loaded');
        return;
      }
      let ok = false;
      try {
        ok = await drawSmooth(small, full, { bg: backgroundOf(box), opacity: typeof opacity === 'function' ? opacity() : opacity, bleed, solid, box, isCurrent: () => mine === gen });
      } catch {
        ok = false; // a picture that can't be read back: the stretched copy shows instead
      }
      if (mine !== gen) return;
      // Until the first drawing is ready the stretched copy shows; after
      // that a redraw replaces the picture in one go.
      if (ok) box.classList.add('smooth');
      else if (!box.classList.contains('smooth') || !small.width) box.classList.remove('smooth');
      full.classList.toggle('loaded', small.classList.contains('loaded'));
    });
  };
  const small = softBackdrop(img, { blur, at, onDraw: paint });
  // The small copy turning "loaded" (it can come after its drawing): draw
  // the full one then too.
  let wasLoaded = small.classList.contains('loaded');
  new MutationObserver(() => {
    const now = small.classList.contains('loaded');
    full.classList.toggle('loaded', now);
    if (now && !wasLoaded) paint();
    wasLoaded = now;
  }).observe(small, { attributes: true, attributeFilter: ['class'] });
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(paint, 120);
  });
  ro.observe(box);
  return {
    small,
    full,
    repaint: paint,
    /** Back to the stretched copy (and drop a drawing still being made). */
    cancel() {
      gen++;
      cancelAnimationFrame(frame);
      box.classList.remove('smooth');
    },
    destroy() {
      ro.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    },
  };
}
