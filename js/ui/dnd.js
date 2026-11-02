// Drag and drop inside Fusion:
//  - songs/albums -> a playlist (in the left panel or the playlist manager)
//  - playlists and folders -> another place in the list (reorder / nest)
//  - songs in Now playing -> another place in the queue or playlist
//
// Done with pointer events, not HTML5 drag and drop. An HTML5 drag runs
// Windows' drag loop on foobar2000's main thread, and now and then that loop
// never ended: the window kept scrolling but ignored clicks and keys until
// foobar2000 was restarted. Pointer dragging stays inside the page, so there
// is no loop to get stuck in. (Dropping files from Explorer onto the window
// is a different path and isn't affected.)

import { el } from '../core/util.js';
import { tryCall } from '../core/bridge.js';
import { view } from '../data/view.js';
import { playlists } from '../data/playlists.js';
import { folders } from '../data/folders.js';
import { toast } from './toast.js';

const THRESHOLD = 6; // px of movement before a press becomes a drag
const targets = new WeakMap(); // node -> { accept, over, drop }
let pending = null; // { x, y, event, sources: [getPayload] } between press and drag
let drag = null; // { payload, target, mark }

// No HTML5 drags start from the page at all (images, links, selected text).
document.addEventListener('dragstart', (e) => e.preventDefault(), true);

/**
 * Let a press on `node` (or anything inside it) start a drag. getPayload(e)
 * gets the pointerdown event and returns { type, label, ... } or null. When
 * nested sources all see the press, the innermost one with a payload wins.
 */
export function dragSource(node, getPayload) {
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    // Not from a control inside the draggable thing (a heart, a play button).
    const control = e.target.closest('button, input, textarea, select, a, .no-drag');
    if (control && control !== node && node.contains(control)) return;
    if (!pending || pending.event !== e) pending = { x: e.clientX, y: e.clientY, event: e, sources: [] };
    pending.sources.push(getPayload);
  });
}

/**
 * A place things can be dropped. accept(payload) -> truthy if it takes it;
 * over(payload, info) -> 'into' | 'before' | 'after' (the mark to show);
 * drop(payload, info) does the work. info: { x, y, after }.
 */
export function dropTarget(node, handlers) {
  targets.set(node, handlers);
}

window.addEventListener(
  'pointermove',
  (e) => {
    if (!pending && !drag) return;
    if (!drag) {
      if (!(e.buttons & 1)) return cancel();
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < THRESHOLD) return;
      let payload = null;
      for (const get of pending.sources) if ((payload = get(pending.event))) break;
      pending = null;
      if (!payload) return;
      drag = { payload, target: null, node: null, mark: null };
      document.body.classList.add('pdragging');
      window.getSelection()?.removeAllRanges();
      badge().textContent = payload.label || '';
      badge().hidden = !payload.label;
    }
    badge().style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
    // What's under the pointer (the badge itself doesn't take pointer events).
    let node = document.elementFromPoint(e.clientX, e.clientY);
    let found = null;
    while (node && !found) {
      const t = targets.get(node);
      if (t && t.accept(drag.payload)) found = { node, t };
      else node = node.parentElement;
    }
    const info = found && infoFor(found.node, e);
    const mark = found ? found.t.over?.(drag.payload, info) || 'into' : null;
    if (found?.node !== drag.node || mark !== drag.mark) {
      clearMark();
      drag.node = found?.node || null;
      drag.target = found?.t || null;
      drag.mark = mark;
      if (drag.node) drag.node.classList.add('drop-' + mark);
    }
  },
  true,
);

window.addEventListener(
  'pointerup',
  (e) => {
    if (!drag) {
      pending = null;
      return;
    }
    const { payload, target, node } = drag;
    const info = node && infoFor(node, e);
    finish();
    // The press that ended a drag isn't also a click on what's underneath.
    const swallow = (ev) => (ev.stopPropagation(), ev.preventDefault());
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 50);
    if (target && node) Promise.resolve(target.drop(payload, info)).catch((err) => console.error('[fusion] drop failed:', err));
  },
  true,
);

window.addEventListener('pointercancel', () => cancel(), true);
window.addEventListener('blur', () => cancel());
window.addEventListener(
  'keydown',
  (e) => {
    if (drag && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  },
  true,
);

function infoFor(node, e) {
  const r = node.getBoundingClientRect();
  return { x: e.clientX, y: e.clientY, after: e.clientY > r.top + r.height / 2 };
}

function clearMark() {
  drag?.node?.classList.remove('drop-into', 'drop-before', 'drop-after');
}

function finish() {
  clearMark();
  drag = null;
  pending = null;
  document.body.classList.remove('pdragging');
  badge().hidden = true;
}

function cancel() {
  if (drag) finish();
  pending = null;
}

function badge() {
  let b = document.getElementById('drag-badge');
  if (!b) {
    b = el('div', { id: 'drag-badge', hidden: true });
    document.body.append(b);
  }
  return b;
}

// --- Fusion's drags -----------------------------------------------------

/** Songs dragged out of `container`; getRows(e) gives the playlist rows. */
export function draggableRows(container, getRows) {
  dragSource(container, (e) => {
    const rows = getRows(e);
    if (!rows?.length || !view.playlist) return null;
    return { type: 'rows', guid: view.playlist.guid, rows, label: rows.length === 1 ? '1 song' : `${rows.length} songs` };
  });
}

/** Rows to drag for a row element: the whole selection if it's part of it. */
export function selectionOr(row) {
  return view.selection.has(row) ? [...view.selection].sort((a, b) => a - b) : [row];
}

export function draggablePlaylist(node, p) {
  dragSource(node, () => ({ type: 'playlist', guid: p.guid, label: p.name }));
}

export function draggableFolder(node, f) {
  dragSource(node, () => ({ type: 'folder', id: f.id, label: f.name }));
}

/** A playlist item: takes songs (copy into it) and playlists/folders (reorder). */
export function playlistDropTarget(node, getPlaylist) {
  dropTarget(node, {
    accept(d) {
      const p = getPlaylist();
      if (!p) return false;
      if (d.type === 'playlist') return d.guid !== p.guid;
      if (d.type === 'folder') return true;
      return d.type === 'rows' && !p.isAutoplaylist && !p.isLocked && d.guid !== p.guid;
    },
    over: (d, info) => (d.type === 'rows' ? 'into' : info.after ? 'after' : 'before'),
    async drop(d, info) {
      const p = getPlaylist();
      if (!p) return;
      if (d.type === 'folder') return folders.moveFolder(d.id, folders.folderOf(p.guid)?.id || null);
      if (d.type === 'playlist') return movePlaylist(d.guid, p, info.after);
      if (d.guid !== view.playlist?.guid) return;
      const n = await view.addRowsTo(p.index, d.rows);
      toast(`Added ${n === 1 ? '1 song' : `${n} songs`} to ${p.name}`);
    },
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

/** A folder header: takes playlists, and folders (as subfolders). */
export function folderDropTarget(node, folder) {
  dropTarget(node, {
    accept: (d) => d.type === 'playlist' || (d.type === 'folder' && d.id !== folder.id),
    over: () => 'into',
    drop: (d) => (d.type === 'playlist' ? folders.move([d.guid], folder.id) : folders.moveFolder(d.id, folder.id)),
  });
}
