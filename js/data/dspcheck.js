// What the DSP chain really does to the playing song: the audio as played
// (audio.subscribeStream: taken after the DSPs, before ReplayGain and the
// volume) compared with the same part of the file decoded on its own
// (audio.decodePcm). Identical samples mean the DSPs left it alone; a constant
// ratio means they only changed its level; a different rate or channel count
// means they resampled or remixed it; anything else, that they changed it.
//
// Both calls are experimental in foo_ui_webview2, and their samples come as
// shared memory (sharedbufferreceived), read-only, released after use.

import { call, tryCall, on } from '../core/bridge.js';
import { logInfo } from '../core/log.js';
import { player } from './player.js';

const STREAM_ID = 'fusion-dsp-check';
const SNAP = 0.5; // seconds of the stream compared
const BEFORE = 3; // seconds of the file decoded before where playback is…
const AFTER = 2; // …and after (the stream has no timestamp: found by search)

// --- Shared buffers and component events, matched to whoever waits ---------

const got = new Map(); // key -> event/data that came before anyone waited
const waiting = new Map(); // key -> resolve
let listening = false;

function deliver(key, value) {
  const w = waiting.get(key);
  if (w) {
    waiting.delete(key);
    w(value);
  } else got.set(key, value);
}

function listen() {
  if (listening) return !!window.chrome?.webview;
  listening = true;
  const wv = window.chrome?.webview;
  if (!wv) return false;
  // The buffer is taken while the event is being handled: asked for later
  // (after an await), it came back already detached.
  wv.addEventListener('sharedbufferreceived', (e) => {
    const data = e.additionalData || {};
    if (data.purpose !== 'audio.decodePcm' && !(data.purpose === 'audio.subscribeStream' && data.subscriptionId === STREAM_ID)) return;
    let buffer = null;
    try {
      buffer = e.getBuffer();
    } catch (err) {
      logInfo(`dsp check: ${data.purpose} buffer couldn't be taken (${err?.message || err})`);
      return;
    }
    const got1 = { buffer, data };
    if (data.purpose === 'audio.decodePcm') deliver(`buf:${data.taskId}`, got1);
    else {
      // A newer epoch (the format changed) replaces one nobody took yet.
      if (got.has('stream')) release(got.get('stream').buffer);
      deliver('stream', got1);
    }
  });
  on('audio:pcmReady', (d) => deliver(`ready:${d.taskId}`, d));
  on('audio:pcmFailed', (d) => deliver(`ready:${d.taskId}`, { failed: true, ...d }));
  return true;
}

function wait(key, ms) {
  if (got.has(key)) {
    const v = got.get(key);
    got.delete(key);
    return Promise.resolve(v);
  }
  return new Promise((resolve) => {
    waiting.set(key, resolve);
    setTimeout(() => {
      if (waiting.get(key) === resolve) {
        waiting.delete(key);
        resolve(null);
      }
    }, ms);
  });
}

const release = (buf) => {
  try {
    if (buf) window.chrome.webview.releaseBuffer(buf);
  } catch {
    /* already released */
  }
};

// --- Reading the buffers ----------------------------------------------------

/**
 * The newest `seconds` of the stream's ring buffer, copied out (interleaved),
 * read under its sequence lock (odd while the host writes: try again).
 */
export function readStream(buf, rate, channels, seconds = SNAP) {
  const dv = new DataView(buf);
  const cap = dv.getUint32(24, true);
  const ring = new Float32Array(buf, 64, cap * channels);
  for (let tries = 0; tries < 50; tries++) {
    const seq = dv.getUint32(28, true);
    if (seq & 1) continue;
    const written = dv.getUint32(32, true);
    const slot = dv.getUint32(60, true); // where the next frame goes
    const frames = Math.min(Math.round(seconds * rate), written, cap);
    const data = new Float32Array(frames * channels);
    const first = (slot - frames + cap) % cap;
    for (let i = 0; i < frames; i++) {
      const s = ((first + i) % cap) * channels;
      for (let c = 0; c < channels; c++) data[i * channels + c] = ring[s + c];
    }
    if (dv.getUint32(28, true) === seq) return { rate, channels, frames, data };
  }
  return null;
}

