// Optional waveform seek bar. foobar2000 decodes the track once (it keeps its
// own cache), Fusion keeps the last few in memory and redraws only when the
// track or the bar's size changes. Progress is a clip on a second canvas, so
// playback never redraws anything.

import { tryCall, on } from '../core/bridge.js';
import { logInfo } from '../core/log.js';

const POINTS = 1024; // one decode per track at this resolution; bars are resampled from it
const BAR = 2; // px
const GAP = 1; // px
const keep = new Map(); // handle -> Float32Array (most recent last)
const waiting = new Map(); // taskId -> resolve

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  on('audio:fullWaveformReady', (e) => {
    waiting.get(e.taskId)?.(e.waveform);
    waiting.delete(e.taskId);
  });
  on('audio:fullWaveformFailed', (e) => {
    if (e.code !== 'CANCELLED') logInfo(`waveform failed: ${e.code} ${e.error || ''}`);
    waiting.get(e.taskId)?.(null);
    waiting.delete(e.taskId);
  });
}

function remember(handle, data) {
  keep.delete(handle);
  keep.set(handle, data);
  while (keep.size > 24) keep.delete(keep.keys().next().value);
}

export function mountWaveform(seek) {
  listen();
  const back = document.createElement('canvas');
  const front = document.createElement('canvas');
  back.className = 'wave wave-back';
  front.className = 'wave wave-front';
  const box = document.createElement('div');
  box.className = 'wave-box';
  box.append(back, front);
  seek.append(box);

  let handle = null;
  let data = null;
  let task = null;
  let shown = false;

  function cancel() {
    if (!task) return;
    waiting.get(task)?.(null);
    waiting.delete(task);
    tryCall('audio.cancelFullWaveform', { taskId: task });
    task = null;
  }

  async function load(h) {
    if (h === handle) return;
    cancel();
    handle = h;
    data = h ? keep.get(h) || null : null;
    draw();
    if (!h || data || !shown) return;
    const res = await tryCall('audio.generateFullWaveform', { path: h, resolution: POINTS });
    if (handle !== h || !res) return;
    let points = null;
    if (res.status === 'ready') points = res.waveform;
    else if (res.status === 'pending') {
      task = res.taskId;
      points = await new Promise((r) => waiting.set(res.taskId, r));
      if (task === res.taskId) task = null;
    }
    if (handle !== h || !points?.length) return;
    data = Float32Array.from(points);
    remember(h, data);
    draw();
  }

  function draw() {
    box.classList.toggle('ready', !!data);
    if (!shown) return;
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    for (const c of [back, front]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    if (!data) return;
    paint(back, '--wave-back', '#666');
    paint(front, '--wave-fill', '#fff');
  }

  function paint(canvas, prop, fallback) {
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth;
    const h = box.clientHeight;
    const colour = getComputedStyle(box).getPropertyValue(prop).trim() || fallback;
    const bars = Math.max(1, Math.floor(w / (BAR + GAP)));
    {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colour;
      const mid = h / 2;
      for (let i = 0; i < bars; i++) {
        // Loudest point under this bar, so short peaks stay visible.
        const a = Math.floor((i / bars) * data.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * data.length));
        let v = 0;
        for (let j = a; j < b; j++) if (data[j] > v) v = data[j];
        const half = Math.max(1, Math.sqrt(v) * (mid - 1));
        ctx.fillRect(i * (BAR + GAP), mid - half, BAR, half * 2);
      }
    }
  }

  // The played part turns accent-coloured on hover, like the plain bar.
  const repaintFront = () => shown && data && requestAnimationFrame(() => paint(front, '--wave-fill', '#fff'));
  seek.addEventListener('pointerenter', repaintFront);
  seek.addEventListener('pointerleave', repaintFront);

  const ro = new ResizeObserver(() => draw());
  ro.observe(box);

  return {
    /** Show or hide; while hidden nothing is requested or drawn. */
    show(on, h) {
      shown = on;
      seek.classList.toggle('waveform', on);
      if (!on) {
        cancel();
        handle = null;
        data = null;
        return;
      }
      handle = undefined; // force a reload
      load(h);
    },
    track(h) {
      if (shown) load(h);
    },
    progress(frac) {
      front.style.clipPath = `inset(0 ${(1 - frac) * 100}% 0 0)`;
    },
    redraw: draw,
  };
}
