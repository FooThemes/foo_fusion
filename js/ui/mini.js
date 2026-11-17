// Mini player: the window shrinks to the play bar alone — cover, title,
// controls and seek bar — and (by default) stays on top. Everything else is
// hidden, not torn down, so going back is instant. Alt+M, the play bar's
// button or the main menu switch it.

import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';

// One fixed size: the page area of the mini player, in CSS pixels (the
// window adds its frame and title bar, measured when it opens).
const CLIENT = { width: 445, height: 148 };
const GUESS = { width: 447, height: 180 }; // the window, before measuring
let fixed = null; // the window size worked out (minimum and maximum both)
let saved = null; // the window as it was: bounds, maximised, on top, min size
// Kept across a refresh of the skin: the page starts again but the window
// is still the mini player's (and locked to its size).
const SAVED_KEY = 'fusion.miniSaved';
const keepSaved = (v) => {
  try {
    if (v) localStorage.setItem(SAVED_KEY, JSON.stringify(v));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    /* fine */
  }
};
let busy = false;

export const isMini = () => document.body.classList.contains('mini');

const flag = (r, ...keys) => {
  for (const k of keys) if (r && typeof r[k] === 'boolean') return r[k];
  return typeof r === 'boolean' ? r : false;
};

export async function toggleMini(on = !isMini()) {
  if (busy || on === isMini()) return;
  busy = true;
  try {
    if (on) {
      const [bounds, max, top, min, maxSize] = await Promise.all([tryCall('window.getBounds'), tryCall('window.isMaximized'), tryCall('window.isAlwaysOnTop'), tryCall('window.getMinSize', {}), tryCall('window.getMaxSize', {})]);
      saved = { bounds, max: flag(max, 'maximized', 'isMaximized', 'value'), top: flag(top, 'alwaysOnTop', 'enabled', 'value'), min, maxSize };
      keepSaved(saved);
      if (saved.max) await tryCall('window.restore');
      await enterMini();
    } else {
      window.removeEventListener('resize', keepMin);
      window.removeEventListener('resize', unmaximize);
      document.body.classList.remove('mini');
      window.dispatchEvent(new CustomEvent('fusion:mini', { detail: false }));
      const s = saved || {};
      saved = null;
      keepSaved(null);
      const mx = s.maxSize;
      await tryCall('window.setMaxSize', { width: mx?.width ?? mx?.maxWidth ?? 0, height: mx?.height ?? mx?.maxHeight ?? 0 });
      const m = s.min;
      await tryCall('window.setMinSize', { width: m?.width ?? m?.minWidth ?? 0, height: m?.height ?? m?.minHeight ?? 0 });
      const b = s.bounds;
      if (b && b.width) await tryCall('window.setBounds', { x: b.x, y: b.y, width: b.width, height: b.height });
      if (s.max) await tryCall('window.maximize');
      await tryCall('window.setAlwaysOnTop', { enabled: !!s.top });
    }
  } finally {
    busy = false;
  }
}

/** The window exactly the mini player's size: its frame measured, the minimum and maximum set to it. */
async function fit() {
  if (!isMini()) return;
  const b = await tryCall('window.getBounds');
  if (!b?.width || !innerWidth) return;
  const r = window.devicePixelRatio || 1;
  const want = {
    width: Math.round(CLIENT.width * r + (b.width - innerWidth * r)),
    height: Math.round(CLIENT.height * r + (b.height - innerHeight * r)),
  };
  if (fixed && fixed.width === want.width && fixed.height === want.height && Math.abs(b.width - want.width) <= 1 && Math.abs(b.height - want.height) <= 1) return;
  fixed = want;
  await tryCall('window.setMinSize', want);
  await tryCall('window.setMaxSize', want);
  if (Math.abs(b.width - want.width) > 1 || Math.abs(b.height - want.height) > 1) await tryCall('window.setSize', want);
}

// Anything that changes its size (a display's scale, a resize that got
// through) puts it back.
let keepTimer = 0;
function keepMin() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(fit, 150);
}

// No maximising in the mini player (a double-click on the bar, Win+Up, the
// system menu): it's put straight back.
async function unmaximize() {
  if (!isMini()) return;
  if (flag(await tryCall('window.isMaximized'), 'maximized', 'isMaximized', 'value')) await tryCall('window.restore');
}

/** The page side of the mini player (the window's bounds already saved). */
async function enterMini() {
  document.body.classList.add('mini');
  window.dispatchEvent(new CustomEvent('fusion:mini', { detail: true }));
  fixed = null;
  await tryCall('window.setMinSize', GUESS);
  await tryCall('window.setMaxSize', GUESS);
  await tryCall('window.setSize', GUESS);
  window.addEventListener('resize', keepMin);
  setTimeout(fit, 200);
  window.addEventListener('resize', unmaximize);
  await applyOnTop();
}

// On top or not, as the setting says (also when it's changed meanwhile).
const applyOnTop = () => tryCall('window.setAlwaysOnTop', { enabled: store.get('miniOnTop') !== false });
store.subscribe((k) => k === 'miniOnTop' && isMini() && applyOnTop());

/** At start: the skin refreshed in the mini player comes back in it (the window still is). */
export async function resumeMini() {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem(SAVED_KEY));
  } catch {
    /* none */
  }
  if (!s || isMini() || busy) return;
  busy = true;
  try {
    saved = s;
    await enterMini();
  } finally {
    busy = false;
  }
}
