import { el } from '../core/util.js';

let current = null;

/**
 * Brief message above the player bar. With `action` ({ label, run }), a
 * button follows the text; using it closes the message.
 */
export function toast(text, ms = 2200, action = null) {
  current?.remove();
  const node = el('div.toast', { role: 'status' }, el('span', { text }));
  if (action) {
    node.classList.add('has-action');
    node.append(
      el('button.toast-action', {
        text: action.label,
        onclick: () => {
          node.remove();
          action.run();
        },
      }),
    );
  }
  document.body.append(node);
  current = node;
  setTimeout(() => node.remove(), ms);
}
