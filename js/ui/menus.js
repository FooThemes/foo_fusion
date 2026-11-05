// Menus and small dialogs. Native popup menus come from foo_ui_webview2
// (ui.showCustomMenu / menu.showNativePopup); text prompts are drawn in-page.

import { call, tryCall } from '../core/bridge.js';
import { el } from '../core/util.js';
import { playlists } from '../data/playlists.js';
import { view } from '../data/view.js';
import { toast } from './toast.js';
import { editAutoplaylist } from './autoplaylist.js';
import { folders } from '../data/folders.js';
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
    { label: 'Playlist manager', shortcut: 'Ctrl+M', run: () => app.togglePlaylistManager(true) },
    { label: 'Left panel', checked: !store.get('sidebarHidden'), run: () => app.toggleSidebar() },
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
    { label: 'Preferences', shortcut: 'Ctrl+P', run: () => tryCall('misc.showPreferences') },
  ]);
}

/**
 * foobar2000's own context menu for playlist rows, with Fusion's `extra`
 * items (e.g. "Refresh artwork") at the top.
 */
export async function trackContextMenu(rows, extra = []) {
  if (!rows.length) return;
  const sel = view.selection;
  const same = rows.length === sel.size && rows.every((r) => sel.has(r));
  if (!same) await view.select(rows, { focus: rows[0] });
  await contextMenu({ mode: 'selection' }, extra);
}

/**
 * foobar2000's context menu for `target` ({ mode: 'selection' | 'nowPlaying' }
 * or { mode: 'handles', handles }). The native menu can't take extra items,
 * so with `extra` the same commands are shown in Fusion's menu instead and
 * run through foobar2000.
 */
export async function contextMenu(target, extra = []) {
  if (!extra.length) return tryCall('menu.showNativePopup', target);
  const res = await tryCall('menu.getContextMenu', { ...target, withAvailability: false });
  const conv = (nodes) =>
    (nodes || [])
      .filter((n) => !n.hidden)
      .map((n) => {
        if (n.type === 'separator') return '-';
        const label = clean(n.displayLabel || n.label);
        if (n.type === 'submenu') return { label, submenu: conv(n.children) };
        return {
          label,
          enabled: n.enabled !== false && n.commandId != null,
          checked: !!(n.checked || n.radioChecked),
          run: () =>
            tryCall('menu.runContextCommandById', {
              id: n.commandId,
              mode: res.mode,
              ...(target.handles ? { handles: target.handles } : {}),
              ...expect(n, res),
            }),
        };
      });
  const fb = conv(res?.items);
  return showMenu(fb.length ? [...extra, '-', ...fb] : extra);
}

/**
 * The safety check for running a menu command: the item's path and the
 * tracks' key must both be given (foobar2000 refuses one without the
 * other), so the command can't land on a different item or set of tracks.
 */
function expect(node, res) {
  return node.path && res?.targetKey ? { expectPath: node.path, expectTarget: res.targetKey } : {};
}

/** Track handles for playlist rows (at most `max`, spread over the list). */
export async function handlesOf(rows, max = 3000) {
  const pickRows = rows.length > max ? rows.filter((_, i) => i % Math.ceil(rows.length / max) === 0) : rows;
  const tracks = await view.tracks(pickRows);
  return tracks.map((t) => t?.handle).filter(Boolean);
}

export function addToItems(rows) {
  const targets = playlists.list.filter((p) => !p.isAutoplaylist && !p.isLocked && !playlists.isHidden(p) && p.index !== view.playlist?.index);
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

export function folderMenuItems(targets) {
  const guids = targets.map((t) => t.guid);
  const current = folders.folderOf(guids[0]);
  return [
    ...folders.list
      .map((f) => ({ f, path: folders.path(f.id) }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ f, path }) => ({ label: path, checked: current?.id === f.id, run: () => folders.move(guids, f.id) })),
    folders.list.length ? '-' : null,
    {
      label: 'New folder…',
      run: async () => {
        const name = await promptText('Name this folder', 'New folder');
        if (name) await folders.create(name, guids, current?.id || null);
      },
    },
    { label: 'Remove from folder', enabled: !!current, run: () => folders.move(guids, null) },
  ].filter(Boolean);
}

