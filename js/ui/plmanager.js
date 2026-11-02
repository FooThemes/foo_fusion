// Playlist manager (Ctrl+M): Fusion's stand-in for foobar2000's Default UI
// Playlist Manager panel, which can't be hosted inside the WebView2 UI.
// Every playlist, including Collection and Favourites; click to show, double-
// click to play, drag to reorder, drop songs on a playlist to add them,
// F2 to rename, Delete to remove, right-click for the rest.

import { el, clear, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import { call, tryCall } from '../core/bridge.js';
import { playlists } from '../data/playlists.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import * as store from '../core/store.js';
import { playlistMenu, promptText, renamePlaylist, deletePlaylists, runMainMenuAny, folderMenu } from './menus.js';
import { draggablePlaylist, playlistDropTarget, folderDropTarget, draggableFolder } from './dnd.js';
import { newPlaylistDialog } from './autoplaylist.js';
import { folders } from '../data/folders.js';

export function mountPlaylistManager(root, app) {
  const list = el('div.plm-list', { role: 'listbox', 'aria-label': 'Playlists', 'aria-multiselectable': 'true', tabindex: 0 });
  const status = el('div.plm-status');
  const panel = el(
    'div.plm',
    { role: 'dialog', 'aria-label': 'Playlist manager' },
    el('div.plm-head', null, el('h2', { text: 'Playlists' }), el('button.btn-icon', { title: 'Close (Esc)', onclick: () => open(false) }, icon('close'))),
    el(
      'div.plm-tools',
      null,
      tool('add', 'New', 'New playlist or autoplaylist (Ctrl+N)', () => newPlaylistDialog()),
      tool('folder', 'Folder', 'New folder (for the selected playlists)', async () => {
        const name = await promptText('Name this folder', 'New folder');
        if (name) folders.create(name, chosen().filter((p) => !playlists.isSpecial(p)).map((p) => p.guid));
      }),
      tool('open', 'Load', 'Load a playlist file', () => runMainMenuAny(['File/Load playlist...', 'File/Load playlist…', 'Load playlist...'])),
      tool('sortAsc', 'Sort', 'Sort playlists by name', sortByName),
    ),
    list,
    status,
  );
  root.append(panel);

  let selected = new Set(); // GUIDs
  let anchor = null;

  function render() {
    clear(list);
    const np = view.mode === 'nowplaying';
    const playlistRow = (p, nested) => {
      const row = el(
        'div.plm-row' + (nested ? '.nested' : ''),
        { role: 'option', tabindex: -1, dataset: { guid: p.guid }, title: `${p.name}\n${plural(p.trackCount, 'song')}${p.isAutoplaylist ? ' · autoplaylist' : ''}${p.isLocked ? ' · locked' : ''}` },
        icon(p.isAutoplaylist ? 'autoplaylist' : playlists.isSpecial(p) ? 'collection' : 'playlist'),
        el('span.plm-name.ellipsis', { text: p.name }),
        p.isPlaying ? el('span.plm-playing', { title: 'Playing' }, icon('nowPlaying')) : null,
        el('span.plm-count', { text: p.trackCount.toLocaleString() }),
      );
      row.classList.toggle('active', !np && p.index === playlists.active);
      row.classList.toggle('selected', selected.has(p.guid));
      row.setAttribute('aria-selected', String(selected.has(p.guid)));
      draggablePlaylist(row, p);
      playlistDropTarget(row, () => playlists.list.find((x) => x.guid === p.guid));
      row.addEventListener('mousedown', (e) => select(p, e));
      row.addEventListener('click', (e) => {
        if (e.ctrlKey || e.shiftKey) return;
        if (view.mode === 'nowplaying') view.setMode(store.get('view'), { load: p.index === playlists.active });
        playlists.activate(p.index);
      });
      row.addEventListener('dblclick', () => call('playlist.playTrack', { playlist: p.index, index: 0 }));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const targets = selected.has(p.guid) ? chosen() : [p];
        playlistMenu(p, targets);
      });
      return row;
    };
    for (const node of folders.rows()) {
      if (node.type === 'playlist') {
        const row = playlistRow(node.p, node.depth > 0);
        row.style.setProperty('--depth', node.depth);
        list.append(row);
        continue;
      }
      const f = node.folder;
      const head = el(
        'div.plm-row.plm-folder',
        { title: `${f.name}\n${plural(node.members.length, 'playlist')}`, 'aria-expanded': String(!f.collapsed) },
        icon(f.collapsed ? 'chevronRight' : 'chevronDown', 'chev'),
        icon('folder'),
        el('span.plm-name.ellipsis', { text: f.name }),
        el('span.plm-count', { text: String(node.members.length) }),
      );
      head.style.setProperty('--depth', node.depth);
      head.addEventListener('click', () => folders.toggle(f.id));
      head.addEventListener('contextmenu', (e) => (e.preventDefault(), folderMenu(f)));
      draggableFolder(head, f);
      folderDropTarget(head, f);
      list.append(head);
    }
    // Playlists overlap (Collection holds everything), so a song total would mislead.
    status.textContent = `${plural(playlists.list.length, 'playlist')}${selected.size > 1 ? ` · ${selected.size} selected` : ''}`;
  }

  function select(p, e) {
    if (e.button === 2 && selected.has(p.guid)) return;
    const order = playlists.list.map((x) => x.guid);
    if (e.shiftKey && anchor) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(p.guid)].sort((x, y) => x - y);
      if (!e.ctrlKey) selected.clear();
      order.slice(a, b + 1).forEach((g) => selected.add(g));
    } else if (e.ctrlKey) {
      selected.has(p.guid) ? selected.delete(p.guid) : selected.add(p.guid);
      anchor = p.guid;
    } else {
      selected = new Set([p.guid]);
      anchor = p.guid;
    }
    render();
  }

  function chosen() {
    return playlists.list.filter((p) => selected.has(p.guid));
  }

  list.addEventListener('keydown', async (e) => {
    const sel = chosen();
    const order = playlists.list;
    const at = order.findIndex((p) => p.guid === anchor);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = order[Math.min(order.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        select(next, { button: 0, shiftKey: e.shiftKey, ctrlKey: false });
        list.querySelector(`[data-guid="${next.guid}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter' && sel.length === 1) {
      playlists.activate(sel[0].index);
    } else if (e.key === 'F2' && sel.length === 1) {
      renamePlaylist(sel[0]);
    } else if (e.key === 'Delete' && sel.length) {
      deletePlaylists(sel);
    } else if (e.key === 'a' && e.ctrlKey) {
      e.preventDefault();
      selected = new Set(order.map((p) => p.guid));
      render();
    } else if (e.key === 'Escape') {
      open(false);
    } else return;
    e.stopPropagation();
  });

  async function sortByName() {
    // A–Z, keeping Collection/Favourites on top and each folder's playlists together.
    const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const special = playlists.list.filter((p) => playlists.isSpecial(p));
    const name = (n) => (n.type === 'folder' ? n.folder.name : n.p.name);
    const flat = (nodes) =>
      [...nodes]
        .filter((n) => n.type === 'folder' || !playlists.isSpecial(n.p))
        .sort((a, b) => cmp(name(a), name(b)))
        .flatMap((n) => (n.type === 'folder' ? flat(n.children) : [n.p]));
    const rest = flat(folders.tree());
    const hidden = playlists.list.filter((p) => playlists.isHidden(p));
    rest.push(...hidden);
    await call('playlist.reorderPlaylists', { newOrderGuids: [...special, ...rest].map((p) => p.guid) });
  }

  function open(on = !panel.classList.contains('open')) {
    panel.classList.toggle('open', on);
    if (on) {
      const act = playlists.activePlaylist;
      if (act && !selected.size) {
        selected = new Set([act.guid]);
        anchor = act.guid;
      }
      render();
      setTimeout(() => list.focus({ preventScroll: true }), 230);
    }
  }

  playlists.on('change', () => panel.classList.contains('open') && render());
  folders.on('change', () => panel.classList.contains('open') && render());
  playlists.on('active', () => panel.classList.contains('open') && render());
  player.on('track', () => panel.classList.contains('open') && render());

  return {
    open,
    get isOpen() {
      return panel.classList.contains('open');
    },
  };
}

function tool(iconName, label, title, onclick) {
  return el('button.plm-tool', { title, onclick }, icon(iconName), el('span', { text: label }));
}
