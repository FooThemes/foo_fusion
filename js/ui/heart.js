// The favourite (heart) toggle used on track rows and in the player bar.

import { el } from '../core/util.js';
import { icon, setIcon } from '../core/icons.js';
import { favourites } from '../data/favourites.js';
import { toast } from './toast.js';

export function heartButton(handle, loved) {
  const b = el('button.heart', { title: loved ? 'Remove from Favorites' : 'Add to Favorites', 'aria-pressed': String(!!loved), dataset: { handle: handle || '' } }, icon(loved ? 'heartFill' : 'heart'));
  b.classList.toggle('on', !!loved);
  // Don't let the row underneath take the click as a selection.
  b.addEventListener('mousedown', (e) => e.stopPropagation());
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const h = b.dataset.handle;
    if (!h) return;
    try {
      await favourites.toggle(h, b.classList.contains('on'));
    } catch {
      toast("Couldn't update the file's tags");
    }
  });
  return b;
}

export function setHeart(b, loved) {
  b.classList.toggle('on', !!loved);
  b.setAttribute('aria-pressed', String(!!loved));
  b.title = loved ? 'Remove from Favorites' : 'Add to Favorites';
  setIcon(b.querySelector('.icon'), loved ? 'heartFill' : 'heart');
}

/** Update every heart for these handles inside root. */
export function refreshHearts(root, handles, on) {
  const set = new Set(handles);
  for (const b of root.querySelectorAll('button.heart')) if (set.has(b.dataset.handle)) setHeart(b, on);
}
