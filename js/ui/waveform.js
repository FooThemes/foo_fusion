// Optional waveform seek bar. foobar2000 decodes the track once (it keeps its
// own cache), Fusion keeps the last few in memory and redraws only when the
// track or the bar's size changes. Progress is a clip on a second canvas, so
// playback never redraws anything.

import { tryCall, on } from '../core/bridge.js';
import { logInfo } from '../core/log.js';
import { hash } from '../core/util.js';
import { cacheFolder } from '../data/artcache.js';

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

// Waveforms are also kept on disk (1 KB each, in the art cache folder), so a
// song heard before shows its waveform at once, even after a restart.
const waveName = (handle) => `${hash(handle).toString(36)}${hash(handle + '#').toString(36)}.wf`;

async function fromDisk(handle) {
  const c = cacheFolder();
  if (!c) return null;
  try {
    const res = await fetch(`${c.url}/waves/${waveName(handle)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return null;
    return Float32Array.from(bytes, (b) => b / 255);
  } catch {
    return null;
  }
}

function toDisk(handle, data) {
  const c = cacheFolder();
  if (!c) return;
  let bin = '';
  for (const v of data) bin += String.fromCharCode(Math.max(0, Math.min(255, Math.round(v * 255))));
  tryCall('file.write', { path: `${c.path}\\waves\\${waveName(handle)}`, content: btoa(bin), encoding: 'base64' });
}

/** The waveform for a track: memory, disk, else foobar2000 decodes it. */
async function fetchWave(h, onTask) {
  const mem = keep.get(h);
  if (mem) return mem;
  const disk = await fromDisk(h);
  if (disk) {
    remember(h, disk);
    return disk;
  }
  const res = await tryCall('audio.generateFullWaveform', { path: h, resolution: POINTS, preferCache: true });
  if (!res) return null;
  let points = null;
  if (res.status === 'ready') points = res.waveform;
  else if (res.status === 'pending') {
    onTask?.(res.taskId);
    points = await new Promise((r) => waiting.set(res.taskId, r));
  }
  if (!points?.length) return null;
  // Peaks scaled to 0..1 so the stored bytes keep the detail.
  let max = 0;
  for (const v of points) if (Math.abs(v) > max) max = Math.abs(v);
  const data = Float32Array.from(points, (v) => (max ? Math.abs(v) / max : 0));
  remember(h, data);
  toDisk(h, data);
  return data;
}

/** Get the next song's waveform ready while this one plays. */
let prefetching = null;
export function prefetchWave(h) {
  if (!h || keep.has(h) || prefetching === h) return;
  prefetching = h;
  fetchWave(h).finally(() => prefetching === h && (prefetching = null));
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
    const got = await fetchWave(h, (id) => (task = id));
    task = null;
    if (handle !== h || !got) return;
    data = got;
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
      // A soft edge (a few px of gradient) moves smoothly through each bar,
      // where a hard clip jumped from one bar to the next.
      box.style.setProperty('--wave-at', (frac * 100).toFixed(3) + '%');
    },
    redraw: draw,
  };
}