export function folderMenu(f) {
  return showMenu([
    { label: f.collapsed ? 'Expand' : 'Collapse', run: () => folders.toggle(f.id) },
    { label: 'Rename folder…', run: async () => {
      const name = await promptText('Rename folder', f.name);
      if (name) folders.rename(f.id, name);
    } },
    { label: 'New subfolder…', run: async () => {
      const name = await promptText('Name this folder', 'New folder');
      if (name) folders.create(name, [], f.id);
    } },
    {
      label: 'Move to',
      submenu: [
        { label: 'Top level', checked: !f.parent, run: () => folders.moveFolder(f.id, null) },
        '-',
        ...folders.list
          .filter((x) => x.id !== f.id && !folders.ancestors(x.id).some((a) => a.id === f.id))
          .map((x) => ({ x, path: folders.path(x.id) }))
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(({ x, path }) => ({ label: path, checked: f.parent === x.id, run: () => folders.moveFolder(f.id, x.id) })),
      ],
    },
    '-',
    { label: 'Delete folder (keeps its contents)', run: () => folders.remove(f.id) },
  ]);
}

export function playlistMenu(p, targets = [p]) {
  const special = playlists.isSpecial(p);
  const many = targets.length > 1;
  return showMenu([
    { label: 'Play', run: () => call('playlist.playTrack', { playlist: p.index, index: 0 }) },
    { label: 'Show', run: () => playlists.activate(p.index) },
    '-',
    { label: 'Rename…', enabled: !special && !many, shortcut: 'F2', run: () => renamePlaylist(p) },
    { label: many ? `Duplicate ${targets.length} playlists` : 'Duplicate', run: async () => {
      for (const t of [...targets].reverse()) await tryCall('playlist.duplicate', { playlistGuid: t.guid });
    } },
    { label: 'Folder', enabled: !targets.some((t) => playlists.isSpecial(t)), submenu: folderMenuItems(targets) },
    { label: 'Save as…', enabled: !many, run: async () => {
      await playlists.activate(p.index);
      await runMainMenuAny(['File/Save playlist...', 'File/Save playlist…', 'Save playlist...']);
    } },
    '-',
    { label: 'Autoplaylist properties…', enabled: p.isAutoplaylist && !many, run: () => editAutoplaylist(p) },
    // Not for Collection and Favourites: their queries are Fusion's.
    ...(special ? [] : [{ label: "foobar2000's autoplaylist editor…", enabled: p.isAutoplaylist && !many, run: () => call('playlist.showAutoplaylistUI', { playlist: p.index }) }]),
    { label: 'Convert to a normal playlist', enabled: p.isAutoplaylist && !special && !many, run: () => call('playlist.removeAutoplaylist', { playlist: p.index }) },
    '-',
    { label: many ? `Delete ${targets.length} playlists` : 'Delete', shortcut: 'Del', run: () => deletePlaylists(targets) },
  ]);
}

export async function deletePlaylists(list) {
  if (!list.length) return;
  const one = list.length === 1;
  const ok = await confirmDialog(one ? `Delete "${list[0].name}"?` : `Delete ${list.length} playlists?`, `${one ? 'This playlist' : 'These playlists'} will be removed. The music files are not touched.`, 'Delete');
  if (!ok) return;
  // Remove by GUID one at a time; indexes shift as playlists go.
  for (const p of list) await tryCall('playlist.remove', { playlistGuid: p.guid });
}

export async function renamePlaylist(p) {
  const name = await promptText('Rename playlist', p.name);
  if (name && name !== p.name) await playlists.rename(p.index, name);
}

export function deletePlaylist(p) {
  return deletePlaylists([p]);
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
  await tryCall('menu.runContextCommandById', { id: cmd.commandId, mode: res.mode, ...expect(cmd, res) });
  return true;
}

export function runMainMenu(path) {
  return tryCall('menu.runMainMenuCommand', { command: path });
}

/** Try several spellings of a main-menu command (menus differ slightly by version). */
export async function runMainMenuAny(paths) {
  for (const command of paths) {
    try {
      await call('menu.runMainMenuCommand', { command });
      return true;
    } catch {
      // try the next spelling
    }
  }
  toast("That foobar2000 command isn't available here");
  return false;
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

export function promptText(title, value = '', hint = '') {
  const input = el('input.dialog-input', { type: 'text', value, spellcheck: false });
  input.addEventListener('focus', () => input.select(), { once: true });
  const body = hint ? el('div', null, el('p', { text: hint }), input) : input;
  return dialog(title, body, (close) => {
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