/** A decoded part of the file, copied out of its buffer (one array per channel). */
export function readDecoded(buf, rate, channels, frames) {
  const cap = new DataView(buf).getUint32(24, true);
  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(new Float32Array(buf, 64 + c * cap * 4, frames).slice());
  return { rate, channels, frames, chans };
}

// --- The comparison -----------------------------------------------------------

const dB = (ratio) => 20 * Math.log10(ratio);

/**
 * What's different between the stream (as played) and the file (decoded):
 *   { kind: 'same' }                      sample for sample (to −120 dB)
 *   { kind: 'gain', db }                  only the level
 *   { kind: 'changed', db? }              more than the level (db: roughly)
 *   { kind: 'rate', from, to }            resampled
 *   { kind: 'channels', from, to }        downmixed, upmixed
 *   { kind: 'silent' }                    nothing to compare yet
 */
export function compareAudio(st, src) {
  if (st.rate !== src.rate) return { kind: 'rate', from: src.rate, to: st.rate };
  if (st.channels !== src.channels) return { kind: 'channels', from: src.channels, to: st.channels };
  const C = st.channels;
  const n = st.frames;
  let peak = 0;
  for (let i = 0; i < st.data.length; i++) peak = Math.max(peak, Math.abs(st.data[i]));
  if (peak < 1e-5) return { kind: 'silent' };

  // Where the stream sits in the file: a run of samples that matches, allowing
  // for a constant gain (the ratio is taken from the first of them).
  const s0 = (i) => st.data[i * C];
  const d0 = src.chans[0];
  const K = 64;
  let anchor = -1;
  for (let i = 0; i < n - K; i++) {
    if (Math.abs(s0(i)) > peak * 0.2) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return { kind: 'silent' };
  const tol = peak * 2e-5;
  let offset = null;
  let ratio = 1;
  for (let o = 0; o + K < src.frames; o++) {
    const d = d0[o];
    if (Math.abs(d) < 1e-7) continue;
    const r = s0(anchor) / d;
    if (!(r > 0.01 && r < 100)) continue;
    let k = 1;
    for (; k < K; k++) if (Math.abs(s0(anchor + k) - r * d0[o + k]) > tol) break;
    if (k === K) {
      offset = o - anchor; // file frame of stream frame 0
      ratio = r;
      break;
    }
  }

  const rms = (a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / Math.max(1, a.length));
  };
  if (offset == null) {
    // Not the file's samples at any level: changed. Roughly how loud, from the
    // stream against the decoded part around it.
    const level = rms(st.data) / Math.max(1e-9, Math.sqrt(src.chans.reduce((s, ch) => s + rms(ch) ** 2, 0) / C));
    return { kind: 'changed', db: Number.isFinite(level) && level > 0 ? dB(level) : null };
  }

  // Every channel over the overlap: the best gain, what's left over, and the
  // largest difference at unity gain.
  const from = Math.max(0, -offset);
  const to = Math.min(n, src.frames - offset);
  let sd = 0;
  let dd = 0;
  let maxDiff = 0;
  for (let c = 0; c < C; c++) {
    const d = src.chans[c];
    for (let i = from; i < to; i++) {
      const a = st.data[i * C + c];
      const b = d[i + offset];
      sd += a * b;
      dd += b * b;
      maxDiff = Math.max(maxDiff, Math.abs(a - b));
    }
  }
  const g = dd > 0 ? sd / dd : ratio;
  let res = 0;
  let ss = 0;
  for (let c = 0; c < C; c++) {
    const d = src.chans[c];
    for (let i = from; i < to; i++) {
      const a = st.data[i * C + c];
      res += (a - g * d[i + offset]) ** 2;
      ss += a * a;
    }
  }
  const frames = to - from;
  if (maxDiff <= 1e-6) return { kind: 'same', exact: maxDiff === 0, frames, offset };
  if (ss > 0 && res / ss < 1e-8) return { kind: 'gain', db: dB(g), frames, offset };
  return { kind: 'changed', db: dB(Math.sqrt(ss / Math.max(1e-30, dd))), frames, offset };
}

