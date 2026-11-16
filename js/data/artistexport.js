// Export the library's artists (the same names as Fusion's Artists tab, so
// featured artists are included) with their MusicBrainz IDs where the tags
// have them, for tools/fusion-artist-info.py to fetch artist information.
// Written to fusion-artists.json in the export folder (Settings), else beside
// the script, else in the foobar2000 profile folder.

import { tryCall } from '../core/bridge.js';
import { TF } from './patterns.js';
import { playlists, COLLECTION } from './playlists.js';
import { splitValues } from './view.js';
import * as store from '../core/store.js';
import { logAlways } from '../core/log.js';

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
  const path = await writeList('fusion-artists.json', { exported: new Date().toISOString(), artists: list });
  return { path, count: list.length, withId: list.filter((a) => a.mbid).length };
}

/**
 * The library's genres (as the Genres tab lists them, with song counts), for
 * tools/fusion-artist-info.py --genres. Written to fusion-genres.json beside
 * fusion-artists.json.
 */
export async function exportGenres() {
  const pl = playlists.byName(COLLECTION) || playlists.activePlaylist;
  if (!pl) throw new Error('No Collection playlist');
  const res = await tryCall('playlist.getGroupRuns', { playlist: pl.index, patterns: [TF.genresMulti] });
  if (!res) throw new Error("Couldn't read the library");
  const genres = new Map(); // lower case -> { name, songs }
  for (const run of res.runs || []) {
    {
      for (const name of splitValues(run.key, 'genres')) {
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
  const path = await writeList('fusion-genres.json', { exported: new Date().toISOString(), genres: list });
  return { path, count: list.length };
}

/**
 * Where the lists go: the export folder if one is set, else foobar2000's
 * profile. (They used to go beside the script by default, but
 * foo_ui_webview2 only lets a theme write on the system drive inside the
 * profile, so a script on C: couldn't get them. The script is told where
 * they are either way.)
 */
export async function exportDir() {
  const clean = (v) => String(v || '').trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  const chosen = clean(store.get('exportFolder'));
  if (chosen) return chosen;
  return profileDir();
}

async function profileDir() {
  const prof = await tryCall('misc.getProfilePath');
  return String(prof?.path || prof?.value || '').replace(/[\\/]+$/, '');
}

/**
 * Write a list where exportDir() says, or in the profile if that's refused
 * (an export folder on the system drive). Returns the path written.
 */
async function writeList(name, data) {
  const content = JSON.stringify(data, null, 1);
  const path = await exportPath(name);
  if (await tryCall('file.write', { path, content, atomic: true })) return path;
  const fallback = `${await profileDir()}\\${name}`;
  if (fallback !== path && (await tryCall('file.write', { path: fallback, content, atomic: true }))) {
    logAlways(`couldn't write ${path}; wrote ${fallback} instead`);
    lastWritten.set(name, fallback);
    return fallback;
  }
  throw new Error("Couldn't write " + path);
}

// Where each list actually went (writeList's fallback), for the script.
const lastWritten = new Map();

export async function exportPath(name) {
  return `${await exportDir()}\\${name}`;
}

/** Where a list was last written (for passing to the script). */
export async function writtenPath(name) {
  return lastWritten.get(name) || exportPath(name);
}
