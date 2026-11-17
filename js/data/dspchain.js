// foobar2000's live DSP chain, as it keeps it in the profile: config.fb2k-dsp,
// a JSON list of the DSPs in order, each with its GUID, name and settings
// (base64). It's rewritten when the chain or a DSP's settings change, so it
// shows the Equalizer's curve, and when it changed.
//
// The built-in Equalizer's settings are 18 bytes, one per band: the gain in
// dB plus 20 (20 is flat), at foobar2000's fixed band frequencies.

import { tryCall } from '../core/bridge.js';

export const EQ_GUID = '82AEF845-DCC3-4DA5-9D80-E9A972B2140D';
export const EQ_BANDS = [55, 77, 110, 156, 220, 311, 440, 622, 880, 1200, 1800, 2500, 3500, 5000, 7000, 10000, 14000, 20000];

let profile = null;
async function chainPath() {
  if (!profile) {
    const r = await tryCall('misc.getProfilePath');
    profile = String(r?.path || r?.value || '').replace(/[\\/]$/, '');
  }
  return profile ? `${profile}\\config.fb2k-dsp` : '';
}

/** A short signature of the chain file (changes when foobar2000 rewrites it). */
export async function chainStamp() {
  const path = await chainPath();
  if (!path) return '';
  const info = await tryCall('file.getInfo', { path });
  return info ? JSON.stringify(info) : '';
}

/** The chain as foobar2000 last saved it: [{ guid, name, data }], and the Equalizer's bands (dB) if it's in there. */
export async function readChain() {
  const path = await chainPath();
  if (!path) return null;
  const res = await tryCall('file.read', { path });
  let list;
  try {
    list = JSON.parse(res?.content ?? '');
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const dsps = list.map((d) => ({ guid: String(d.guid || '').toUpperCase(), name: d.name || '', data: d.data || '' }));
  const eq = dsps.find((d) => d.guid === EQ_GUID);
  return { dsps, eq: eq ? decodeEq(eq.data) : null };
}

/** The Equalizer's gains in dB, per band (null if its settings aren't the 18 bytes expected). */
export function decodeEq(b64) {
  let bin;
  try {
    bin = atob(b64 || '');
  } catch {
    return null;
  }
  if (bin.length !== EQ_BANDS.length) return null;
  return Array.from(bin, (ch) => ch.charCodeAt(0) - 20);
}

const hz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f % 1000 ? 1 : 0)} kHz` : `${f} Hz`);

/** The curve in a few words: its biggest boost and cut ("+4 dB at 110 Hz, −3 dB at 7 kHz"), or flat. */
export function describeEq(bands) {
  if (!bands) return '';
  if (bands.every((g) => g === 0)) return 'Flat';
  let up = 0;
  let down = 0;
  bands.forEach((g, i) => {
    if (g > bands[up]) up = i;
    if (g < bands[down]) down = i;
  });
  const parts = [];
  if (bands[up] > 0) parts.push(`+${bands[up]} dB at ${hz(EQ_BANDS[up])}`);
  if (bands[down] < 0) parts.push(`−${-bands[down]} dB at ${hz(EQ_BANDS[down])}`);
  return parts.join(', ');
}
