// Menus and small dialogs. Native popup menus come from foo_ui_webview2
// (ui.showCustomMenu / menu.showNativePopup); text prompts are drawn in-page.

import { call, tryCall, onAny } from '../core/bridge.js';
import { toggleMini, isMini } from './mini.js';
import { el, winPath } from '../core/util.js';
import { tidyItems } from './dropdown.js';
import { playlists } from '../data/playlists.js';
import { view } from '../data/view.js';
import { toast } from './toast.js';
import { editAutoplaylist } from './autoplaylist.js';
import { folders } from '../data/folders.js';
import * as store from '../core/store.js';
import { player } from '../data/player.js';
import { refreshArt } from '../data/artwork.js';
import { openModal } from './modal.js';
import { changeIconDialog } from './iconpicker.js';

/** Show a native menu built from [{ id, label, checked, enabled, submenu, run }]. */
export async function showMenu(items) {
  const actions = new Map();
  let n = 0;
  const convert = (list) =>
    tidyItems(list).map((it) => {
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
    { label: 'Mini player', shortcut: 'Alt+M', checked: isMini(), run: () => toggleMini() },
    '-',
    { label: 'foobar2000', submenu: fbItems.length ? fbItems : [{ label: 'Unavailable', enabled: false }] },
    { label: 'Preferences', shortcut: 'Ctrl+P', run: () => tryCall('misc.showPreferences') },
  ]);
}

/**
 * foobar2000's own context menu for playlist rows, with Fusion's `extra`
 * items (e.g. "Refresh artwork") at the top.
 */
