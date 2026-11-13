// A name in running text that opens its page: an artist or genre (album
// panel, artist and genre headers, the info panel), or an album.

import { el } from '../core/util.js';
import { view } from '../data/view.js';

/**
 * An artist's or genre's page. `label`: the text shown, if not the name
 * itself; `go`: how to get there (default: within the list shown).
 */
export function valueLink(kind, value, { label = value, go = () => view.showValue(kind, value) } = {}) {
  return el('button.link', { text: label, title: kind === 'artists' ? `Show ${value}` : `Show ${value} albums`, onclick: go });
}

/** An album, in the Collection. */
export function albumLink(handle, text, album = text) {
  return el('button.link', { text, title: `Open ${album} in the Collection`, onclick: async () => view.goTo('albums', await view.albumKeyOf(handle)) });
}
