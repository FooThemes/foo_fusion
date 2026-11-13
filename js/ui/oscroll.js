// Fusion's scrollbar, used by every long list and panel so they all look and
// behave the same: a slim bar drawn on top of the content (so nothing
// reflows when it appears), wider and brighter while the pointer is on it,
// draggable, and a click on its rail pages up or down.
//
// The browser's own scrollbar is hidden on these (class .oscrolled). Small
// popups (menus, completion lists) keep the browser's, styled to match in
// base.css.

import { el } from '../core/util.js';

const MIN_THUMB = 48;

/**
 * Give `scroller` Fusion's scrollbar. The bar sits beside it in its parent,
 * so it can be called before the scroller is in the page. `onUpdate` runs
 * after each reposition (for anything else that follows the scroller).
 */
export function overlayScroll(scroller, { onUpdate } = {}) {
  scroller.classList.add('oscrolled');
  const thumb = el('div.oscroll-thumb');
  const rail = el('div.oscroll', { hidden: true }, thumb);

  let frame = 0;
  const update = () => {
    frame = 0;
    const parent = scroller.parentElement;
    if (!parent) return;
    if (rail.parentElement !== parent) {
      parent.append(rail);
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      ro.observe(parent);
    }
    const view = scroller.clientHeight;
    const total = scroller.scrollHeight;
    const show = scroller.offsetWidth > 0 && total > view + 1;
    rail.hidden = !show;
    onUpdate?.();
    if (!show) return;
    // Measured against the parent's right edge, so a panel that slides by
    // its width carries the bar with it.
    rail.style.top = scroller.offsetTop + 'px';
    rail.style.height = view + 'px';
    rail.style.right = Math.max(0, parent.clientWidth - scroller.offsetLeft - scroller.offsetWidth) + 'px';
    const h = Math.max(MIN_THUMB, (view / total) * view);
    const y = (scroller.scrollTop / (total - view)) * (view - h);
    thumb.style.height = h + 'px';
    thumb.style.transform = `translateY(${y}px)`;
  };
  const schedule = () => frame || (frame = requestAnimationFrame(update));

  scroller.addEventListener('scroll', schedule, { passive: true });
  const ro = new ResizeObserver(schedule);
  ro.observe(scroller);
  // Content height changes (more rows, an album opened) aren't resizes of the
  // scroller itself; watch what's inside it too.
  new MutationObserver(() => {
    for (const c of scroller.children) ro.observe(c);
    schedule();
  }).observe(scroller, { childList: true });
  for (const c of scroller.children) ro.observe(c);

  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    thumb.setPointerCapture(e.pointerId);
    rail.classList.add('dragging');
    const startY = e.clientY;
    const startTop = scroller.scrollTop;
    const move = (ev) => {
      const view = scroller.clientHeight;
      const total = scroller.scrollHeight;
      scroller.scrollTop = startTop + ((ev.clientY - startY) / Math.max(1, view - thumb.offsetHeight)) * (total - view);
    };
    const up = () => {
      rail.classList.remove('dragging');
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', up);
      thumb.removeEventListener('pointercancel', up);
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);
  });
  // Click on the rail: a page up or down, like a normal scrollbar.
  rail.addEventListener('pointerdown', (e) => {
    if (e.target !== rail) return;
    e.preventDefault();
    const r = thumb.getBoundingClientRect();
    scroller.scrollBy({ top: (e.clientY < r.top ? -1 : 1) * scroller.clientHeight * 0.9, behavior: 'smooth' });
  });
  schedule();
  return { update: schedule };
}
