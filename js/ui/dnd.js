// Drag and drop inside Fusion:
//  - songs/albums -> a playlist (in the left panel or the playlist manager)
//  - playlists -> another position in the list (reorder)

import { el } from '../core/util.js';
import { tryCall } from '../core/bridge.js';
import { view } from '../data/view.js';
import { playlists } from '../data/playlists.js';
import { folders } from '../data/folders.js';
import { toast } from './toast.js';

const ROWS = 'application/x-fusion-rows';
const PLAYLIST = 'application/x-fusion-playlist';

/**
 * Songs dragged out of `container` (rows inside it must be draggable).
 * getRows(e) returns the playlist rows to drag, read at drag time.
 */
export function draggableRows(container, getRows) {
  container.addEventListener('dragstart', (e) => {
    const rows = getRows(e);
    if (!rows?.length || !view.playlist) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(ROWS, JSON.stringify({ guid: view.playlist.guid, rows }));
    e.dataTransfer.setDragImage(dragBadge(rows.length === 1 ? '1 song' : `${rows.length} songs`), 12, 12);
  });
}

/** Rows to drag for a row element: the whole selection if it's part of it. */
export function selectionOr(row) {
  return view.selection.has(row) ? [...view.selection].sort((a, b) => a - b) : [row];
}

/** Make a playlist list item draggable for reordering. */
export function draggablePlaylist(node, p) {
  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(PLAYLIST, p.guid);
  });
}

/** A playlist item that accepts dropped songs and reordered playlists. */
export function playlistDropTarget(node, getPlaylist) {
  const accepts = (e) => {
    const p = getPlaylist();
    if (!p) return null;
    const types = e.dataTransfer.types;
    if (types.includes(PLAYLIST)) return 'move';
    if (types.includes(ROWS) && !p.isAutoplaylist && !p.isLocked) return 'copy';
    return null;
  };
  node.addEventListener('dragover', (e) => {
    const kind = accepts(e);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = kind;
    const r = node.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    node.classList.toggle('drop-into', kind === 'copy');
    node.classList.toggle('drop-before', kind === 'move' && !after);
    node.classList.toggle('drop-after', kind === 'move' && after);
  });
  const clearMarks = () => node.classList.remove('drop-into', 'drop-before', 'drop-after');
  node.addEventListener('dragleave', clearMarks);
  node.addEventListener('drop', async (e) => {
    const after = node.classList.contains('drop-after');
    clearMarks();
    const p = getPlaylist();
    if (!p) return;
    e.preventDefault();
    const guid = e.dataTransfer.getData(PLAYLIST);
    if (guid) return movePlaylist(guid, p, after);
    const payload = e.dataTransfer.getData(ROWS);
    if (!payload) return;
    const { guid: src, rows } = JSON.parse(payload);
    if (src !== view.playlist?.guid || p.guid === src) return;
    const n = await view.addRowsTo(p.index, rows);
    toast(`Added ${n === 1 ? '1 song' : `${n} songs`} to ${p.name}`);
  });
}

async function movePlaylist(guid, target, after) {
  const order = playlists.list.map((p) => p.guid).filter((g) => g !== guid);
  let at = order.indexOf(target.guid);
  if (at < 0 || guid === target.guid) return;
  if (after) at++;
  order.splice(at, 0, guid);
  await tryCall('playlist.reorderPlaylists', { newOrderGuids: order });
  // Dropped next to a playlist: join (or leave) that playlist's folder.
  const into = folders.folderOf(target.guid);
  if (into?.id !== folders.folderOf(guid)?.id) await folders.move([guid], into ? into.id : null);
}

/** A folder header that takes dropped playlists into the folder. */
export function folderDropTarget(node, folder) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(PLAYLIST)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-into');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-into'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('drop-into');
    const guid = e.dataTransfer.getData(PLAYLIST);
    if (!guid) return;
    e.preventDefault();
    folders.move([guid], folder.id);
  });
}

function dragBadge(text) {
  let b = document.getElementById('drag-badge');
  if (!b) {
    b = el('div', { id: 'drag-badge' });
    document.body.append(b);
  }
  b.textContent = text;
  return b;
}
