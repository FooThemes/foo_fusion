// Picking a playlist's icon: a grid of the built-in ones. On its own as a
// dialog (right-click a playlist > Change icon…), or as a button beside the
// name in the New and Autoplaylist properties dialogs that drops the grid down.

import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { PLAYLIST_ICONS, pickedIcon, setPickedIcon, defaultIconName } from './plicon.js';
import { dialog } from './menus.js';

/** The grid. `fallback`: the icon "Default" stands for. */
export function iconGrid(current, onPick, fallback = 'playlist') {
  const grid = el('div.icon-grid', { role: 'radiogroup', 'aria-label': 'Icon' });
  for (const [name, label] of PLAYLIST_ICONS) {
    const on = name === current;
    grid.append(
      el(
        'button.icon-choice' + (on ? '.on' : '') + (name ? '' : '.default'),
        { type: 'button', role: 'radio', 'aria-checked': String(on), title: label, dataset: { icon: name }, onclick: () => onPick(name) },
        icon(name || fallback),
      ),
    );
  }
  grid.mark = (name) => {
    for (const b of grid.children) {
      const on = b.dataset.icon === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  grid.setFallback = (name) => grid.querySelector('.default .icon')?.replaceWith(icon(name));
  return grid;
}

/** Right-click > Change icon…: pick one for a playlist. */
export async function changeIconDialog(p) {
  let picked = pickedIcon(p.guid);
  let grid;
  const body = el('div.icon-dialog', null, (grid = iconGrid(picked, (n) => ((picked = n), grid.mark(n)), defaultIconName(p))));
  const ok = await dialog(`Icon for ${p.name}`, body, (close) => [el('button.btn-primary', { text: 'OK', onclick: () => close(true) }), el('button.btn-text', { text: 'Cancel', onclick: () => close(false) })]);
  if (ok) setPickedIcon(p.guid, picked);
}

/**
 * The button beside a name box: shows the icon picked, and drops the grid
 * down to pick another. `value()` / `setFallback(name)` for the dialog.
 */
export function iconField(current, fallback) {
  let value = current;
  let base = fallback;
  const face = el('span.icon-field-face', null, icon(value || base));
  const button = el('button.btn-outline.icon-field', { type: 'button', title: 'Icon', 'aria-haspopup': 'true' }, face);
  const grid = iconGrid(value, (n) => {
    value = n;
    grid.mark(n);
    face.replaceChildren(icon(value || base));
    close();
    button.focus();
  }, base);
  const pop = el('div.popup.icon-pop', { hidden: true }, grid);
  const box = el('span.icon-field-box', null, button, pop);
  const outside = (e) => !box.contains(e.target) && close();
  function close() {
    pop.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
  }
  button.addEventListener('click', (e) => {
    e.preventDefault();
    if (!pop.hidden) return close();
    pop.hidden = false;
    document.addEventListener('pointerdown', outside, true);
    (pop.querySelector('.on') || pop.querySelector('button'))?.focus();
  });
  // Escape closes the grid, not the dialog around it.
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
    button.focus();
  });
  box.value = () => value;
  box.setFallback = (name) => {
    base = name;
    grid.setFallback(name);
    if (!value) face.replaceChildren(icon(base));
  };
  return box;
}
