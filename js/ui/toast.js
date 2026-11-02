import { el } from '../core/util.js';

let current = null;

/** Brief message above the player bar. */
export function toast(text, ms = 2200) {
  current?.remove();
  const node = el('div.toast', { role: 'status', text });
  document.body.append(node);
  current = node;
  setTimeout(() => node.remove(), ms);
}
