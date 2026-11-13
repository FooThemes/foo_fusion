// A panel that slides in over the page from one side: Settings (right) and
// the playlist manager (left). Heading with a close button, Escape closes it,
// and so does a click outside it (not a drag: songs dragged from the page are
// dropped onto playlists in the manager).

import { el } from '../core/util.js';
import { icon } from '../core/icons.js';

// Clicks here don't close a sheet: dialogs and menus it opened.
const KEEP_OPEN = '.dialog-back, .dd-layer, .mock-menu';

/**
 * @param {object} o
 * @param {'left'|'right'} o.side
 * @param {string} o.title  heading (and the dialog's label)
 * @param {string} o.toggle  selector of the button that opens it (its own click toggles it)
 * @param {() => void} o.close  what closing it does (the app keeps track of open sheets)
 * @param {string} [o.className]
 * @param {Node[]} children  what goes under the heading
 */
export function sheet({ side, title, toggle, close, className = '' }, ...children) {
  const closeBtn = el('button.btn-icon.sheet-close', { title: 'Close (Esc)', onclick: () => close() }, icon('close'));
  const node = el(`div.sheet.${side}${className ? '.' + className : ''}`, { role: 'dialog', 'aria-label': title }, el('div.sheet-head', null, el('h2', { text: title }), closeBtn), ...children);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  let down = null;
  document.addEventListener(
    'pointerdown',
    (e) => {
      down = null;
      if (!isOpen() || node.contains(e.target)) return;
      if (e.target.closest?.(`${toggle}, ${KEEP_OPEN}`)) return;
      down = { x: e.clientX, y: e.clientY };
    },
    true,
  );
  document.addEventListener('dragstart', () => (down = null), true);
  document.addEventListener(
    'pointerup',
    (e) => {
      const d = down;
      down = null;
      if (!d || !isOpen()) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6) return; // dragged
      close();
    },
    true,
  );
  const isOpen = () => node.classList.contains('open');
  return {
    node,
    closeBtn,
    get isOpen() {
      return isOpen();
    },
    set(on) {
      node.classList.toggle('open', on);
    },
  };
}
