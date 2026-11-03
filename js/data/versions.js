// Original, English and romanised versions of titles and names, from the
// TITLE_ORIG / TITLE_EN / TITLE_ROM tags (and the same for ARTIST, ALBUM,
// ALBUMARTIST, DISCSUBTITLE) that tools/picard/language_variants.py writes.
// The combined tag ("花火 (Fireworks)") stays for other players; Fusion builds
// its own display from the parts, so which version leads is a setting here
// rather than something baked into the files.

import * as store from '../core/store.js';
import { tryCall } from '../core/bridge.js';

export const KINDS = ['orig', 'en', 'rom'];
/** Settings that change how versions show (redraw when they change). */
export const VERSION_KEYS = ['leadAlbums', 'leadTracks', 'otherVersion'];
const LABEL = { orig: 'Original', en: 'English', rom: 'Romanised' };
const SEP = '|||';

/** Title formatting for one field's versions, as "orig|||en|||rom". */
export const versionsTF = (field) => `[%${field}_orig%]${SEP}[%${field}_en%]${SEP}[%${field}_rom%]`;

/** Versions from a versionsTF result, or null when the field has none. */
export function parseVersions(text) {
  if (!text) return null;
  const [orig = '', en = '', rom = ''] = text.split(SEP);
  if (!orig || (!en && !rom)) return null;
  return { orig, en, rom };
}

const CHAIN = { orig: ['orig'], en: ['en', 'rom', 'orig'], rom: ['rom', 'en', 'orig'] };
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What to show for these versions: { lead, other, tip }. `kind` is 'albums'
 * (album titles, disc subtitles) or 'tracks' (song titles, artist names),
 * each with its own "Show titles in" setting. `other` is '' when the other
 * version is set to show only in the tooltip, or is hidden.
 */
export function pickVersion(v, kind) {
  if (!v) return null;
  const want = store.get(kind === 'albums' ? 'leadAlbums' : 'leadTracks') || 'orig';
  const leadKind = (CHAIN[want] || CHAIN.orig).find((k) => v[k]) || 'orig';
  const lead = v[leadKind];
  const otherKind = leadKind === 'orig' ? ['en', 'rom'].find((k) => v[k] && !same(v[k], lead)) : !same(v.orig, lead) ? 'orig' : null;
  const mode = store.get('otherVersion');
  return {
    lead,
    other: otherKind && mode === 'beside' ? stripShared(v[otherKind], lead) : '',
    tip: mode === 'hidden' ? '' : versionsTip(v),
  };
}

/**
 * Drop trailing bracketed parts of `other` that `lead` already shows:
 * "気分じゃないの (Not in the Mood)" + "Kibun Janai no (Not In The Mood)"
 * shows the second as just "Kibun Janai no".
 */
function stripShared(other, lead) {
  const folded = lead.toLowerCase();
  for (;;) {
    const m = other.match(/\s*[(\[{（［【〈《「『<~]([^()[\]{}]*?)[)\]}）］】〉》」』>~]\s*$/);
    if (!m || m.index === 0 || !folded.includes(m[1].trim().toLowerCase())) return other;
    other = other.slice(0, m.index).trimEnd();
  }
}

/** "Original: 花火\nEnglish: Fireworks\nRomanised: Hanabi" */
export function versionsTip(v) {
  if (!v) return '';
  const seen = [];
  return KINDS.filter((k) => v[k] && !seen.some((s) => same(s, v[k])) && seen.push(v[k]))
    .map((k) => `${LABEL[k]}: ${v[k]}`)
    .join('\n');
}

let last = { track: null, promise: null };

/**
 * Versions of the playing song's title, artist and album. Keyed by the
 * track object, which the player replaces when tags are edited.
 */
export function trackVersions(track) {
  if (!track?.handle) return Promise.resolve(null);
  if (last.track !== track) {
    last = {
      track,
      promise: tryCall('titleformat.evalFields', {
        path: track.handle,
        fields: { t: versionsTF('title'), a: versionsTF('artist'), l: versionsTF('album') },
      }).then((r) => (r ? { title: parseVersions(r.t), artist: parseVersions(r.a), album: parseVersions(r.l) } : null)),
    };
  }
  return last.promise;
}
