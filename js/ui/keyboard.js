// Keyboard shortcuts, matching the original Fusion list where it made sense.

import { tryCall } from '../core/bridge.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { runMainMenu, promptText, runSelectionCommand } from './menus.js';
import { playlists } from '../data/playlists.js';

export const SHORTCUTS = [
  ['Enter', 'Play the focused song (or open the focused album)'],
  ['Space', 'Play / pause'],
  ['Delete', 'Remove selected songs from the playlist'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+I', 'Invert selection'],
  ['Ctrl+F', 'Search this playlist'],
  ['Ctrl+M', 'Show or hide the left panel (playlist manager)'],
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
  document.addEventListener('keydown', async (e) => {
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
      'Ctrl+M': () => app.toggleSidebar(),
      'Ctrl+N': async () => {
        const name = await promptText('Name this playlist', 'New playlist');
        if (name) playlists.create(name);
      },
      'Ctrl+P': () => runMainMenu('File/Preferences'),
      'Ctrl+O': () => view.selection.size && runSelectionCommand('Open containing folder'),
      F5: () => view.load(),
      'Ctrl+Shift+F5': () => tryCall('window.reload'),
      F11: () => tryCall('window.toggleFullscreen'),
      'Alt+A': () => tryCall('window.toggleAlwaysOnTop'),
      Escape: () => app.escape(),
    }[key === 'Shift+ ' ? ' ' : key];
    if (!handled) return;
    // A focused tile or button handles Enter itself.
    if (key === 'Enter' && (document.activeElement?.closest('.tile, button') || !view.selection.size)) return;
    e.preventDefault(); // before any await, or WebView2 runs its own F5 / Ctrl+P / Ctrl+F
    await handled();
  });
}
