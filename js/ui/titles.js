// Greys out edition tags at the end of titles: "white forces (single)",
// "Abbey Road (Remastered 2019)", "Song [Live]", "Song <Remix>", "Song ~Live~". Which tags count is a
// setting (Settings > Library); a bracketed tail is dimmed when it contains
// one of the listed words.

import * as store from '../core/store.js';
import { pickVersion } from '../data/versions.js';

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

// A bracketed ending: (…) […] <…> {…} ‹…› «…» （…） ［…］ 【…】 〈…〉 《…》
// ~…~ 〜…〜 ～…～ -…- (after a space), or " - …".
const TAIL = new RegExp(
  '\\s*(' +
    [
      '\\([^()]*\\)', '\\[[^[\\]]*\\]', '<[^<>]*>', '\\{[^{}]*\\}', '‹[^‹›]*›', '«[^«»]*»', '（[^（）]*）', '［[^［］]*］',
      '【[^【】]*】', '〈[^〈〉]*〉', '《[^《》]*》', '~[^~]+~', '〜[^〜]+〜', '～[^～]+～', '(?<=\\s)-[^-\\s][^-]*-', '\\s-\\s[^-()[\\]<>{}~‹«（［【〈《〜～]+',
    ].join('|') +
    ')\\s*$',
);
const OPEN = /^[([<{‹«（［【〈《~〜～-]/;
const CLOSE = /[)\]>}›»）］】〉》~〜～-]$/;

/** Split off a trailing "(…)"/"[…]" group (or " - Single") that should be dimmed. */
export function splitTitle(text) {
  const re = matcher();
  if (!re || !text) return [text || '', ''];
  // Walk back over trailing bracket groups: "Album (Deluxe) [Remastered]".
  let cut = text.length;
  let i = text.length;
  for (;;) {
    const tail = text.slice(0, i).match(TAIL);
    if (!tail) break;
    const inner = tail[1];
    if (!re.test(' ' + inner.replace(/^\s-\s/, '').replace(OPEN, ' ').replace(CLOSE, ' ') + ' ')) break;
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

/**
 * Set a title or name that may have versions (data/versions.js): the lead
 * version, then the other dimmed after it. Without versions, just `text`.
 * Returns the tooltip text listing the versions ('' when none).
 */
export function setVersioned(node, text, versions, kind) {
  const pick = pickVersion(versions, kind);
  // Names have no edition tags to dim.
  if (kind === 'artists') node.textContent = pick ? pick.base : text;
  else setTitle(node, pick ? pick.base : text);
  if (pick?.other) {
    const alt = document.createElement('span');
    alt.className = 'alt-version';
    alt.textContent = pick.other;
    node.append(' ', alt);
    // A shared ending ("(Album Mix)") after both, dimmed like any edition tag.
    if (pick.suffix) {
      const end = document.createElement('span');
      if (splitTitle('x ' + pick.suffix)[1]) end.className = 'dim-tag';
      end.textContent = pick.suffix;
      node.append(' ', end);
    }
  }
  return pick?.tip || '';
}

/** The lead version as plain text (for lines built from several parts). */
export function versionText(text, versions, kind) {
  return pickVersion(versions, kind)?.lead || text;
}
