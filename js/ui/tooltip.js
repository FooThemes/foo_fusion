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
    // A tile's card (the album's cover and details), else the text styled.
    const card = typeof target.tipCard === 'function' ? target.tipCard() : null;
    tip.classList.toggle('card', !!card);
    tip.replaceChildren(card || styled(text));
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

// "Playlist manager (Ctrl+M)", "Close (Esc)": the keys set apart; other
// endings in brackets ("(right-click for the menu)") dimmed as a note.
const KEYS = /^(?:(?:Ctrl|Alt|Shift|Win)\+)*(?:[A-Z0-9]|F\d{1,2}|Esc|Enter|Space|Tab|Del|Delete|Backspace|Home|End|Page ?Up|Page ?Down|Up|Down|Left|Right|[,.\/\-=+\[\]])(?:\s*(?:,|or|\/)\s*(?:(?:Ctrl|Alt|Shift)\+)*\S+)*$/;

/** The text: its first line as is, the lines after it quieter. */
function styled(text) {
  const box = document.createDocumentFragment();
  text.split('\n').forEach((line, i) => {
    const row = el(i ? 'div.tip-line' : 'div.tip-first');
    if (!line.trim()) row.classList.add('tip-gap');
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(line);
    if (m && m[1]) row.append(m[1], ' ', el(KEYS.test(m[2].trim()) ? 'span.tip-key' : 'span.tip-note', { text: m[2].trim() }));
    else row.textContent = line;
    box.append(row);
  });
  return box;
}
