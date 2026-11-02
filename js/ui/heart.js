// The mood toggle used on track rows and in the player bar.
// Click cycles: nothing -> Like it (heart) -> Hate it (broken heart) -> nothing.

import { el } from '../core/util.js';
import { icon, setIcon } from '../core/icons.js';
import { favourites, NEXT } from '../data/favourites.js';
import { toast } from './toast.js';

const LOOK = {
  '': { icon: 'heart', title: 'Like (MOOD: Like it)' },
  like: { icon: 'heartFill', title: 'Liked. Click to dislike (MOOD: Hate it)' },
  hate: { icon: 'heartBroken', title: 'Disliked. Click to clear the mood' },
};

export function heartButton(handle, state) {
  const b = el('button.heart', { dataset: { handle: handle || '' } }, icon('heart'));
  setHeart(b, state);
  // Don't let the row underneath take the click as a selection.
  b.addEventListener('mousedown', (e) => e.stopPropagation());
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const h = b.dataset.handle;
    if (!h) return;
    try {
      await favourites.cycle(h, b.dataset.state || '');
    } catch {
      toast("Couldn't update the file's tags");
    }
  });
  return b;
}

export function setHeart(b, state) {
  state = state === true ? 'like' : state || '';
  const look = LOOK[state] || LOOK[''];
  b.dataset.state = state;
  b.classList.toggle('on', state === 'like');
  b.classList.toggle('hate', state === 'hate');
  b.setAttribute('aria-label', look.title);
  b.title = look.title;
  setIcon(b.querySelector('.icon'), look.icon);
}

/** Update every heart for these handles inside root. */
export function refreshHearts(root, handles, state) {
  const set = new Set(handles);
  for (const b of root.querySelectorAll('button.heart')) if (set.has(b.dataset.handle)) setHeart(b, state);
}

export { NEXT };
