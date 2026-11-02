// Click / Ctrl+click / Shift+click selection for any list of playlist rows.
// The selection lives in view.selection and is mirrored to foobar2000, so the
// native context menu, "Delete" and other commands act on what you see.

import { view } from '../data/view.js';

export class RowSelector {
  /** @param {HTMLElement} root  @param {() => number[]} getRows  ordered rows shown in the list */
  constructor(root, getRows, rowFromEvent = defaultRowFromEvent) {
    this.anchor = null;
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      const r = rowFromEvent(e);
      if (r == null) return;
      if (e.button === 2) {
        if (!view.selection.has(r)) view.select([r], { focus: r });
        return;
      }
      if (e.shiftKey && this.anchor != null) {
        const rows = getRows();
        const a = rows.indexOf(this.anchor);
        const b = rows.indexOf(r);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          view.select(rows.slice(lo, hi + 1), { add: e.ctrlKey, focus: r });
          return;
        }
      }
      this.anchor = r;
      if (e.ctrlKey) view.toggle(r);
      else view.select([r], { focus: r });
    });
  }
}

function defaultRowFromEvent(e) {
  const node = e.target.closest('[data-row]');
  return node ? Number(node.dataset.row) : null;
}
