// The playing song's signal path, like Roon's: the file, what's done to it
// (ReplayGain, DSP, volume) and what goes out to the device, with a grade.
//
// foobar2000 itself reports the file, the DSP chain, the ReplayGain mode and
// preamp, the volume and the output module and device. The Output Info
// component (foo_outinfo), when installed, adds what actually enters the
// output (sample rate, bit depth, channels after any DSP) and the ReplayGain
// gain actually applied; without it those stages say what can't be known.

import { call, tryCall, on } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';
import { debounce } from '../core/util.js';
import { logInfo } from '../core/log.js';
import { player } from './player.js';
import { measureDsp, describe as describeCheck } from './dspcheck.js';

// Output Info's fields, read in one go ("?" when it isn't installed).
const OUT = ['output_samplerate', 'output_bitdepth', 'output_channels', 'output_device', 'output_dsps', 'output_dsp_preset', 'output_volume', 'output_rg_mode', 'output_rg_source', 'output_rg_gain', 'output_buffer_length'];
const SEP = '␞';
const LOSSLESS = /^(flac|alac|wavpack|monkey'?s audio|ape|tta|pcm|wav|aiff|dsd|dsf|dff|dst|mlp|truehd|shorten|optimfrog|tak)/i;

export const QUALITY = {
  lossless: { label: 'Lossless', note: 'Bit-perfect from file to output.' },
  enhanced: { label: 'Enhanced', note: 'Lossless source with processing applied.' },
  high: { label: 'High quality', note: 'Lossless source, format changed before output.' },
  low: { label: 'Low quality', note: 'Lossy source.' },
};

class SignalPath extends Emitter {
  path = null; // the last one worked out
  hasOutputInfo = null; // Output Info found (null: not checked yet)
  #logged = false;

  init() {
    const again = debounce(() => this.refresh(), 250);
    player.on('track', again);
    player.on('state', again);
    for (const e of ['playback:volumeChanged', 'audio:dspPresetChanged', 'audio:outputDeviceChanged', 'audio:replaygainModeChanged']) on(e, again);
    again();
  }

  #probed = new Map(); // handle -> 'dop' | 'none' | null
  #checked = new Map(); // handle -> the DSP check's result (see dspcheck.js), 'pending', or null

  async refresh() {
    // Paused by stopping (ASIO released): nothing is playing to describe, so
    // the last path stays.
    if (player.released) return this.path;
    const check = (h) => {
      const r = this.#checked.get(h);
      return r && r !== 'pending' ? r : null;
    };
    let path = player.active && player.track ? await build(this.#probed.get(player.track.handle), check(player.track.handle)) : null;
    // A DSD song: check the audio itself for DoP (once per song), then redo.
    const h = player.track?.handle;
    if (path?.dsd && h && !this.#probed.has(h) && player.state === 'playing') {
      this.#probed.set(h, undefined);
      const found = await probeDop(() => player.track?.handle === h && player.state === 'playing');
      this.#probed.set(h, found);
      if (player.track?.handle === h) path = await build(found, check(h));
    }
    // DSPs in the chain: what they really do to this song, measured once.
    if (path?.hasDsp && !path.dsdKept && h && !this.#checked.has(h) && player.state === 'playing') this.#check(player.track);
    // Logged once, and for each DSD song (the DoP check's outcome).
    if (path && (!this.#logged || path.dsd)) {
      this.#logged = true;
      logInfo(`signal path: Output Info ${path.outputInfo ? 'found' : 'not found'}; ${path.stages.map((s) => `${s.title}: ${s.detail}`).join(' → ')} (${path.quality})`);
    }
    this.hasOutputInfo = path ? path.outputInfo : this.hasOutputInfo;
    this.path = path;
    this.emit('change', path);
    return path;
  }

  // A couple of seconds in (past any fade-in), then again later if the music
  // was too quiet to tell or the check couldn't run.
  #check(track, tries = 0) {
    const h = track.handle;
    this.#checked.set(h, 'pending');
    if (track.subsong > 0 || /\.cue$/i.test(track.path || '')) {
      logInfo(`dsp check: skipped (part of a ${/\.cue$/i.test(track.path || '') ? 'CUE sheet' : 'multi-track file'})`);
      this.#checked.set(h, null);
      return;
    }
    const still = () => player.track?.handle === h && player.state === 'playing';
    setTimeout(async () => {
      if (!still()) return this.#checked.delete(h); // try again next time it plays
      const r = await measureDsp(track, still);
      if ((!r || r.kind === 'silent') && tries < 1) {
        this.#checked.set(h, 'pending');
        setTimeout(() => (still() ? this.#check(track, tries + 1) : this.#checked.delete(h)), 8000);
        return;
      }
      this.#checked.set(h, r);
      if (player.track?.handle === h) this.refresh();
    }, tries ? 0 : 2000);
  }
}

async function build(dopSeen, check = null) {
  const pattern = ['%codec%', '[%codec_profile%]', '[%__bitspersample%]', '[%samplerate%]', '[%__channels%]', '[%__encoding%]', '[%bitrate%]', '[%replaygain_track_gain%]', '[%replaygain_album_gain%]', ...OUT.map((f) => `%${f}%`)].join(SEP);
  const [tf, conf, chain, rgMode, rgPre, vol] = await Promise.all([
    tryCall('titleformat.eval', { pattern }),
    tryCall('config.getOutputConfig'),
    tryCall('dsp.getChain'),
    tryCall('replaygain.getMode'),
    tryCall('replaygain.getPreamp'),
    tryCall('audio.getOutputInfo'),
  ]);
  const v = String(tf?.result || '').split(SEP);
  const [codec, profile, bits, rate, channels, encoding, bitrate, rgTrack, rgAlbum] = v;
  const o = Object.fromEntries(OUT.map((f, i) => [f, clean(v[9 + i])]));
  const outputInfo = !!(o.output_samplerate || o.output_device);

  const src = {
    codec: codec || '?',
    lossless: /lossless/i.test(encoding) || (!encoding && LOSSLESS.test(codec || '')),
    // DSD: 1-bit samples (what any DSD decoder reports), or a DSD codec name.
    dsd: num(bits) === 1 || /^(dsd|dsf|dff|dst)/i.test(codec || ''),
    bits: num(bits),
    rate: num(rate),
    channels: num(channels),
    bitrate: num(bitrate),
  };
  const stages = [];
  const changes = []; // what alters the sound on the way (for the grade)

  // 1. The file.
  stages.push({
    kind: 'source',
    icon: src.lossless ? 'lossless' : 'lossy',
    title: 'Source',
    detail: [src.codec + (profile && !/^lossless$/i.test(profile) ? ` ${profile}` : ''), src.dsd ? (dsd(src.rate).toLowerCase() === src.codec.toLowerCase() ? '' : dsd(src.rate)) : khz(src.rate), src.bits && !src.dsd && `${src.bits}-bit`, chans(src.channels), !src.lossless && src.bitrate && `${src.bitrate} kbps`].filter(Boolean).join(' · '),
    grade: src.lossless ? 'lossless' : 'low',
    note: '',
  });

  // DSD reaching the DAC as DSD: natively (output at the DSD rate) or as DoP
  // (DSD packed into PCM frames at 1/16 of its rate: DSD64 = 176.4 kHz). Then
  // foobar2000's PCM processing (ReplayGain, DSP, volume) is bypassed; if it
  // weren't, the packing would break and the DAC couldn't show DSD. A real
  // conversion to PCM at that rate looks the same from here (the DSD decoder's
  // and output's settings aren't readable), so it's assumed from the rate.
  const earlyRate = num(o.output_samplerate);
  const dopRate = src.dsd && src.rate ? src.rate / 16 : 0;
  // From the file's own tags: native when the output runs at the DSD file's
  // own rate, DoP at exactly 1/16 of it.
  const nativeOut = src.dsd && ((!!earlyRate && !!src.rate && Math.abs(earlyRate - src.rate) < 1) || num(o.output_bitdepth) === 1);
  const looksDop = !!dopRate && !!earlyRate && Math.abs(earlyRate - dopRate) < 1;
  // The audio itself, when checked: DoP markers found settle it.
  const dsdKept = src.dsd && (nativeOut || dopSeen === 'dop' || dopSeen === 'bypass' || looksDop);
  const bypassed = (stage) => ({ ...stage, detail: 'Bypassed for DSD', note: '', grade: 'lossless', idle: true });

  // 2. ReplayGain: the gain actually applied (Output Info), else the mode and the song's tags.
  // "auto" follows foobar2000's own playback order: track gain when it
  // shuffles, album gain otherwise (Fusion's shuffle runs foobar2000 in Default).
  let source = String(rgMode?.sourceMode || '').toLowerCase();
  if (source === 'auto') source = /shuffle|random/.test(player.nativeOrder) ? 'track' : 'album';
  const processing = String(rgMode?.processingMode || '').toLowerCase();
  const rgOn = o.output_rg_mode ? !/none|off|disabled/i.test(o.output_rg_mode) : source !== 'none' && source !== '' && /gain/.test(processing);
  let rgGain = null;
  if (rgOn) {
    const applied = o.output_rg_gain ? num(o.output_rg_gain) : null;
    const which = /album/.test(o.output_rg_source || source) ? 'album' : 'track';
    const tagGain = num(which === 'album' ? rgAlbum || rgTrack : rgTrack || rgAlbum);
    const pre = tagGain != null ? num(rgPre?.withRg) : num(rgPre?.withoutRg);
    const gain = applied ?? (tagGain != null ? tagGain + (pre || 0) : pre || null);
    rgGain = gain;
    if (dsdKept) stages.push(bypassed({ kind: 'rg', icon: 'gain', title: 'ReplayGain' }));
    else if (gain == null || Math.abs(gain) >= 0.005) {
      changes.push('ReplayGain');
      stages.push({ kind: 'rg', icon: 'gain', title: 'ReplayGain', detail: gain != null ? `${which === 'album' ? 'Album' : 'Track'} gain ${signed(gain)} dB` : `${which === 'album' ? 'Album' : 'Track'} gain (not tagged)`, grade: gain == null ? 'lossless' : 'enhanced', note: '' });
    }
  }

  // 3. DSP chain. Every DSP in it sees the audio, but many only act on some
  // songs: those Fusion knows are checked against this one, and shown as
  // passing it through untouched when they don't apply.
  const dsps = (chain?.dsps || []).map((d) => d.name).filter(Boolean);
  const dspList = dsps.length ? dsps : o.output_dsps ? o.output_dsps.split(/\s*[,;]\s*/).filter(Boolean) : [];
  const outRateEarly = num(o.output_samplerate);
  for (const name of dspList) {
    const act = dspActs(name, src, outRateEarly);
    if (dsdKept) {
      stages.push(bypassed({ kind: 'dsp', icon: /resampl/i.test(name) ? 'resample' : 'dsp', title: name }));
      continue;
    }
    if (act.acts) changes.push(name);
    stages.push({
      kind: 'dsp',
      icon: /resampl/i.test(name) ? 'resample' : 'dsp',
      title: name,
      detail: act.detail,
      grade: act.acts ? 'enhanced' : 'lossless',
      note: act.note,
      idle: !act.acts,
    });
  }

  // 3b. The DSP chain measured: the audio after it against the file itself
  // (dspcheck.js). It settles what the rules above could only guess.
  if (check && dspList.length && !dsdKept) {
    let kind = check.kind;
    // Taken before ReplayGain, by the component's docs; if it's in there after
    // all, a level change of exactly its gain is ReplayGain's, not the DSPs'.
    if (kind === 'gain' && rgGain != null && Math.abs(check.db - rgGain) < 0.05) kind = 'same';
    const dspStages = stages.filter((st) => st.kind === 'dsp');
    if (kind === 'same') {
      for (const st of dspStages) {
        const at = st.idle ? -1 : changes.indexOf(st.title);
        if (at >= 0) changes.splice(at, 1);
        Object.assign(st, { idle: true, grade: 'lossless', detail: st.idle ? st.detail : 'No change to this song' });
      }
    } else if (kind !== 'silent') {
      // Something changes it: which DSP isn't known when the rules say none.
      if (!dspStages.some((st) => !st.idle)) changes.push('DSP');
      if (kind === 'rate') changes.push('sample rate');
    }
    if (kind !== 'silent') {
      stages.push({
        kind: 'check',
        icon: 'check',
        title: 'Checked',
        detail: kind === 'same' ? 'The DSPs leave this song unchanged' : describeCheck(check),
        grade: kind === 'same' ? 'lossless' : kind === 'rate' ? 'high' : 'enhanced',
        note: kind === 'same' ? 'After the DSPs, the audio matches the file sample for sample.' : kind === 'gain' ? 'After the DSPs, the audio is the file at another level.' : 'After the DSPs, the audio differs from the file.',
      });
    }
  }

  // 4. Volume: anything below 0 dB scales the samples.
  const dB = o.output_volume && o.output_volume !== '-inf' ? num(o.output_volume) : num(vol?.volume);
  if (dB != null && dB < -0.005 && dsdKept) stages.push(bypassed({ kind: 'volume', icon: 'volume', title: 'Volume' }));
  else if (dB != null && dB < -0.005) {
    changes.push('volume');
    stages.push({ kind: 'volume', icon: 'volume', title: 'Volume', detail: `${dB.toFixed(1).replace('-', '−')} dB`, grade: 'enhanced', note: 'Digital attenuation. Set to 0 dB for bit-perfect output.' });
  }

  // 5. Output: module, device and the format going out.
  const module = conf?.outputName || '';
  // Output Info names the device as "<module>: <device>".
  const device = String(o.output_device || conf?.deviceName || '').replace(new RegExp(`^${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i'), '');
  const outBits = num(o.output_bitdepth) ?? (conf?.bitDepth || null);
  const outRate = num(o.output_samplerate);
  const outCh = num(o.output_channels);
  const exclusive = /asio|exclusive|kernel streaming|\bks\b/i.test(`${module} ${device}`);
  // foobar2000's own output is called "Default": it's WASAPI, exclusive for
  // devices marked [exclusive], else shared (through Windows' mixer).
  const builtIn = !module || /^default$/i.test(module);
  const outTitle = builtIn ? (exclusive ? 'WASAPI (exclusive)' : 'WASAPI (shared)') : /asio/i.test(module) ? 'ASIO' : module;
  const deviceName = device.replace(/\s*\[exclusive\]\s*$/i, '');
  // The output is DSD: the DSD file at its own rate, or (PCM made into DSD
  // on the way) exactly a standard DSD rate, DSD32 to DSD1024.
  const outDsd = !!outRate && (nativeOut || (!src.dsd && (outBits === 1 || isDsdRate(outRate))));
  const fmtOut = dsdKept
    ? [dsd(src.rate), outDsd ? 'native DSD' : dopSeen === 'bypass' ? 'sent directly' : looksDop ? `DoP (in ${khz(outRate || dopRate)} frames)` : '', chans(outCh)].filter(Boolean).join(' · ')
    : [outDsd ? dsd(outRate) : khz(outRate), !outDsd && outBits && `${outBits}-bit`, chans(outCh)].filter(Boolean).join(' · ');
  if (!src.dsd && outputInfo && src.rate && outRate && outRate !== src.rate && !dspList.some((n) => /resampl/i.test(n))) changes.push('sample rate');
  // DSD turned into PCM on the way, or PCM into DSD (a DSD processor or the output).
  const dsdToPcm = outputInfo && src.dsd && !dsdKept && !!outRate && !outDsd;
  const pcmToDsd = outputInfo && !src.dsd && outDsd;
  if (dsdToPcm) changes.push('DSD to PCM');
  if (pcmToDsd) changes.push('PCM to DSD');
  const truncated = !src.dsd && !dsdKept && !outDsd && src.bits && outBits && outBits < src.bits;
  if (truncated) changes.push('bit depth');
  stages.push({
    kind: 'output',
    icon: 'output',
    title: outTitle,
    detail: [deviceName && deviceName !== module ? deviceName : '', fmtOut || (outputInfo ? '' : 'format unknown')].filter(Boolean).join(' · '),
    grade: truncated || dsdToPcm ? 'high' : pcmToDsd ? 'enhanced' : 'lossless',
    note: dsdKept
      ? outDsd
        ? 'Native DSD.'
        : dopSeen === 'dop'
          ? 'DoP, verified from the stream.'
          : dopSeen === 'bypass'
            ? 'DSD sent directly, bypassing the DSP chain.'
            : 'DoP, assumed from the sample rate.'
      : dsdToPcm
        ? 'DSD converted to PCM.'
        : pcmToDsd
          ? 'PCM converted to DSD.'
          : truncated
            ? `Output bit depth ${outBits}-bit, source ${src.bits}-bit${conf?.useDither ? ', dithered' : ''}.`
            : exclusive
              ? 'Exclusive mode.'
              : 'Shared mode.',
  });

  // 6. Shared mode: Windows' mixer converts to the device's own format.
  if (!exclusive) {
    changes.push('Windows mixer');
    stages.push({ kind: 'mixer', icon: 'windows', title: 'Windows mixer', detail: 'May resample to the device format', grade: 'high', note: 'Use an [exclusive] device or ASIO to bypass.' });
  }

  let quality;
  if (!src.lossless) quality = 'low';
  else if (['Windows mixer', 'bit depth', 'sample rate', 'DSD to PCM'].some((c) => changes.includes(c))) quality = 'high';
  else if (changes.length) quality = 'enhanced';
  else quality = 'lossless';
  return { quality, stages, outputInfo, changes, dsd: src.dsd, dsdKept, hasDsp: dspList.length > 0 };
}

/**
 * Whether a DSP changes this song, for the ones whose rules are known.
 * Others are taken to change it.
 */
function dspActs(name, src, outRate) {
  const n = name.toLowerCase();
  if (/skip track/.test(n)) return { acts: false, detail: 'No effect on audio', note: '' };
  if (/downmix.*stereo|stereo.*downmix/.test(n)) {
    const acts = src.channels > 2;
    return { acts, detail: acts ? `${chans(src.channels)} → stereo` : 'Inactive (source is stereo)', note: '' };
  }
  if (/downmix.*mono|mono/.test(n)) {
    const acts = src.channels > 1;
    return { acts, detail: acts ? `${chans(src.channels)} → mono` : 'Inactive (source is mono)', note: '' };
  }
  if (/resampl|sample rate/.test(n)) {
    if (outRate && src.rate) {
      const acts = outRate !== src.rate;
      return { acts, detail: acts ? `${khz(src.rate)} → ${khz(outRate)}` : `Inactive (source is ${khz(src.rate)})`, note: '' };
    }
    return { acts: true, detail: 'Resampling', note: '' };
  }
  return { acts: true, detail: 'Active', note: '' };
}

/**
 * Check foobar2000's own playing stream (its visualisation stream) during a
 * DSD song, a few times over some seconds:
 * - DoP markers (each 24-bit sample's top byte alternating 0x05 / 0xFA on both
 *   channels): the DSD is packed as DoP and untouched up to there -> 'dop'.
 * - Exact digital silence every time: the DSD is going to the output some
 *   other way, around foobar2000's processing (seen with ASIO DSD output),
 *   so nothing in the chain touches it -> 'bypass'. A conversion to PCM
 *   would put actual audio in the stream.
 * - Anything else: can't tell from here -> null (the rate decides).
 */
const PROBE_ID = 'fusion-dop-probe';
export async function probeDop(stillPlaying) {
  const sub = await tryCall('audio.subscribeSpectrum', { subscriptionId: PROBE_ID, fps: 1, event: 'fusion:dop-probe', backgroundThrottle: false });
  if (!sub) return logInfo('signal path: stream check: the stream isn’t available'), null;
  const int = (v) => Math.round(v * 8388608) & 0xffffff; // as a 24-bit sample
  const top = (v) => (int(v) >> 16) & 0xff;
  const read = async (args, what) => {
    try {
      return await call('audio.getWaveform', { signed: true, channels: 'stereo', ...args });
    } catch (err) {
      logInfo(`signal path: stream check: ${what} not read (${err?.message || err})`);
      return null;
    }
  };
  try {
    await new Promise((r) => setTimeout(r, 1200)); // the stream starts about 0.7 s after subscribing
    if (!stillPlaying()) return null;
    // 1. DoP: 20 ms of consecutive samples.
    const w = await read({ duration: 0.02 }, 'DoP window');
    if (w?.left?.length) {
      let marked = 0;
      for (let i = 1; i < w.left.length; i++) {
        const a = top(w.left[i - 1]);
        const b = top(w.left[i]);
        if (b === top(w.right[i]) && ((a === 0x05 && b === 0xfa) || (a === 0xfa && b === 0x05))) marked++;
      }
      const share = marked / (w.left.length - 1);
      logInfo(`signal path: stream check: ${w.left.length} samples at ${w.sampleRate} Hz, DoP markers ${(share * 100).toFixed(1)}%; first ${w.left.slice(0, 6).map((v) => int(v).toString(16).padStart(6, '0')).join(' ')}`);
      if (share > 0.95) return 'dop';
    }
    // 2. Silence: a whole second, 4096 samples spread across it, twice.
    for (const pause of [0, 1500]) {
      if (pause) await new Promise((r) => setTimeout(r, pause));
      if (!stillPlaying()) return null;
      const long = await read({ duration: 1, points: 4096 }, 'one-second window');
      if (!long?.left?.length) return null;
      const loud = long.left.reduce((n, v, i) => n + (v !== 0 || long.right[i] !== 0 ? 1 : 0), 0);
      logInfo(`signal path: stream check: 1 s window, ${loud} of ${long.left.length} samples non-zero`);
      if (loud) return null; // real audio in the stream: can't tell from here
    }
    return 'bypass';
  } finally {
    tryCall('audio.unsubscribeSpectrum', { subscriptionId: PROBE_ID });
  }
}

const clean = (s) => (s && s !== '?' ? String(s).trim() : '');
const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
const khz = (hz) => (hz ? `${+(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : '');
// DSD rates as multiples of 44.1 kHz (DSD64 = 2.8224 MHz).
const isDsdRate = (hz) => [32, 64, 128, 256, 512, 1024].some((m) => Math.abs(hz - m * 44100) < 1);
const dsd = (hz) => (hz ? `DSD${Math.round(hz / 44100)}` : '');
const chans = (n) => (!n ? '' : n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} ch`);

export const signalPath = new SignalPath();
