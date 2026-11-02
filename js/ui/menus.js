// Menus and small dialogs. Native popup menus come from foo_ui_webview2
// (ui.showCustomMenu / menu.showNativePopup); text prompts are drawn in-page.

import { call, tryCall } from '../core/bridge.js';
import { el } from '../core/util.js';
import { playlists } from '../data/playlists.js';
import { view } from '../data/view.js';
import { toast } from './toast.js';
import * as store from '../core/store.js';
import { player } from '../data/player.js';

/** Show a native menu built from [{ id, label, checked, enabled, submenu, run }]. */
export async function showMenu(items) {
  const actions = new Map();
  let n = 0;
  const convert = (list) =>
    list.map((it) => {
      if (it === '-' || it.type === 'separator') return { type: 'separator' };
      const id = it.id || `m${n++}`;
      if (it.run) actions.set(id, it.run);
      const out = { id, label: it.label, enabled: it.enabled !== false, checked: !!it.checked };
      if (it.shortcut) out.shortcut = it.shortcut;
      if (it.submenu) out.submenu = convert(it.submenu);
      return out;
    });
  const res = await tryCall('ui.showCustomMenu', { items: convert(items) });
  const id = res?.selectedId;
  if (id && actions.has(id)) await actions.get(id)();
  return id || null;
}

/** Fusion's menu: panels, playback extras and the full foobar2000 menu bar. */
export async function showAppMenu(app) {
  const fbItems = await foobarMenuItems();
  return showMenu([
    { label: 'Settings', run: () => app.toggleSettings(true) },
    { label: 'Left panel', shortcut: 'Ctrl+M', checked: !store.get('sidebarHidden'), run: () => app.toggleSidebar() },
    { label: 'Track info panel', checked: store.get('infoPanel'), run: () => store.set('infoPanel', !store.get('infoPanel')) },
    { label: 'Dark theme', checked: store.get('dark'), run: () => store.set('dark', !store.get('dark')) },
    '-',
    { label: 'Stop after current', checked: player.stopAfterCurrent, run: () => tryCall('playback.toggleStopAfterCurrent') },
    { label: 'Stop', enabled: player.active, run: () => player.stop() },
    '-',
    { label: 'Fullscreen', shortcut: 'F11', run: () => tryCall('window.toggleFullscreen') },
    { label: 'Always on top', shortcut: 'Alt+A', run: () => tryCall('window.toggleAlwaysOnTop') },
    '-',
    { label: 'foobar2000', submenu: fbItems.length ? fbItems : [{ label: 'Unavailable', enabled: false }] },
    { label: 'Preferences', shortcut: 'Ctrl+P', run: () => runMainMenu('File/Preferences') },
  ]);
}

/** foobar2000's own context menu for playlist rows. */
export async function trackContextMenu(rows) {
  if (!rows.length) return;
  const sel = view.selection;
  const same = rows.length === sel.size && rows.every((r) => sel.has(r));
  if (!same) await view.select(rows, { focus: rows[0] });
  await tryCall('menu.showNativePopup', { mode: 'selection' });
}

export function addToItems(rows) {
  const targets = playlists.list.filter((p) => !p.isAutoplaylist && !p.isLocked && p.index !== view.playlist?.index);
  return [
    {
      label: 'New playlist…',
      run: async () => {
        const name = await promptText('Name this playlist', 'New playlist');
        if (!name) return;
        const res = await playlists.create(name, false);
        const n = await view.addRowsTo(res.index, rows);
        toast(`Added ${n} songs to ${name}`);
      },
    },
    { label: 'Playback queue', run: () => view.queueRows(rows) },
    targets.length ? '-' : null,
    ...targets.map((p) => ({
      label: p.name,
      run: async () => {
        const n = await view.addRowsTo(p.index, rows);
        toast(`Added ${n} songs to ${p.name}`);
      },
    })),
  ].filter(Boolean);
}

