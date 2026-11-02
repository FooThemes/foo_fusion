// Popup bar shown when songs are selected (bottom-right of the main area):
// count, Play, Add to, Queue, Remove, Clear.

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { view } from '../data/view.js';
import { showMenu, addToItems } from './menus.js';
import { favourites } from '../data/favourites.js';
import { toast } from './toast.js';

export function mountSelectionBar(root) {
  const bar = el('div.selbar', { hidden: true, role: 'toolbar', 'aria-label': 'Selected songs' });
  root.append(bar);

  function render() {
    const rows = [...view.selection].sort((a, b) => a - b);
    const show = store.get('selectionBar') && rows.length > 0 && view.mode !== 'nowplaying';
    bar.hidden = !show;
    if (!show) return;
    clear(bar).append(...[
      el('div.selbar-count', { text: rows.length, title: `${rows.length} selected` }),
      b('play', 'Play', () => view.play(rows[0])),
      b('add', 'Add to', () => showMenu(addToItems(rows))),
      b('queue', 'Add to queue', () => view.queueRows(rows)),
      b('heart', 'Add to Favorites', async () => {
        const handles = await view.handlesFor(rows);
        try {
          await favourites.set(handles, 'like');
          toast(`Added ${rows.length} to Favorites`);
        } catch {
          toast("Couldn't update the files' tags");
        }
      }),
      b('heartBroken', 'Dislike (MOOD: Hate it)', async () => {
        const handles = await view.handlesFor(rows);
        try {
          await favourites.set(handles, 'hate');
          toast(`Marked ${rows.length} as disliked`);
        } catch {
          toast("Couldn't update the files' tags");
        }
      }),
      view.canEdit ? b('delete', 'Remove from playlist', () => view.removeRows(rows)) : null,
      b('close', 'Clear selection', () => view.clearSelection()),
    ].filter(Boolean));
  }

  view.on('selection', render);
  view.on('mode', render);
  view.on('change', render);
  store.subscribe((k) => k === 'selectionBar' && render());
}

function b(name, label, onclick) {
  return el('button.selbar-btn', { title: label, 'aria-label': label, onclick }, icon(name));
}
