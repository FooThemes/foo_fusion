// The icon for a playlist or folder, the same wherever playlists are listed
// (the left panel, the playlist manager).

import { icon } from '../core/icons.js';
import { COLLECTION, FAVORITES } from '../data/playlists.js';

export function playlistIcon(p) {
  if (p.name === COLLECTION) return icon('collection');
  if (p.name === FAVORITES) return icon('heart');
  return icon(p.isAutoplaylist ? 'autoplaylist' : 'playlist');
}

/** A closed or an open folder. */
export function folderIcon(f) {
  return icon(f.collapsed ? 'folder' : 'folderOpen');
}
