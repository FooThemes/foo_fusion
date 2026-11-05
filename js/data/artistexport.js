// Export the library's artists (the same names as Fusion's Artists tab, so
// featured artists are included) with their MusicBrainz IDs where the tags
// have them, for tools/fusion-artist-info.py to fetch artist information.
// Written to fusion-artists.json in the foobar2000 profile folder (themes may
// only write inside the profile).

import { tryCall } from '../core/bridge.js';
import { TF } from './patterns.js';
import { playlists, COLLECTION } from './playlists.js';

const SEP = '|||';
// MBIDs from the tag that matches where the names came from (ARTISTS, else
// ALBUM ARTIST, else ARTIST), so they line up with the names.
const IDS =
  "$if($meta(artists),$meta_sep(musicbrainz_artistid,'|||'),$if($meta(album artist),$meta_sep(musicbrainz_albumartistid,'|||'),$meta_sep(musicbrainz_artistid,'|||')))";

export async function exportArtists() {
  const pl = playlists.byName(COLLECTION) || playlists.activePlaylist;
  if (!pl) throw new Error('No Collection playlist');
  const res = await tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns: [`${TF.artistsMulti}##${IDS}`] });
  if (!res) throw new Error("Couldn't read the library");
  const artists = new Map(); // lower-case name -> { name, songs, ids: Map(id -> votes) }
  for (const run of res.runs || []) {
    const [namePart, idPart = ''] = run.key.split('##');
    const names = [];
    for (const n of namePart.split(SEP)) for (const v of n.split(';')) if (v.trim()) names.push(v.trim());
    const ids = idPart.split(SEP).map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    names.forEach((name, i) => {
      const k = name.toLowerCase();
      if (k === 'unknown artist') return;
      const a = artists.get(k) || { name, songs: 0, ids: new Map() };
      a.songs += run.count;
      // IDs pair up with names by position when the counts agree; a single
      // ID with several names belongs to the first (Picard's order).
      const id = ids.length === names.length ? ids[i] : i === 0 ? ids[0] : null;
      if (id) a.ids.set(id, (a.ids.get(id) || 0) + run.count);
      artists.set(k, a);
    });
  }
  const list = [...artists.values()]
    .map((a) => ({ name: a.name, songs: a.songs, mbid: [...a.ids].sort((x, y) => y[1] - x[1])[0]?.[0] || null }))
    .sort((x, y) => x.name.localeCompare(y.name));
  const prof = await tryCall('misc.getProfilePath');
  const dir = (prof?.path || prof?.value || '').replace(/[\\/]$/, '');
  const path = `${dir}\\fusion-artists.json`;
  const ok = await tryCall('file.write', { path, content: JSON.stringify({ exported: new Date().toISOString(), artists: list }, null, 1), atomic: true });
  if (!ok) throw new Error("Couldn't write " + path);
  return { path, count: list.length, withId: list.filter((a) => a.mbid).length };
}

/**
 * The library's genres (as the Genres tab lists them, with song counts), for
 * tools/fusion-artist-info.py --genres. Written to fusion-genres.json beside
 * fusion-artists.json in the profile folder.
 */
export async function exportGenres() {
  const pl = playlists.byName(COLLECTION) || playlists.activePlaylist;
  if (!pl) throw new Error('No Collection playlist');
  const res = await tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns: [TF.genresMulti] });
  if (!res) throw new Error("Couldn't read the library");
  const genres = new Map(); // lower case -> { name, songs }
  for (const run of res.runs || []) {
    for (const part of run.key.split(SEP)) {
      for (const v of part.split(';')) {
        const name = v.trim();
        if (!name || name.toLowerCase() === 'unknown genre') continue;
        const g = genres.get(name.toLowerCase()) || { name, songs: 0 };
        // The capitalised spelling wins ("J-Pop" over "j-pop"), as on the Genres tab.
        if (g.name === g.name.toLowerCase() && name !== name.toLowerCase()) g.name = name;
        g.songs += run.count;
        genres.set(name.toLowerCase(), g);
      }
    }
  }
  const list = [...genres.values()].sort((a, b) => a.name.localeCompare(b.name));
  const prof = await tryCall('misc.getProfilePath');
  const dir = (prof?.path || prof?.value || '').replace(/[\\/]$/, '');
  const path = `${dir}\\fusion-genres.json`;
  const ok = await tryCall('file.write', { path, content: JSON.stringify({ exported: new Date().toISOString(), genres: list }, null, 1), atomic: true });
  if (!ok) throw new Error("Couldn't write " + path);
  return { path, count: list.length };
}
