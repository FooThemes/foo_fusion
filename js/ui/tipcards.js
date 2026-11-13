// Richer hover boxes (tooltip.js) for albums: the cover beside the title,
// artist and what's known of it. Set as a tile's `tipCard`; its plain text
// stays in data-tip for screen readers.

import { el, plural } from '../core/util.js';
import { bindArt } from '../data/artwork.js';

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.alt]  other versions of the title (English, romanised)
 * @param {string} [o.artist]
 * @param {string} [o.handle]  for the cover
 * @param {string[]} [o.facts]  short facts on one line: year, genre, songs …
 * @param {string[]} [o.notes]  more lines under them (plays, last played …)
 */
export function albumCard({ title, alt, artist, handle, facts = [], notes = [] }) {
  const img = el('img', { alt: '', decoding: 'async' });
  if (handle) bindArt(img, handle, 72, ['front']);
  return el(
    'div.tip-album',
    null,
    el('div.art.ph-album.tip-cover', null, img),
    el(
      'div.tip-album-text',
      null,
      el('div.tip-head', { text: title }),
      alt ? el('div.tip-alt', { text: alt }) : null,
      artist ? el('div.tip-line', { text: artist }) : null,
      facts.filter(Boolean).length ? el('div.tip-meta', { text: facts.filter(Boolean).join(' · ') }) : null,
      ...notes.filter(Boolean).map((n) => el('div.tip-meta', { text: n })),
    ),
  );
}

/** An album tile in the Collection or a shelf, from its group. */
export function groupCard(g, { title, artist, alt } = {}) {
  const head = g.head || {};
  const genres = (head.genre || '').split(/\s*[;/,]\s*|\s*\|\|\|\s*/).filter(Boolean).slice(0, 3).join(', ');
  return albumCard({
    title: title || head.title || g.key.split('|')[1] || g.key,
    alt,
    artist: artist || head.artist,
    handle: head.handle,
    facts: [head.date ? String(head.date).slice(0, 4) : head.year, genres, g.count ? plural(g.count, 'song') : null],
  });
}
