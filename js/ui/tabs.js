// A row of tabs, one picked: the Collection's Albums/Artists/… tabs, the
// Settings and info panel pages, choices like Light/Dark. Two looks (see
// base.css): blocks (the default) and underlined ('line').

import { el } from '../core/util.js';

/**
 * @param {[string, string][]} items  [id, label] pairs
 * @param {object} o
 * @param {(id: string, e: MouseEvent) => void} o.onPick
 * @param {string} [o.picked]  the tab shown picked to start with
 * @param {string} [o.className]  extra classes for the row: 'line', 'small', or its own
 * @param {string} [o.label]  what the tabs choose (for screen readers)
 */
export function tabBar(items, { onPick, picked, className = '', label } = {}) {
  const node = el('div.tabs' + (className ? '.' + className.split(' ').join('.') : ''), { role: 'tablist', 'aria-label': label });
  for (const [id, text] of items) {
    node.append(el('button.tab', { type: 'button', role: 'tab', dataset: { id: String(id) }, text, onclick: (e) => onPick(id, e) }));
  }
  // Ids can be true/false (Light/Dark): compared as text.
  const set = (id) => {
    for (const b of node.children) {
      const on = b.dataset.id === String(id);
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
  };
  if (picked != null) set(picked);
  return { node, set };
}
