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
  artistsMulti: "$if2($meta_sep(artists,'|||'),$if2($meta_sep(artist,'|||'),'Unknown Artist'))",
  genresMulti: "$if2($meta_sep(genre,'|||'),'Unknown Genre')",

  // Text shown on tiles (read from the first row of each group).
  albumTitle: "$if(%album%,%album%,$if(%album artist%,'Single(s)','Unknown Album'))",
  albumDiscTitle: "$if(%album%,%album%$if($or($greater(%totaldiscs%,1),$greater(%discnumber%,1)),' (Disc '%discnumber%[': '%discsubtitle%]')',),$if(%album artist%,'Single(s)','Unknown Album'))",
  albumArtist: "$if2(%album artist%,'Unknown Artist')",
  year: '$year(%date%)',
  genre: "$if2(%genre%,'Unknown Genre')",

  // Track rows.
  trackNumber: "$if2(%tracknumber%,'')",
  trackArtist: '[%track artist%]',
  discSubtitle: '[%discsubtitle%]',
};

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
    .map((w) => `(%title% HAS "${w}" OR %artist% HAS "${w}" OR %album% HAS "${w}" OR %album artist% HAS "${w}" OR %genre% HAS "${w}")`)
    .join(' AND ');
}
