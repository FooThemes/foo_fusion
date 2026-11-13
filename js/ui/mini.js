// Mini player: the window shrinks to the play bar alone — cover, title,
// controls and seek bar — and (by default) stays on top. Everything else is
// hidden, not torn down, so going back is instant. Alt+M, the play bar's
// button or the main menu switch it.

import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';

const SIZE = { width: 480, height: 200 };
const MIN = { width: 340, height: 150 };
let saved = null; // the window as it was: bounds, maximised, on top, min size
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
      const [bounds, max, top, min] = await Promise.all([tryCall('window.getBounds'), tryCall('window.isMaximized'), tryCall('window.isAlwaysOnTop'), tryCall('window.getMinSize', {})]);
      saved = { bounds, max: flag(max, 'maximized', 'isMaximized', 'value'), top: flag(top, 'alwaysOnTop', 'enabled', 'value'), min };
      if (saved.max) await tryCall('window.restore');
      document.body.classList.add('mini');
      window.dispatchEvent(new CustomEvent('fusion:mini', { detail: true }));
      await tryCall('window.setMinSize', MIN);
      await tryCall('window.setSize', SIZE);
      if (store.get('miniOnTop') !== false) await tryCall('window.setAlwaysOnTop', { enabled: true });
    } else {
      document.body.classList.remove('mini');
      window.dispatchEvent(new CustomEvent('fusion:mini', { detail: false }));
      const s = saved || {};
      saved = null;
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
