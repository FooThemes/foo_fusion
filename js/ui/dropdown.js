// Fusion's own drop-down menus (Sort by, playback order, Add to …), drawn in
// the page so they follow the theme, unlike foobar2000's native menus. Same
// items as showMenu(): { label, checked, enabled, submenu, run } and '-'.

import { el } from '../core/util.js';
import { icon } from '../core/icons.js';

let open = null; // { root, close }

/** Show items under (or above, near the bottom) the anchor element. */
export function dropdown(anchor, items, { align = 'left' } = {}) {
  if (open) {
    const same = open.anchor === anchor;
    open.close();
    if (same) return Promise.resolve(null); // a second click on the button closes it
  }
  return new Promise((resolve) => {
    const root = el('div.dd-layer');
    let done = false;
    const close = (v = null) => {
      if (done) return;
      done = true;
      root.remove();
      anchor.classList.remove('dd-open');
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      document.removeEventListener('keydown', onKey, true);
      if (open?.root === root) open = null;
      resolve(v);
    };
    const outside = (e) => {
      if (root.contains(e.target)) return;
      if (anchor.contains(e.target)) return; // the click toggles it closed
      close();
    };
    const onBlur = () => close();
    const menus = [];
    const build = (list, parentItem) => {
      const menu = el('div.dd-menu', { role: 'menu' });
      for (const it of list) {
        if (it === '-' || it?.type === 'separator') {
          menu.append(el('div.dd-sep'));
          continue;
        }
        if (!it) continue;
        const enabled = it.enabled !== false;
        const row = el(
          'button.dd-item' + (it.checked ? '.checked' : '') + (it.submenu ? '.has-sub' : ''),
          { role: 'menuitem', disabled: !enabled, tabindex: -1 },
          el('span.dd-check', null, it.checked ? icon('check') : null),
          el('span.dd-label', { text: it.label }),
          it.shortcut ? el('span.dd-key', { text: it.shortcut }) : null,
          it.submenu ? el('span.dd-arrow', null, icon('chevronRight')) : null,
        );
        if (it.submenu) {
          const openSub = () => {
            closeSubs(menu);
            const sub = build(it.submenu, it);
            sub.dataset.parent = menus.indexOf(menu);
            root.append(sub);
            place(sub, row.getBoundingClientRect(), true);
            row.classList.add('sub-open');
          };
          row.addEventListener('pointerenter', openSub);
          row.addEventListener('click', openSub);
        } else {
          row.addEventListener('pointerenter', () => closeSubs(menu));
          row.addEventListener('click', async () => {
            close(it.id || it.label);
            await it.run?.();
          });
        }
        menu.append(row);
      }
      menus.push(menu);
      void parentItem;
      return menu;
    };
    const closeSubs = (menu) => {
      const i = menus.indexOf(menu);
      for (const m of menus.slice(i + 1)) m.remove();
      menus.splice(i + 1);
      menu.querySelectorAll('.sub-open').forEach((r) => r.classList.remove('sub-open'));
    };
    const place = (menu, r, side = false) => {
      menu.style.visibility = 'hidden';
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x, y;
      if (side) {
        x = r.right + w + 4 > vw ? r.left - w : r.right;
        y = Math.min(r.top - 6, vh - h - 8);
      } else {
        x = align === 'right' ? r.right - w : r.left;
        y = r.bottom + 4;
        if (y + h > vh - 8) y = Math.max(8, r.top - h - 4); // no room below: above
      }
      menu.style.left = Math.max(8, Math.min(x, vw - w - 8)) + 'px';
      menu.style.top = Math.max(8, y) + 'px';
      menu.style.visibility = '';
    };
    const onKey = (e) => {
      const menu = menus[menus.length - 1];
      const rows = [...menu.querySelectorAll('.dd-item:not(:disabled)')];
      const at = rows.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (menus.length > 1) {
          const parent = menus[menus.length - 2];
          closeSubs(parent);
          parent.querySelector('.dd-item.has-sub')?.focus();
        } else close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
        next?.focus();
      } else if (e.key === 'ArrowRight' && document.activeElement?.classList.contains('has-sub')) {
        e.preventDefault();
        document.activeElement.click();
        menus[menus.length - 1].querySelector('.dd-item:not(:disabled)')?.focus();
      } else if (e.key === 'ArrowLeft' && menus.length > 1) {
        e.preventDefault();
        closeSubs(menus[menus.length - 2]);
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (at >= 0) {
          e.preventDefault();
          rows[at].click();
        }
      } else if (e.key === 'Tab') close();
    };
    const first = build(items);
    root.append(first);
    (document.getElementById('overlay-root') || document.body).append(root);
    place(first, anchor.getBoundingClientRect());
    anchor.classList.add('dd-open');
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    document.addEventListener('keydown', onKey, true);
    // Keyboard users land on the checked (or first) item.
    if (document.documentElement.dataset.keyboard != null) (first.querySelector('.dd-item.checked') || first.querySelector('.dd-item:not(:disabled)'))?.focus();
    open = { root, close, anchor };
  });
}
