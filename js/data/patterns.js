// Every title formatting pattern Fusion sends to foobar2000 lives here, so they
// are easy to find and adjust (and so the dev mock can emulate them).

export const TF = {
  // Group keys. The playlist is shown in its own order; adjacent rows with the
  // same key form one tile.
  albumKey: "$if2(%album artist%,'Unknown Artist')|$if2(%album%,'Single(s)')",
  // Not every rip has TOTALDISCS, so split on DISCNUMBER alone.
  albumDiscKey: "$if2(%album artist%,'Unknown Artist')|$if2(%album%,'Single(s)')[|%discnumber%]",
  artistKey: "$if2(%album artist%,'Unknown Artist')",
  genreKey: "$if2(%genre%,'Unknown Genre')",
  // Multi-value keys for the Artists and Genres views (values joined by |||,
  // and also split on ';' by Fusion). ARTISTS lists every performer, so
  // featured artists get their own tile; it falls back to ARTIST.
  // ARTISTS (featured artists included), else ALBUM ARTIST, else ARTIST.
  // Language-tagged files (TITLE_ORIG etc.) have "宇多田ヒカル (Hikaru Utada)"
  // in ALBUM ARTIST / ARTIST; their _ORIG tags hold the plain name.
  artistsMulti:
    "$if2($meta_sep(artists,'|||'),$if2($meta_sep(albumartist_orig,'|||'),$if2($meta_sep(album artist,'|||'),$if2($meta_sep(artist_orig,'|||'),$if2($meta_sep(artist,'|||'),'Unknown Artist')))))",
  genresMulti: "$if2($meta_sep(genre,'|||'),'Unknown Genre')",
  // The folder a song is in (Folders view).
  dirKey: '$directory_path(%path%)',

  // Text shown on tiles (read from the first row of each group).
  albumTitle: "$if(%album%,%album%,$if(%album artist%,'Single(s)','Unknown Album'))",
  albumDiscTitle: "$if(%album%,%album%$if($or($greater(%totaldiscs%,1),$greater(%discnumber%,1)),' (Disc '%discnumber%[': '%discsubtitle%]')',),$if(%album artist%,'Single(s)','Unknown Album'))",
  albumArtist: "$if2(%album artist%,'Unknown Artist')",
  albumRaw: '[%album%]',
  year: '$year(%date%)',
  // Raw values for the expanded album's line: every genre (blank if none) and the full date.
  genre: "[$meta_sep(genre,'|||')]",
  date: '[%date%]',

  // Track rows.
  trackNumber: "$if2(%tracknumber%,'')",
  trackArtist: '[%track artist%]',
  // Songs view columns.
  codec: '[%codec%]',
  bitrate: '[%bitrate%]',
  playCount: '[%play_count%]',
  added: '[%added%]',
  // Play statistics from foo_playcount, else Playcount 2003.
  addedAny: '$if2([%added%],[%2003_added%])',
  lastPlayedAny: '$if2([%last_played%],[%2003_last_played%])',
  playCountAny: '$if2([%play_count%],[%2003_playcount%])',
  discSubtitle: '[%discsubtitle%]',
};

// Searched fields: the usual ones plus the English and romanised versions
// (so "fireworks", "hanabi" and "花火" all find 花火).
const SEARCH_FIELDS = ['%title%', '%artist%', '%album%', '%album artist%', '%genre%'].concat(
  ['title', 'artist', 'album', 'albumartist'].flatMap((f) => [`%${f}_en%`, `%${f}_rom%`]),
);

/** Build a foobar2000 query that matches every word in `text` somewhere. */
export function searchQuery(text) {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/["()]/g, ''))
    .filter(Boolean);
  if (!words.length) return '';
  return words
    .map((w) => `(${SEARCH_FIELDS.map((f) => `${f} HAS "${w}"`).join(' OR ')})`)
    .join(' AND ');
}
