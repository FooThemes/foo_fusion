// Richer hover boxes (tooltip.js) for albums: the title, artist and what's
// known of it, set out in lines (no cover: the tile already shows it). Set
// as a tile's `tipCard`; its plain text stays in data-tip for screen readers.

import { el, plural } from '../core/util.js';

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.alt]  other versions of the title (English, romanised)
 * @param {string} [o.artist]
 * @param {string[]} [o.facts]  short facts on one line: year, genre, songs …
 * @param {string[]} [o.notes]  more lines under them (plays, last played …)
 */
export function albumCard({ title, alt, artist, facts = [], notes = [] }) {
  return el(
    'div.tip-album',
    null,
    el(
      'div.tip-album-text',
      null,
      el('div.tip-head', { text: title }),
      alt ? el('div.tip-alt', { text: alt }) : null,
      artist ? el('div.tip-line', { text: artist }) : null,
      el(
        'div.tip-details',
        null,
        facts.filter(Boolean).length ? el('div.tip-meta', { text: facts.filter(Boolean).join(' · ') }) : null,
        ...notes.filter(Boolean).map((n) => el('div.tip-meta', { text: n })),
      ),
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
    facts: [head.date ? String(head.date).slice(0, 4) : head.year, genres, g.count ? plural(g.count, 'song') : null],
  });
}