export function playlistMenu(p) {
  const special = playlists.isSpecial(p);
  return showMenu([
    { label: 'Play', run: () => call('playlist.playTrack', { playlist: p.index, index: 0 }) },
    '-',
    { label: 'Rename…', enabled: !special, run: () => renamePlaylist(p) },
    { label: 'Duplicate', run: () => call('playlist.duplicate', { playlist: p.index }) },
    { label: 'Edit autoplaylist…', enabled: p.isAutoplaylist, run: () => call('playlist.showAutoplaylistUI', { playlist: p.index }) },
    '-',
    { label: 'Delete', enabled: !p.isLocked, run: () => deletePlaylist(p) },
  ]);
}

export async function renamePlaylist(p) {
  const name = await promptText('Rename playlist', p.name);
  if (name && name !== p.name) await playlists.rename(p.index, name);
}

export async function deletePlaylist(p) {
  const ok = await confirmDialog(`Delete "${p.name}"?`, 'This playlist will be removed. The music files are not touched.', 'Delete');
  if (ok) await playlists.remove(p.index);
}

/** The full foobar2000 main menu, as a native submenu tree. */
export async function foobarMenuItems() {
  const res = await tryCall('menu.getMainMenu', { withAvailability: false });
  const conv = (nodes) =>
    (nodes || [])
      .filter((n) => !n.hidden)
      .map((n) => {
        if (n.type === 'separator') return '-';
        if (n.type === 'submenu') return { label: clean(n.displayLabel || n.label), submenu: conv(n.children) };
        return {
          label: clean(n.displayLabel || n.label),
          enabled: n.enabled !== false && n.executable !== false,
          checked: n.checked,
          run: () => call('menu.runMainMenuCommand', n.guid ? { command: n.guid, subGuid: n.subGuid || '' } : { command: n.path }),
        };
      });
  return conv(res?.items);
}

const clean = (s) => String(s || '').replace(/&(?!&)/g, '').replace(/\t.*$/, '');

/** Run a foobar2000 context-menu command (by its label) on the selected songs. */
export async function runSelectionCommand(label) {
  const res = await tryCall('menu.getContextMenu', { mode: 'selection', withAvailability: false, i18n: false });
  const want = label.toLowerCase();
  const find = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'command' && clean(n.label).toLowerCase() === want) return n;
      const hit = n.children && find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const cmd = find(res?.items);
  if (!cmd || cmd.commandId == null) return false;
  await tryCall('menu.runContextCommandById', { id: cmd.commandId, mode: res.mode, expectTarget: res.targetKey });
  return true;
}

export function runMainMenu(path) {
  return tryCall('menu.runMainMenuCommand', { command: path });
}

// --- in-page dialogs -------------------------------------------------------

function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    const root = document.getElementById('overlay-root');
    const close = (v) => {
      back.remove();
      resolve(v);
    };
    const back = el('div.dialog-back', { onmousedown: (e) => e.target === back && close(null) });
    const box = el('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('h2', { text: title }), body, el('div.dialog-buttons', null, buttons(close)));
    back.append(box);
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      e.stopPropagation();
    });
    root.append(back);
    (box.querySelector('input') || box.querySelector('button.btn-primary'))?.focus();
  });
}

export function promptText(title, value = '') {
  const input = el('input.dialog-input', { type: 'text', value, spellcheck: false });
  input.addEventListener('focus', () => input.select(), { once: true });
  return dialog(title, input, (close) => {
    input.addEventListener('keydown', (e) => e.key === 'Enter' && close(input.value.trim() || null));
    return [el('button.btn-primary', { text: 'Save', onclick: () => close(input.value.trim() || null) }), el('button.btn-text', { text: 'Cancel', onclick: () => close(null) })];
  });
}

export function confirmDialog(title, message, okLabel = 'OK') {
  return dialog(title, el('p', { text: message }), (close) => [
    el('button.btn-primary', { text: okLabel, onclick: () => close(true) }),
    el('button.btn-text', { text: 'Cancel', onclick: () => close(false) }),
  ]);
}
