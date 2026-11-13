// Keyboard shortcuts, matching the original Fusion list where it made sense.

import { tryCall } from '../core/bridge.js';
import { toggleMini } from './mini.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { runSelectionCommand } from './menus.js';
import { newPlaylistDialog } from './autoplaylist.js';

export const SHORTCUTS = [
  ['Enter', 'Play the focused song (or open the focused album)'],
  ['Space', 'Play / pause'],
  ['Delete', 'Remove selected songs from the playlist'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+I', 'Invert selection'],
  ['Ctrl+F', 'Search this playlist'],
  ['Ctrl+M', 'Playlist manager'],
  ['Ctrl+N', 'New playlist'],
  ['Ctrl+P', 'foobar2000 preferences'],
  ['Ctrl+O', 'Open containing folder'],
  ['F5', 'Reload the view'],
  ['Ctrl+Shift+F5', 'Reload Fusion itself (after updating its files)'],
  ['F11', 'Fullscreen'],
  ['Alt+A', 'Always on top'],
  ['Esc', 'Close panels / clear search'],
];

export function mountKeyboard(app) {
  // Focus rings show after keys that move focus, and go once the pointer is used.
  const NAV = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  document.addEventListener('keydown', (e) => NAV.has(e.key) && document.documentElement.setAttribute('data-keyboard', ''), true);
  document.addEventListener('pointerdown', () => document.documentElement.removeAttribute('data-keyboard'), true);

  document.addEventListener('keydown', async (e) => {
    // Reload works from anywhere (even the search box), and falls back to a
    // plain page reload if foobar2000 doesn't answer.
    if (e.ctrlKey && e.shiftKey && e.key === 'F5') {
      e.preventDefault();
      let done = false;
      tryCall('window.reload').then((r) => (done = !!r));
      setTimeout(() => done || location.reload(), 1500);
      return;
    }
    if (e.defaultPrevented) return;
    const typing = e.target.closest('input, textarea, [contenteditable]');
    if (typing) return;
    const key = (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const all = () => view.rows || (view.groups.length ? view.groups.flatMap((g) => view.groupRows(g)) : Array.from({ length: view.total }, (_, i) => i));
    const handled = {
      ' ': () => player.playOrPause(),
      Enter: () => {
        const sel = [...view.selection].sort((a, b) => a - b);
        if (sel.length) view.play(sel[0]);
      },
      Delete: () => view.removeRows([...view.selection]),
      'Ctrl+A': () => view.select(all()),
      'Ctrl+I': () => view.select(all().filter((r) => !view.selection.has(r))),
      'Ctrl+F': () => app.focusSearch(),
      'Ctrl+M': () => app.togglePlaylistManager(),
      'Ctrl+N': () => newPlaylistDialog(),
      'Ctrl+P': () => tryCall('misc.showPreferences'),
      'Ctrl+O': () => view.selection.size && runSelectionCommand('Open containing folder'),
      F5: () => view.load(),
      F11: () => tryCall('window.toggleFullscreen'),
      'Alt+A': () => tryCall('window.toggleAlwaysOnTop'),
      'Alt+M': () => toggleMini(),
      Escape: () => app.escape(),
    }[key === 'Shift+ ' ? ' ' : key];
    if (!handled) return;
    // A focused tile or button handles Enter itself.
    if (key === 'Enter' && (document.activeElement?.closest('.tile, button') || !view.selection.size)) return;
    e.preventDefault(); // before any await, or WebView2 runs its own F5 / Ctrl+P / Ctrl+F
    await handled();
  });
}
