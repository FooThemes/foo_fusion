// A dialog over a dimmed page: every dialog (prompts, the playlist and
// autoplaylist editor, artist/genre information, custom columns) opens
// through this. Escape or a click outside cancels; keys typed in it don't
// reach the page behind.

import { el } from '../core/util.js';

/**
 * Show `box`. `cancel`: what Escape and a click outside do; `onKey`: other
 * keys. Returns a function that removes it.
 */
export function openModal(box, { cancel, onKey } = {}) {
  const back = el('div.dialog-back', { onmousedown: (e) => e.target === back && cancel?.() }, box);
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel?.();
    else onKey?.(e);
    e.stopPropagation();
  });
  document.getElementById('overlay-root').append(back);
  return () => back.remove();
}
