// Every song's listening statistics, shared by Listening stats and the home
// shelves: play count, first/last played, added, and (with Enhanced Playback
// Statistics) the time of every play.
//
// Reading all that for a big library is slow (the play times especially:
// close to a minute for 17,000 songs), and foobar2000 answers nothing else
// meanwhile. So it is read once, in small pieces with pauses between them
// (anything you do gets its turn in between), and kept on disk beside the
// art cache. After that a start only lists the Collection's songs (quick),
// reads the ones it hasn't seen, and songs that are played or retagged are
// read again on their own as foobar2000 reports them.

import { tryCall, on } from '../core/bridge.js';
import { TF } from './patterns.js';
import { cacheFolder } from './artcache.js';
import { Emitter } from '../core/emitter.js';

const TIMES = '[%played_times_js%]';
const LASTFM_TIMES = '[%lastfm_played_times_js%]';
const FORMATS = {
  ar: TF.artistsMulti,
  aa: TF.albumArtist,
  al: TF.albumTitle,
  k: TF.albumKey,
  kd: TF.albumDiscKey,
  n: TF.trackNumber,
  gn: TF.genre,
  c: TF.playCountAny,
  l: TF.lastPlayedAny,
  a: TF.addedAny,
  pt: TIMES,
  lt: LASTFM_TIMES,
};
const FIELDS = ['handle', 'title', 'duration'];
const PIECE = 150; // songs per call: small, so other calls never wait long
const PAUSE = 60; // ms between pieces
const FILE = 'listening.json';
const VERSION = 1;

export const listening = new Emitter(); // 'change' when songs were read again

let state = null; // { guid, byHandle: Map<handle, track>, complete }
let syncing = null;
let watching = false;
const dirty = new Set();

/** A play time from Enhanced Playback Statistics: ms, seconds or a date. */
function toMs(v) {
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}

function parseTimes(text) {
  if (!text || text[0] !== '[') return [];
  try {
    return JSON.parse(text).map(toMs).filter(Boolean);
  } catch {
    return [];
  }
}