export async function trackContextMenu(rows, extra = [], { select = true } = {}) {
  if (!rows.length) return;
  // For a whole album or disc (its cover, title or disc entry): the menu acts
  // on those songs without selecting them in the list.
  if (!select) {
    const handles = await handlesOf(rows);
    return handles.length ? contextMenu({ mode: 'handles', handles }, extra) : null;
  }
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
export async function contextMenu(target, extra = [], { hoist = [] } = {}) {
  if (!extra.length && target.mode !== 'handles') return tryCall('menu.showNativePopup', target);
  const items = await contextItems(target);
  // foobar2000's own items Fusion already offers above ("Play") aren't
  // listed twice; `hoist`ed ones move up beside Fusion's first item.
  const { mine, rest } = mergeItems(extra, items, hoist);
  return showMenu(rest.length ? [...mine, '-', ...rest] : mine);
}

/** foobar2000's context menu for `target`, as showMenu() items. */
export async function contextItems(target) {
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
  return conv(res?.items);
}

/**
 * Fusion's items with foobar2000's: theirs that repeat ours are dropped, and
 * the `hoist`ed ones move up to just after our first item.
 */
function mergeItems(extra, items, hoist = []) {
  const ours = new Set(extra.filter((x) => x && x !== '-').map((x) => x.label));
  let rest = items.filter((it) => it === '-' || !ours.has(it.label));
  const lifted = rest.filter((it) => it !== '-' && hoist.includes(it.label));
  rest = rest.filter((it) => !lifted.includes(it));
  return { mine: lifted.length ? [extra[0], ...lifted, ...extra.slice(1)] : extra, rest };
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

// Above this many songs, Contents is read only when it's clicked: reading a
// big playlist's menu holds foobar2000 up for a moment.
const CONTENTS_MAX = 1500;
// foobar2000's items that Contents leaves out (Play and the queue are on the
// menu itself; one folder for a whole playlist means little).
const CONTENTS_SKIP = new Set(['Play', 'Add to playback queue', 'Open containing folder']);

export async function playlistMenu(p, targets = [p]) {
  const special = playlists.isSpecial(p);
  const many = targets.length > 1;
  const songs = targets.reduce((n, t) => n + (t.trackCount || 0), 0);
  const play = { label: 'Play', run: () => call('playlist.playTrack', { playlist: p.index, index: 0 }) };
  const queue = {
    label: 'Add to playback queue',
    enabled: songs > 0,
    run: async () => {
      for (const t of targets) if (t.trackCount) await tryCall('queue.add', { playlistGuid: t.guid, tracks: Array.from({ length: t.trackCount }, (_, i) => i) });
    },
  };
  // Contents: foobar2000's menu for every song in them (file operations,
  // tagging, ReplayGain …). A real submenu when the playlists are small
  // enough to read before the menu opens; otherwise opened by a click.
  let contents;
  if (!songs) contents = { label: 'Contents', enabled: false, submenu: [{ label: 'Empty', enabled: false }] };
  else if (songs > CONTENTS_MAX) contents = { label: 'Contents…', run: () => contentsMenu(targets) };
  else {
    const items = await busy(() => contentsItems(targets));
    contents = { label: 'Contents', enabled: items.length > 0, submenu: items.length ? items : [{ label: 'Empty', enabled: false }] };
  }
  return showMenu([
    play,
    queue,
    { label: 'Show', run: () => playlists.activate(p.index) },
    '-',
    { label: 'Rename…', enabled: !special && !many, shortcut: 'F2', run: () => renamePlaylist(p) },
    { label: 'Change icon…', enabled: !special && !many, run: () => changeIconDialog(p) },
    { label: many ? `Duplicate ${targets.length} playlists` : 'Duplicate', run: async () => {
      for (const t of [...targets].reverse()) await tryCall('playlist.duplicate', { playlistGuid: t.guid });
    } },
    { label: 'Folder', enabled: !targets.some((t) => playlists.isSpecial(t)), submenu: folderMenuItems(targets) },
    contents,
    { label: 'Save as…', enabled: !many, run: async () => {
      await playlists.activate(p.index);
      await runMainMenuAny(['File/Save playlist...', 'File/Save playlist…', 'Save playlist...']);
    } },
    // Autoplaylist items only for autoplaylists; Collection and Favourites
    // (Fusion's own queries) can't be converted, edited in foobar2000 or deleted.
    ...(p.isAutoplaylist && !many
      ? [
          '-',
          { label: 'Autoplaylist properties…', run: () => editAutoplaylist(p) },
          ...(special
            ? []
            : [
                { label: "foobar2000's autoplaylist editor…", run: () => call('playlist.showAutoplaylistUI', { playlist: p.index }) },
                { label: 'Convert to a normal playlist', run: () => call('playlist.removeAutoplaylist', { playlist: p.index }) },
              ]),
        ]
      : []),
    ...(targets.some((t) => playlists.isSpecial(t)) ? [] : ['-', { label: many ? `Delete ${targets.length} playlists` : 'Delete', shortcut: 'Del', run: () => deletePlaylists(targets) }]),
  ]);
}

/** foobar2000's menu items for every song in these playlists, less CONTENTS_SKIP. */
async function contentsItems(targets) {
  const handles = await playlistHandles(targets);
  if (!handles.length) return [];
  const items = await contextItems({ mode: 'handles', handles });
  return items.filter((it) => it === '-' || !CONTENTS_SKIP.has(it.label));
}

/**
 * Contents for a big playlist, read when it's clicked. foobar2000 is held up
 * while it works out the menu, and its window can't change the pointer
 * meanwhile, so a small menu saying so opens where the click was first and
 * gives way to the real one when it's ready.
 */
async function contentsMenu(targets) {
  const songs = targets.reduce((n, t) => n + (t.trackCount || 0), 0);
  const waiting = await tryCall('menu.show', {
    items: [{ id: 'wait', label: `Reading ${songs.toLocaleString()} songs…`, enabled: false }],
    windowModel: 'contentSized',
    backdropDarkMode: !!store.get('dark'),
  });
  // Drawn before foobar2000 gets busy.
  if (waiting?.menuId) await new Promise((r) => setTimeout(r, 150));
  let items;
  try {
    items = await busy(() => contentsItems(targets));
  } finally {
    if (waiting?.menuId) await tryCall('menu.close', { reason: 'api' });
  }
  if (!items.some((it) => it !== '-')) return toast('Nothing to show for those songs.');
  return showMenu(items);
}

/** Run `fn` with the busy pointer showing (drawn before the work starts). */
async function busy(fn) {
  const root = document.documentElement;
  root.classList.add('busy');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    return await fn();
  } finally {
    root.classList.remove('busy');
  }
}

// Every song's handle in a playlist, kept until its songs change.
const handleCache = new Map(); // guid -> { count, handles }
let watchingLists = false;
async function playlistHandles(targets) {
  if (!watchingLists) {
    watchingLists = true;
    onAny(['playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReordered', 'playlist:itemsReplaced', 'playlist:removed'], () => handleCache.clear());
  }
  const all = [];
  for (const t of targets) {
    let c = handleCache.get(t.guid);
    if (!c || c.count !== t.trackCount) {
      const handles = [];
      for (let i = 0; i < t.trackCount; i += 4000) {
        const res = await tryCall('playlist.getTracks', { playlistGuid: t.guid, start: i, count: Math.min(4000, t.trackCount - i), fields: ['handle'] });
        if (!res) break;
        for (const x of res.tracks) if (x.handle) handles.push(x.handle);
      }
      c = { count: t.trackCount, handles };
      handleCache.set(t.guid, c);
    }
    all.push(...c.handles);
  }
  return [...new Set(all)];
}

export async function deletePlaylists(list) {
  // Collection and Favourites stay (Fusion depends on them).
  list = list.filter((p) => !playlists.isSpecial(p));
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

/** Run a foobar2000 context-menu command (by its label) on these songs. */
/** Whether the context menu for these songs has this command (e.g. a component's). */
const hasCache = new Map();
export async function hasHandlesCommand(label, handles) {
  if (hasCache.get(label)) return true;
  if (!handles?.length) return false;
  const res = await tryCall('menu.getContextMenu', { mode: 'handles', handles, withAvailability: false, i18n: false });
  const want = label.toLowerCase();
  const find = (nodes) => (nodes || []).some((n) => (n.type === 'command' && clean(n.label).toLowerCase() === want) || find(n.children));
  const has = find(res?.items);
  if (has) hasCache.set(label, true);
  return has;
}

export async function runHandlesCommand(label, handles) {
  if (!handles?.length) return false;
  const res = await tryCall('menu.getContextMenu', { mode: 'handles', handles, withAvailability: false, i18n: false });
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
  await tryCall('menu.runContextCommandById', { id: cmd.commandId, mode: res.mode, handles, ...expect(cmd, res) });
  return true;
}

/**
 * Refresh albums: foobar2000 re-reads their tags from the files ("Reload
 * info"), and their covers are looked up again.
 */
export async function refreshAlbums(rows) {
  const handles = await handlesOf(rows);
  if (!handles.length) return;
  await runHandlesCommand('Reload info', handles);
  refreshArt(handles);
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

export function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    let remove = null;
    const close = (v) => {
      remove();
      resolve(v);
    };
    const box = el('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('h2', { text: title }), body, el('div.dialog-buttons', null, buttons(close)));
    remove = openModal(box, { cancel: () => close(null) });
    (box.querySelector('input') || box.querySelector('button.btn-primary'))?.focus();
  });
}

/**
 * Ask for a folder or file path: a text box with a Browse button (the
 * system's own picker). Resolves with the path, or null when cancelled.
 */
export function promptPath(title, hint, { value = '', placeholder = '', folder = true, filter = null, okLabel = 'OK' } = {}) {
  const input = el('input.field', { type: 'text', value, placeholder, spellcheck: false });
  const browse = el('button.btn-text.dialog-browse', {
    type: 'button',
    text: 'Browse…',
    onclick: async () => {
      const start = winPath(input.value);
      const res = folder
        ? await tryCall('dialog.openFolder', { title, defaultPath: start })
        : await tryCall('dialog.openFile', { title, defaultPath: start.replace(/[\\/][^\\/]*$/, ''), ...(filter ? { filters: [filter] } : {}) });
      const picked = folder ? res?.folderPath : res?.filePaths?.[0] || res?.filePath;
      if (picked) input.value = picked;
      input.focus();
    },
  });
  const body = el('div', null, hint ? el('p', { text: hint }) : null, el('div.dialog-path', null, input, browse));
  return dialog(title, body, (close) => {
    const done = () => close(winPath(input.value) || null);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && done());
    return [el('button.btn-primary', { text: okLabel, onclick: done }), el('button.btn-text', { text: 'Cancel', onclick: () => close(null) })];
  });
}

export function promptText(title, value = '', hint = '') {
  const input = el('input.field', { type: 'text', value, spellcheck: false });
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
