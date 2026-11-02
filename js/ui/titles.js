// Greys out edition tags at the end of titles: "white forces (single)",
// "Abbey Road (Remastered 2019)", "Song [Live]", "Song <Remix>", "Song ~Live~". Which tags count is a
// setting (Settings > Library); a bracketed tail is dimmed when it contains
// one of the listed words.

import * as store from '../core/store.js';

let cache = { src: null, re: null };

function matcher() {
  const words = store.get('dimWords');
  const on = store.get('dimEditionTags');
  const src = on ? words : '';
  if (cache.src === src) return cache.re;
  const list = String(src || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  cache = {
    src,
    re: list.length ? new RegExp(`(?:^|[\\s(\\[])(?:${list.join('|')})(?=$|[\\s)\\].,:;-])`, 'i') : null,
  };
  return cache.re;
}

/** Split off a trailing "(…)"/"[…]" group (or " - Single") that should be dimmed. */
export function splitTitle(text) {
  const re = matcher();
  if (!re || !text) return [text || '', ''];
  // Walk back over trailing bracket groups: "Album (Deluxe) [Remastered]".
  let cut = text.length;
  let i = text.length;
  for (;;) {
    const tail = text.slice(0, i).match(/\s*(\([^()]*\)|\[[^[\]]*\]|<[^<>]*>|\{[^{}]*\}|~[^~]+~|\s-\s[^-()[\]<>{}~]+)\s*$/);
    if (!tail) break;
    const inner = tail[1];
    if (!re.test(' ' + inner.replace(/^\s-\s/, '').replace(/^[([<{~]|[)\]>}~]$/g, ' ') + ' ')) break;
    i -= tail[0].length;
    cut = i;
  }
  if (cut <= 0 || cut >= text.length) return [text, ''];
  return [text.slice(0, cut), text.slice(cut)];
}

/** Set an element's text, with the edition tag in a dimmed span. */
export function setTitle(node, text) {
  const [main, dim] = splitTitle(text || '');
  if (!dim) {
    node.textContent = main;
    return;
  }
  const span = document.createElement('span');
  span.className = 'dim-tag';
  span.textContent = dim;
  node.replaceChildren(main, span);
}
