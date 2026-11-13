// Which playlist is playing, as the sidebar and playlist manager mark it.
// foobar2000 reports the playlist the song plays from; songs started from a
// sorted list play from Fusion's hidden playback playlist, which counts as
// the list they were started from. Read from the player's own position
// (kept current as songs start and playlists move), not from a playlist
// listing that can lag a moment behind.

import { player } from './player.js';
import { playlists } from './playlists.js';
import { view } from './view.js';

export function playingGuid() {
  if (!player.active || player.playingPlaylist < 0) return null;
  const p = playlists.list.find((x) => x.index === player.playingPlaylist);
  if (!p) return null;
  return playlists.isHidden(p) ? view.playbackSource : p.guid;
}
