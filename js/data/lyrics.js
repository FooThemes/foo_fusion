// Lyrics for a song: timed (LRC) or plain, from files or tags.
//
// Looked for in this order: timed lyrics beat plain ones wherever they are,
// and for each, a file beats a tag:
//   1. .lrc files: beside the song (same name), then where foo_openlyrics
//      saves them (Settings > Lyrics lists both patterns)
//   2. tags holding timed text (foo_openlyrics saves to UNSYNCED LYRICS)
//   3. .txt files, the same places
//   4. tags holding plain text
// foobar2000 can't read ID3 SYLT frames, so timed lyrics in tags are LRC
// text in a normal tag (USLT is foobar2000's "UNSYNCED LYRICS").

import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';

export const LYRIC_TAGS = ['UNSYNCED LYRICS', 'SYNCEDLYRICS', 'LYRICS', 'UNSYNCEDLYRICS', 'SYNCED LYRICS'];

const cache = new Map(); // handle -> Promise<lyrics | null>

export function forgetLyrics(handle) {
  if (handle) cache.delete(handle);
  else cache.clear();
}

/** { synced, lines: [{ time, text }], text, source } or null. */
export function lyricsFor(track) {
  if (!track?.handle) return Promise.resolve(null);
  if (!cache.has(track.handle)) {
    cache.set(track.handle, find(track).catch(() => null));
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return cache.get(track.handle);
}

let profile = null;
function profilePath() {
  profile ||= tryCall('misc.getProfilePath').then((r) => (r?.path || r?.value || '').replace(/[\\/]$/, ''));
  return profile;
}

/** The lyric file names (without extension) for a song, from the patterns in Settings. */
async function fileBases(track) {
  const patterns = String(store.get('lyricsFiles') || '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!patterns.length) return [];
  const prof = await profilePath();
  const fields = Object.fromEntries(patterns.map((p, i) => [`p${i}`, p.replace(/%profile%/gi, prof.replace(/[%$[\]']/g, (c) => `'${c}'`))]));
  const res = await tryCall('titleformat.evalFields', { path: track.handle, fields });
  if (!res) return [];
  // foo_openlyrics trims trailing dots and spaces from file names.
  return patterns.map((_, i) => String(res[`p${i}`] || '').replace(/[. ]+$/, '')).filter((p) => /^[a-z]:\\|^\\\\/i.test(p));
}

async function readFile(path) {
  const res = await tryCall('file.read', { path });
  const text = res?.content;
  return typeof text === 'string' && text.trim() ? { text: text.replace(/^﻿/, ''), source: path } : null;
}

async function readTags(track) {
  const res = await tryCall('metadata.readByPath', { path: track.handle });
  const src = res?.metadata || res?.meta || res?.tags || res?.info?.meta || res || {};
  const byName = new Map(Object.entries(src).map(([k, v]) => [k.toUpperCase(), v]));
  const out = [];
  for (const name of LYRIC_TAGS) {
    let v = byName.get(name);
    if (Array.isArray(v)) v = v.join('\n');
    if (typeof v === 'string' && v.trim()) out.push({ text: v, source: `${name} tag` });
  }
  return out;
}

async function find(track) {
  const bases = await fileBases(track);
  const exists = async (path) => (await tryCall('file.exists', { path }))?.exists;
  // Timed: .lrc files, then timed text in tags.
  for (const base of bases) {
    if (!(await exists(`${base}.lrc`))) continue;
    const f = await readFile(`${base}.lrc`);
    const parsed = f && parseLyrics(f.text);
    if (parsed) return { ...parsed, source: f.source };
  }
  const tags = await readTags(track);
  const parsedTags = tags.map((t) => ({ ...parseLyrics(t.text), source: t.source }));
  const timedTag = parsedTags.find((p) => p.synced);
  if (timedTag) return timedTag;
  // Plain: .txt files (and untimed .lrc), then tags.
  for (const base of bases) {
    for (const ext of ['.txt', '.lrc']) {
      if (!(await exists(base + ext))) continue;
      const f = await readFile(base + ext);
      const parsed = f && parseLyrics(f.text);
      if (parsed?.text.trim()) return { ...parsed, source: f.source };
    }
  }
  return parsedTags.find((p) => p.text?.trim()) || null;
}

/**
 * LRC text: "[mm:ss.xx]line" (several stamps a line, [offset:±ms], and
 * word timings <mm:ss.xx> are understood). Anything without stamps is plain.
 */
export function parseLyrics(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  let offset = 0;
  const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/im.exec(text);
  if (off) offset = Number(off[1]) / 1000;
  const lines = [];
  for (const line of text.split('\n')) {
    const times = [];
    let m;
    stamp.lastIndex = 0;
    let rest = line;
    // Leading stamps only ("[00:12.00][01:30.00]words").
    while ((m = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue;
    const words = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const t of times) lines.push({ time: Math.max(0, t - offset), text: words });
  }
  if (lines.length >= 2) {
    lines.sort((a, b) => a.time - b.time);
    return { synced: true, lines, text: lines.map((l) => l.text).join('\n') };
  }
  // Plain: without any [ar:…]-style header lines.
  const plain = text
    .split('\n')
    .filter((l) => !/^\s*\[[a-z]+:[^\]]*\]\s*$/i.test(l))
    .join('\n')
    .trim();
  return { synced: false, lines: [], text: plain };
}

/** Index of the line being sung at this time (-1 before the first). */
export function lineAt(lines, time) {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time + 0.05) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
