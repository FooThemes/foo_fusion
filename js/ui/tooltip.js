// Fusion's own hover boxes for everything with a title. The browser's are
// drawn inside the WebView's window and get cut off at its edges (the "…"
// button at the bottom right, say); these are placed to fit: below the
// pointer's element, or above it when there's no room below.
//
// A `title` is moved to data-tip on hover (so the browser doesn't show its
// own as well) and kept for screen readers as aria-description.

import { el } from '../core/util.js';

const DELAY = 550;
const GAP = 8;

export function installTooltips() {
  const tip = el('div.tip', { hidden: true, role: 'tooltip' });
  document.body.append(tip);
  let target = null;
  let timer = 0;
  let x = 0;

  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.hidden = true;
  };

  const show = () => {
    const text = target?.isConnected && target.dataset.tip;
    if (!text) return (tip.hidden = true);
    tip.textContent = text;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const below = r.bottom + GAP;
    const above = r.top - GAP - h;
    // Below if it fits, else above; if neither (a tiny window), not at all.
    const top = below + h <= innerHeight - 4 ? below : above >= 4 ? above : null;
    if (top == null) return (tip.hidden = true);
    tip.style.top = top + 'px';
    tip.style.left = Math.max(4, Math.min(x - w / 2, innerWidth - w - 4)) + 'px';
  };

  document.addEventListener(
    'pointerover',
    (e) => {
      const node = e.target.closest?.('[title], [data-tip]');
      if (node === target) return;
      hide();
      if (!node) return;
      const title = node.getAttribute('title');
      if (title != null) {
        if (title) {
          node.dataset.tip = title;
          node.setAttribute('aria-description', title);
        } else delete node.dataset.tip;
        node.removeAttribute('title');
      }
      if (!node.dataset.tip) return;
      target = node;
      x = e.clientX;
      timer = setTimeout(show, DELAY);
    },
    true,
  );
  // A title changed while its box is up (Play becomes Pause): the new one.
  new MutationObserver((list) => {
    if (!target || !list.some((m) => m.target === target)) return;
    const title = target.getAttribute('title');
    if (title == null) return;
    target.dataset.tip = title;
    target.setAttribute('aria-description', title);
    target.removeAttribute('title');
    if (!tip.hidden) show();
  }).observe(document.body, { attributes: true, attributeFilter: ['title'], subtree: true });
  document.addEventListener('pointermove', (e) => target && tip.hidden && (x = e.clientX), { passive: true, capture: true });
  document.addEventListener('pointerout', (e) => target && !target.contains(e.relatedTarget) && hide(), true);
  for (const ev of ['pointerdown', 'wheel', 'keydown', 'contextmenu']) document.addEventListener(ev, hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
}