function toTrack(t) {
  const f = t.formats || {};
  // Its own plays and Last.fm's, once each (the same play in both counts once).
  const own = parseTimes(f.pt);
  const lfm = parseTimes(f.lt).filter((x) => !own.some((o) => Math.abs(o - x) < 120000));
  const times = own.concat(lfm).sort((a, b) => a - b);
  const last = times.length ? new Date(times[times.length - 1]) : null;
  const p = (n) => String(n).padStart(2, '0');
  const lastText = last ? `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())} ${p(last.getHours())}:${p(last.getMinutes())}:${p(last.getSeconds())}` : '';
  return {
    row: t.index,
    handle: t.handle,
    title: t.title || '',
    duration: t.duration || 0,
    artists: (f.ar || '').split('|||').filter(Boolean),
    albumArtist: f.aa || '',
    album: f.al || '',
    albumKey: f.k || '',
    discKey: f.kd || '',
    number: f.n || '',
    genres: (f.gn || '').split('|||').filter(Boolean),
    // The play counter, or every play known (with Last.fm's history the
    // times can go back further than the counter does).
    plays: Math.max(parseInt(f.c, 10) || 0, times.length),
    last: (f.l || '') > lastText ? f.l : lastText,
    added: f.a || '',
    times,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function readRows(pl, rows, onProgress) {
  const out = [];
  for (let i = 0; i < rows.length; i += PIECE) {
    const res = await tryCall('playlist.getTracksAt', { playlist: pl.index, rows: rows.slice(i, i + PIECE), fields: FIELDS, formats: FORMATS });
    if (!res) return null;
    out.push(...res.tracks.map(toTrack));
    onProgress?.(Math.min(1, (i + PIECE) / rows.length));
    if (i + PIECE < rows.length) await wait(PAUSE);
  }
  return out;
}

async function loadDisk(guid) {
  const dir = cacheFolder();
  if (!dir) return null;
  try {
    const res = await fetch(`${dir.url}/${FILE}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.v !== VERSION || data.guid !== guid) return null;
    return new Map(data.tracks.map((t) => [t.handle, t]));
  } catch {
    return null;
  }
}

let saveTimer = 0;
function saveSoon(ms = 5000) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const dir = cacheFolder();
    if (!dir || !state) return;
    const content = JSON.stringify({ v: VERSION, guid: state.guid, tracks: [...state.byHandle.values()] });
    await tryCall('file.write', { path: `${dir.path}\\${FILE}`, content, atomic: true });
  }, ms);
}

function watch() {
  if (watching) return;
  watching = true;
  on('metadb:changed', (d) => {
    for (const h of d.handles || []) dirty.add(h);
    refreshDirty();
  });
}

let dirtyTimer = 0;
function refreshDirty() {
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(async () => {
    if (!state?.pl || !dirty.size) return;
    const known = [...dirty].map((h) => state.byHandle.get(h)).filter(Boolean);
    dirty.clear();
    if (!known.length) return;
    const fresh = await readRows(state.pl, known.map((t) => t.row));
    if (!fresh) return;
    let changed = false;
    for (const t of fresh) {
      // The row may have moved (a re-sort): only take it if it's the same song.
      if (!state.byHandle.has(t.handle)) continue;
      state.byHandle.set(t.handle, t);
      changed = true;
    }
    if (changed) {
      listening.emit('change');
      saveSoon(30000);
    }
  }, 1500);
}

/**
 * The Collection's songs with their statistics, in playlist order. Resolves
 * at once when they're known; otherwise reads them (onProgress: 0..1).
 */
export function listeningData(pl, onProgress) {
  watch();
  if (state?.guid === pl.guid && state.complete && state.count === pl.trackCount) return Promise.resolve(tracksOf());
  if (syncing?.guid === pl.guid) {
    if (onProgress) syncing.progress.add(onProgress);
    return syncing.promise;
  }
  const progress = new Set(onProgress ? [onProgress] : []);
  const promise = sync(pl, (f) => progress.forEach((fn) => fn(f))).finally(() => (syncing = null));
  syncing = { guid: pl.guid, promise, progress };
  return promise;
}

/** Already read for this playlist (no waiting), or null. */
export function knownData(pl) {
  return state?.guid === pl.guid && state.complete ? tracksOf() : null;
}

function tracksOf() {
  return [...state.byHandle.values()].sort((a, b) => a.row - b.row);
}

async function sync(pl, onProgress) {
  let byHandle = state?.guid === pl.guid ? state.byHandle : await loadDisk(pl.guid);
  // Which songs the Collection has now, and where (just the handles: quick).
  const handles = [];
  for (let i = 0; i < pl.trackCount; i += 4000) {
    const res = await tryCall('playlist.getTracks', { playlist: pl.index, start: i, count: Math.min(4000, pl.trackCount - i), fields: ['handle'] });
    if (!res) return null;
    for (const t of res.tracks) handles.push(t.handle);
  }
  byHandle ||= new Map();
  const next = new Map();
  const missing = [];
  handles.forEach((h, row) => {
    const t = byHandle.get(h);
    if (t) next.set(h, { ...t, row });
    else missing.push(row);
  });
  state = { guid: pl.guid, pl, byHandle: next, complete: false, count: pl.trackCount };
  if (missing.length) {
    const read = await readRows(pl, missing, onProgress);
    if (!read) return null;
    for (const t of read) next.set(t.handle, t);
    saveSoon();
  } else if (next.size !== byHandle.size) saveSoon();
  state.complete = true;
  return tracksOf();
}

/**
 * Where these songs are in the Collection now. Usually where they were read;
 * after a re-sort they've moved, and the Collection is listed again (just the
 * handles: quick) to find them.
 */
export async function currentRows(pl, list) {
  if (!list.length) return [];
  const res = await tryCall('playlist.getTracksAt', { playlist: pl.index, rows: list.map((t) => t.row), fields: ['handle'] });
  const got = new Map((res?.tracks || []).map((x) => [x.index, x.handle]));
  if (list.every((t) => got.get(t.row) === t.handle)) return list.map((t) => t.row);
  if (state?.guid === pl.guid) state.complete = false;
  await listeningData(pl);
  return list.map((t) => state?.byHandle.get(t.handle)?.row).filter((r) => r != null);
}

/** Play a song of the Collection. */
export async function playSong(pl, t) {
  const [row] = await currentRows(pl, [t]);
  if (row != null) return tryCall('playlist.playTrack', { playlist: pl.index, index: row });
}