// --- Measuring the playing song --------------------------------------------

/**
 * Measures the playing song (its path; DSD and CUE subsongs aren't checked).
 * Null when it couldn't be measured; `stillPlaying()` is asked as it goes.
 */
export async function measureDsp(track, stillPlaying) {
  if (!listen()) return null;
  const t0 = performance.now();
  let streamBuf = null;
  let pcmBuf = null;
  try {
    // 1. The audio as played: subscribe, let a second build up, copy the newest half.
    const sub = await tryCall('audio.subscribeStream', { subscriptionId: STREAM_ID, bufferSeconds: 2, interval: 0.2 });
    if (!sub) return fail('stream subscription refused');
    const ev = await wait('stream', 3000);
    if (!ev) return fail('no stream buffer came');
    streamBuf = ev.buffer;
    const info = ev.data;
    await new Promise((r) => setTimeout(r, 1300));
    if (!stillPlaying()) return fail('stopped playing');
    const at = player.now(); // where playback is, as the snapshot is taken
    const st = readStream(streamBuf, info.sampleRate, info.channels);
    if (!st || st.frames < info.sampleRate * 0.2) return fail('stream too short');

    // 2. The same part of the file, decoded on its own.
    const start = Math.max(0, at - BEFORE);
    const res = await call('audio.decodePcm', { path: track.path || track.handle, start, end: at + AFTER });
    const [buf, ready] = await Promise.all([wait(`buf:${res.taskId}`, 15000), wait(`ready:${res.taskId}`, 15000)]);
    if (buf) pcmBuf = buf.buffer;
    if (!ready || ready.failed) return fail(`decode failed: ${ready?.error || ready?.code || 'no answer'}`);
    if (!pcmBuf) return fail('no decode buffer came');
    const src = readDecoded(pcmBuf, ready.sampleRate, ready.channels, ready.frames);

    // 3. Compared.
    const out = { ...compareAudio(st, src), ms: Math.round(performance.now() - t0) };
    logInfo(`dsp check: ${describe(out)} (stream ${st.rate} Hz × ${st.channels}, file ${src.rate} Hz × ${src.channels}, ${st.frames} frames, ${out.ms} ms)`);
    return out;
  } catch (e) {
    return fail(e?.message || String(e));
  } finally {
    await tryCall('audio.unsubscribeStream', { subscriptionId: STREAM_ID });
    release(streamBuf);
    release(pcmBuf);
    // Buffers for epochs nobody waited for.
    for (const [k, v] of got) {
      if (k.startsWith('stream:') || k.startsWith('buf:')) {
        release(v.buffer);
        got.delete(k);
      }
    }
  }
}

function fail(why) {
  logInfo(`dsp check: couldn't measure (${why})`);
  return null;
}

/** The result in a few words (the log, and the signal path's detail). */
export function describe(r) {
  if (!r) return 'not measured';
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
  const khz = (hz) => `${+(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz`;
  const ch = (n) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} ch`);
  switch (r.kind) {
    case 'same':
      return 'Unchanged';
    case 'gain':
      return `Level only: ${signed(r.db)} dB`;
    case 'changed':
      return r.db != null && Math.abs(r.db) >= 0.1 ? `Sound changed (level ${signed(r.db)} dB)` : 'Sound changed';
    case 'rate':
      return `Resampled: ${khz(r.from)} → ${khz(r.to)}`;
    case 'channels':
      return `${ch(r.from)} → ${ch(r.to)}`;
    case 'silent':
      return 'Too quiet to compare';
    default:
      return r.kind;
  }
}
