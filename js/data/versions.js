// Original, English and romanised versions of titles and names, from the
// TITLE_ORIG / TITLE_EN / TITLE_ROM tags (and the same for ARTIST, ALBUM,
// ALBUMARTIST, DISCSUBTITLE) that tools/picard/language_variants.py writes.
// The combined tag ("花火 (Fireworks)") stays for other players; Fusion builds
// its own display from the parts, so which version leads is a setting here
// rather than something baked into the files.

import * as store from '../core/store.js';
import { tryCall } from '../core/bridge.js';

export const KINDS = ['orig', 'en', 'rom'];
/** Kinds of text, each with its own "show" and "then" settings. */
export const TEXT_KINDS = { albums: 'Albums', discs: 'Discs', titles: 'Titles', artists: 'Artists' };
/** Settings that change how versions show (redraw when they change). */
export const VERSION_KEYS = ['versionTooltips', ...Object.values(TEXT_KINDS).flatMap((k) => [`lead${k}`, `then${k}`])];
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
const norm = (a) => a.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const same = (a, b) => norm(a) === norm(b);
const BRACKET = /\s*([(\[{（［【〈《「『<~‹«])([^()[\]{}]*?)([)\]}）］】〉》」』>~›»])\s*$/;

/**
 * What to show for these versions. `kind` is 'albums', 'discs', 'titles' or
 * 'artists' (see TEXT_KINDS), each with a lead setting ("show") and what
 * follows it dimmed ("then"). Returns
 *   lead    the lead version, whole ("スターマーカー (Album Mix)")
 *   base    the lead without an ending it shares with `other` ("スターマーカー")
 *   suffix  that shared ending ("(Album Mix)"), to go after `other`
 *   other   the version(s) shown dimmed ("Starmarker"), '' for none
 *   tip     every version, for tooltips ('' when that's off)
 */
export function pickVersion(v, kind) {
  if (!v) return null;
  const k = TEXT_KINDS[kind] || 'Titles';
  const want = store.get(`lead${k}`) || 'orig';
  const leadKind = (CHAIN[want] || CHAIN.orig).find((x) => v[x]) || 'orig';
  const lead = v[leadKind];
  const then = store.get(`then${k}`) || 'auto';
  const pick = (x) => (v[x] && !same(v[x], lead) ? v[x] : '');
  let others;
  if (then === 'none') others = [];
  else if (then === 'all') others = KINDS.filter((x) => x !== leadKind).map(pick);
  else if (then === 'auto') others = [leadKind === 'orig' ? pick('en') || pick('rom') : pick('orig')];
  else others = [pick(then)];
  others = others.filter((o, i, a) => o && a.findIndex((x) => same(x, o)) === i);
  // A shared ending goes once, after the other version.
  let base = lead;
  let suffix = '';
  for (;;) {
    const m = base.match(BRACKET);
    if (!m || m.index === 0 || !others.length || !others.every((o) => (o.match(BRACKET) || [])[2] !== undefined && same(o.match(BRACKET)[2], m[2]))) break;
    suffix = (m[0].trim() + ' ' + suffix).trim();
    base = base.slice(0, m.index).trimEnd();
    others = others.map((o) => o.slice(0, o.match(BRACKET).index).trimEnd());
  }
  others = others.map((o) => stripShared(o, base)).filter(Boolean);
  return {
    lead,
    base: others.length ? base : lead,
    suffix: others.length ? suffix : '',
    other: others.join(' · '),
    tip: store.get('versionTooltips') ? versionsTip(v) : '',
  };
}

/**
 * Drop trailing bracketed parts of `other` that `lead` already shows:
 * "気分じゃないの (Not in the Mood)" + "Kibun Janai no (Not In The Mood)"
 * shows the second as just "Kibun Janai no".
 */
function stripShared(other, lead) {
  const folded = norm(lead);
  for (;;) {
    const m = other.match(BRACKET);
    if (!m || m.index === 0 || !folded.includes(norm(m[2]))) return other;
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
