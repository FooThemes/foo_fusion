// The playing song's signal path, like Roon's: the file, what's done to it
// (ReplayGain, DSP, volume) and what goes out to the device, with a grade.
//
// foobar2000 itself reports the file, the DSP chain, the ReplayGain mode and
// preamp, the volume and the output module and device. The Output Info
// component (foo_outinfo), when installed, adds what actually enters the
// output (sample rate, bit depth, channels after any DSP) and the ReplayGain
// gain actually applied; without it those stages say what can't be known.

import { tryCall, on } from '../core/bridge.js';
import { Emitter } from '../core/emitter.js';
import { debounce } from '../core/util.js';
import { logInfo } from '../core/log.js';
import { player } from './player.js';

// Output Info's fields, read in one go ("?" when it isn't installed).
const OUT = ['output_samplerate', 'output_bitdepth', 'output_channels', 'output_device', 'output_dsps', 'output_dsp_preset', 'output_volume', 'output_rg_mode', 'output_rg_source', 'output_rg_gain', 'output_buffer_length'];
const SEP = '␞';
const LOSSLESS = /^(flac|alac|wavpack|monkey'?s audio|ape|tta|pcm|wav|aiff|dsd|dsf|dff|dst|mlp|truehd|shorten|optimfrog|tak)/i;

export const QUALITY = {
  lossless: { label: 'Lossless', note: 'The file reaches the output unchanged.' },
  enhanced: { label: 'Enhanced', note: 'A lossless file, deliberately processed on the way (DSP, ReplayGain, volume).' },
  high: { label: 'High quality', note: 'A lossless file, but the format is changed on the way or may be.' },
  low: { label: 'Low quality', note: 'A lossy file: some of the original was discarded when it was encoded.' },
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

  async refresh() {
    let path = player.active && player.track ? await build(this.#probed.get(player.track.handle)) : null;
    // A DSD song: check the audio itself for DoP (once per song), then redo.
    const h = player.track?.handle;
    if (path?.dsd && h && !this.#probed.has(h) && player.state === 'playing') {
      this.#probed.set(h, undefined);
      const found = await probeDop();
      this.#probed.set(h, found);
      if (player.track?.handle === h) path = await build(found);
    }
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
}

async function build(dopSeen) {
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
    note: src.lossless ? 'Lossless: every sample of the original is there.' : 'Lossy: compressed by discarding parts of the sound judged inaudible.',
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
  const dsdKept = src.dsd && (nativeOut || dopSeen === 'dop' || (looksDop && dopSeen !== 'none'));
  const bypassed = (stage) => ({ ...stage, detail: 'Not applied: DSD passes through untouched', note: 'foobar2000’s PCM processing doesn’t touch DSD sent to the DAC as DSD.', grade: 'lossless', idle: true });

  // 2. ReplayGain: the gain actually applied (Output Info), else the mode and the song's tags.
  // "auto" follows foobar2000's own playback order: track gain when it
  // shuffles, album gain otherwise (Fusion's shuffle runs foobar2000 in Default).
  let source = String(rgMode?.sourceMode || '').toLowerCase();
  if (source === 'auto') source = /shuffle|random/.test(player.nativeOrder) ? 'track' : 'album';
  const processing = String(rgMode?.processingMode || '').toLowerCase();
  const rgOn = o.output_rg_mode ? !/none|off|disabled/i.test(o.output_rg_mode) : source !== 'none' && source !== '' && /gain/.test(processing);
  if (rgOn) {
    const applied = o.output_rg_gain ? num(o.output_rg_gain) : null;
    const which = /album/.test(o.output_rg_source || source) ? 'album' : 'track';
    const tagGain = num(which === 'album' ? rgAlbum || rgTrack : rgTrack || rgAlbum);
    const pre = tagGain != null ? num(rgPre?.withRg) : num(rgPre?.withoutRg);
    const gain = applied ?? (tagGain != null ? tagGain + (pre || 0) : pre || null);
    if (dsdKept) stages.push(bypassed({ kind: 'rg', icon: 'gain', title: 'ReplayGain' }));
    else if (gain == null || Math.abs(gain) >= 0.005) {
      changes.push('ReplayGain');
      stages.push({ kind: 'rg', icon: 'gain', title: 'ReplayGain', detail: gain != null ? `${which} gain, ${signed(gain)} dB` : `${which} gain (no gain in this song's tags)`, grade: gain == null ? 'lossless' : 'enhanced', note: 'Volume levelled between songs: the samples are scaled.' });
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

  // 4. Volume: anything below 0 dB scales the samples.
  const dB = o.output_volume && o.output_volume !== '-inf' ? num(o.output_volume) : num(vol?.volume);
  if (dB != null && dB < -0.005 && dsdKept) stages.push(bypassed({ kind: 'volume', icon: 'volume', title: 'Volume' }));
  else if (dB != null && dB < -0.005) {
    changes.push('volume');
    stages.push({ kind: 'volume', icon: 'volume', title: 'Volume', detail: `${dB.toFixed(1)} dB`, grade: 'enhanced', note: 'foobar2000’s volume is digital: below full volume the samples are scaled down. For bit-perfect output, leave it at 0 dB and set the volume on your amplifier or DAC.' });
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
    ? [dsd(src.rate), outDsd ? 'native DSD' : looksDop ? `DoP (in ${khz(outRate || dopRate)} frames)` : '', chans(outCh)].filter(Boolean).join(' · ')
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
    detail: [deviceName && deviceName !== module ? deviceName : '', fmtOut || (outputInfo ? '' : 'format: install Output Info to see it')].filter(Boolean).join(' · '),
    grade: truncated || dsdToPcm ? 'high' : pcmToDsd ? 'enhanced' : 'lossless',
    note: dsdKept
      ? outDsd
        ? 'DSD goes to the DAC as it is, natively.'
        : dopSeen === 'dop'
          ? 'DSD goes to the DAC as it is, packed in PCM frames (DoP), which the DAC unpacks. Confirmed: the DoP markers are intact in the playing audio.'
          : 'DSD goes to the DAC as it is, packed in PCM frames (DoP), which the DAC unpacks. Assumed from the rate (the playing audio couldn’t be checked).'
      : dsdToPcm
        ? 'The DSD file is converted to PCM before it goes out.'
      : pcmToDsd
        ? 'Converted to DSD before it goes out.'
        : truncated
      ? `The output is set to ${outBits}-bit, fewer bits than the file's ${src.bits}${conf?.useDither ? ' (dithered)' : ''}.`
      : exclusive
        ? 'Exclusive access: what goes out is what your device receives.'
        : 'Shared: Windows mixes this with other sounds.',
  });

  // 6. Shared mode: Windows' mixer converts to the device's own format.
  if (!exclusive) {
    changes.push('Windows mixer');
    stages.push({ kind: 'mixer', icon: 'windows', title: 'Windows mixer', detail: 'Shared mode: may convert to the device’s own format', grade: 'high', note: 'Windows mixes all programs’ sound and converts it to the format set for the device (Sound settings → device properties → Advanced). For bit-perfect output, use an [exclusive] WASAPI device or ASIO.' });
  }

  let quality;
  if (!src.lossless) quality = 'low';
  else if (['Windows mixer', 'bit depth', 'sample rate', 'DSD to PCM'].some((c) => changes.includes(c))) quality = 'high';
  else if (changes.length) quality = 'enhanced';
  else quality = 'lossless';
  return { quality, stages, outputInfo, changes, dsd: src.dsd, dsdKept };
}

/**
 * Whether a DSP changes this song, for the ones whose rules are known.
 * Others are taken to change it.
 */
function dspActs(name, src, outRate) {
  const n = name.toLowerCase();
  if (/skip track/.test(n)) return { acts: false, detail: 'Doesn’t touch the audio', note: 'Skips songs that match its rules; the sound itself passes through untouched.' };
  if (/downmix.*stereo|stereo.*downmix/.test(n)) {
    const acts = src.channels > 2;
    return { acts, detail: acts ? `${chans(src.channels)} down to stereo` : 'Not needed: already stereo', note: acts ? 'Mixes the extra channels into two.' : 'Only acts on songs with more than two channels.' };
  }
  if (/downmix.*mono|mono/.test(n)) {
    const acts = src.channels > 1;
    return { acts, detail: acts ? 'Mixed down to mono' : 'Not needed: already mono', note: 'Only acts on songs with more than one channel.' };
  }
  if (/resampl|sample rate/.test(n)) {
    if (outRate && src.rate) {
      const acts = outRate !== src.rate;
      return { acts, detail: acts ? `${khz(src.rate)} → ${khz(outRate)}` : `Not needed: already ${khz(src.rate)}`, note: acts ? 'Changes the sample rate.' : 'The song is already at its target rate.' };
    }
    return { acts: true, detail: 'Changes the sample rate', note: 'With Output Info installed, Fusion can tell whether it does for this song.' };
  }
  return { acts: true, detail: 'DSP', note: 'Processes the sound before it goes out.' };
}

/**
 * Look for DoP in the audio foobar2000 is playing (its visualisation stream):
 * in DoP each 24-bit sample's top byte is a marker alternating 0x05 / 0xFA,
 * on both channels at once. Intact markers mean the DSD is packed and
 * untouched up to there; volume, ReplayGain or a conversion to PCM would
 * scramble them. Resolves 'dop', 'none' or null (the stream wasn't readable).
 */
const PROBE_ID = 'fusion-dop-probe';
export async function probeDop() {
  const sub = await tryCall('audio.subscribeSpectrum', { subscriptionId: PROBE_ID, fps: 1, event: 'fusion:dop-probe', backgroundThrottle: false });
  if (!sub) return null;
  try {
    await new Promise((r) => setTimeout(r, 900)); // the stream starts about 0.7 s after subscribing
    const w = await tryCall('audio.getWaveform', { duration: 0.02, signed: true, channels: 'stereo' });
    if (!w?.left?.length) {
      logInfo('signal path: DoP check: no samples from the stream');
      return null;
    }
    const top = (v) => (Math.round(v * 8388608) >> 16) & 0xff; // 24-bit sample's top byte
    let pairs = 0;
    let marked = 0;
    for (let i = 1; i < w.left.length; i++) {
      const a = top(w.left[i - 1]);
      const b = top(w.left[i]);
      const r = top(w.right[i]);
      pairs++;
      if (((a === 0x05 && b === 0xfa) || (a === 0xfa && b === 0x05)) && r === b) marked++;
    }
    const share = pairs ? marked / pairs : 0;
    const raw = w.left.slice(0, 8).map((v) => (Math.round(v * 8388608) & 0xffffff).toString(16).padStart(6, '0'));
    logInfo(`signal path: DoP check: ${w.left.length} samples at ${w.sampleRate} Hz, ${w.channelCount} ch; markers on ${(share * 100).toFixed(1)}%; first samples (24-bit hex) ${raw.join(' ')}`);
    return share > 0.95 ? 'dop' : 'none';
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
