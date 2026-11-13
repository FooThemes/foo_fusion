// Diagnostics written to fusion.log, for problems that only show on a real
// library: slow host calls, long main-thread tasks, calls that never answer,
// how long a tab switch takes, and mouse input that stops reaching the page.

import { onSlowCall, pending } from './bridge.js';
import { logInfo, logAlways, setInfoLogging } from './log.js';
import * as store from './store.js';

let lastAction = 'start';
let running = null; // AbortController of the running diagnostics

/**
 * Settings > More > Diagnostics. Off (the default): nothing is watched or
 * timed and only warnings and errors reach fusion.log. Ctrl+Shift+D still
 * writes a snapshot either way.
 */
export function installDiagnostics(view) {
  const apply = () => {
    const on = !!store.get('diagnostics');
    setInfoLogging(on);
    if (on && !running) start(view);
    if (!on && running) {
      running.abort();
      running = null;
    }
  };
  store.subscribe((k) => k === 'diagnostics' && apply());
  apply();
  installSnapshot(view);
}

function start(view) {
  const ac = (running = new AbortController());
  const signal = ac.signal;
  const every = (fn, ms) => {
    const id = setInterval(fn, ms);
    signal.addEventListener('abort', () => clearInterval(id));
  };
  // What the user last did, so a long task can be tied to it.
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target.closest('button, [role], .tile, .song-row, .tp-row, .pl-item, a') || e.target;
      lastAction = `click ${t.tagName.toLowerCase()}${t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\s+/).join('.') : ''} "${(t.textContent || t.title || '').trim().slice(0, 30)}"`;
    },
    { capture: true, signal },
  );

  // Slow host calls, summarised per method every few seconds.
  const slow = new Map();
  onSlowCall((method, ms) => {
    if (signal.aborted) return;
    const s = slow.get(method) || { n: 0, max: 0, total: 0 };
    s.n++;
    s.total += ms;
    s.max = Math.max(s.max, ms);
    slow.set(method, s);
  });
  every(() => {
    if (!slow.size) return;
    const parts = [...slow].map(([m, s]) => `${m} x${s.n} max ${Math.round(s.max)} ms avg ${Math.round(s.total / s.n)} ms`);
    slow.clear();
    logInfo(`slow calls (after ${lastAction}): ${parts.join('; ')}`);
  }, 4000);

  // Calls with no answer yet.
  const reported = new Set();
  every(() => {
    const now = performance.now();
    for (const [id, p] of pending) {
      if (now - p.t0 > 5000 && !reported.has(id)) {
        reported.add(id);
        logInfo(`waiting ${Math.round((now - p.t0) / 1000)} s for ${p.method} (${pending.size} calls pending, after ${lastAction})`);
      }
    }
  }, 2500);

  // Long main-thread tasks (the page can't respond to clicks during these).
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration > 150) logInfo(`long task ${Math.round(e.duration)} ms (after ${lastAction})`);
    });
    po.observe({ type: 'longtask', buffered: false });
    signal.addEventListener('abort', () => po.disconnect());
  } catch {
    /* not supported */
  }

  // Tab switch: from the click to the frame after the new grid is drawn.
  let switchT0 = 0;
  let switchMode = '';
  const offMode = view.on('mode', (m) => {
    switchT0 = performance.now();
    switchMode = m;
  });
  const offChange = view.on('change', () => {
    if (!switchT0) return;
    const t0 = switchT0;
    switchT0 = 0;
    const loaded = performance.now() - t0;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => logInfo(`switch to ${switchMode}: data ${Math.round(loaded)} ms, drawn ${Math.round(performance.now() - t0)} ms`)),
    );
  });

  signal.addEventListener('abort', () => (offMode(), offChange()));

  // Mouse input that stops arriving while the wheel still works (the page is
  // alive but clicks don't reach it), plus drag start/end to correlate.
  let lastPointer = performance.now();
  let warned = false;
  for (const ev of ['pointermove', 'pointerdown']) document.addEventListener(ev, () => ((lastPointer = performance.now()), (warned = false)), { capture: true, passive: true, signal });
  document.addEventListener(
    'wheel',
    () => {
      const gap = performance.now() - lastPointer;
      if (gap > 15000 && !warned) {
        warned = true;
        logInfo(`wheel input but no mouse move/click for ${Math.round(gap / 1000)} s (after ${lastAction})`);
      }
    },
    { capture: true, passive: true, signal },
  );
  // Fusion's own drags no longer use HTML5 drag and drop; only drops from
  // outside (files from Explorer) still do.
  document.addEventListener('drop', (e) => logInfo(`drop on ${e.target.closest('[class]')?.className || e.target.tagName}`), { capture: true, signal });
}

function installSnapshot(view) {
  // Frozen-UI check the user can run: Ctrl+Shift+D writes a snapshot.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd')) return;
      e.preventDefault();
      const now = performance.now();
      const calls = [...pending.values()].map((p) => `${p.method} ${Math.round((now - p.t0) / 1000)}s`);
      const overlays = [...document.querySelectorAll('.menu, .dialog, .modal, [class*="backdrop"], #drag-badge')].filter((n) => n.offsetParent !== null || getComputedStyle(n).position === 'fixed').map((n) => n.className || n.id);
      const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      logAlways(
        `SNAPSHOT: pending [${calls.join(', ')}]; loading ${view.loading}; mode ${view.mode}; overlays [${overlays.join(', ')}]; centre element ${top?.tagName}.${top?.className}; focus ${document.activeElement?.tagName}.${document.activeElement?.className}; last ${lastAction}`,
      );
    },
    true,
  );
}
