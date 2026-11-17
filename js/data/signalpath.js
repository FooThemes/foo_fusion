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
import { measureDsp } from './dspcheck.js';
import { chainStamp, readChain, describeEq } from './dspchain.js';

// Output Info's fields, read in one go ("?" when it isn't installed).
const OUT = ['output_samplerate', 'output_bitdepth', 'output_channels', 'output_device', 'output_dsps', 'output_dsp_preset', 'output_volume', 'output_rg_mode', 'output_rg_source', 'output_rg_gain', 'output_buffer_length'];
const SEP = '␞';
const LOSSLESS = /^(flac|alac|wavpack|monkey'?s audio|ape|tta|pcm|wav|aiff|dsd|dsf|dff|dst|mlp|truehd|shorten|optimfrog|tak)/i;

export const QUALITY = {
  lossless: { label: 'Lossless', note: 'Bit-perfect from file to output.' },
  enhanced: { label: 'Enhanced', note: 'Lossless source with processing applied.' },
  high: { label: 'High quality', note: 'Lossless source, format changed before output.' },
  low: { label: 'Low quality', note: 'Lossy source.' },
  broken: { label: 'Not playable', note: "The output can't carry this format as it's sent." },
};

class SignalPath extends Emitter {
  path = null; // the last one worked out
  hasOutputInfo = null; // Output Info found (null: not checked yet)
  #logged = false;

  init() {
    const again = debounce(() => this.refresh(), 250);
    player.on('track', again);
    player.on('state', again);
    on('playback:volumeChanged', again);
    // Settings that change what happens to the sound: measured again.
    for (const e of ['audio:dspPresetChanged', 'audio:outputDeviceChanged', 'audio:replaygainModeChanged']) on(e, () => this.#changed(e));
    // The equalizer's curve, other DSPs' settings and the output's have no
    // event: foobar2000 rewrites its chain file (config.fb2k-dsp) when they
    // change, and the output config is read back. Watched while playing.
    setInterval(() => player.state === 'playing' && this.#watch(), 2000);
    again();
  }

  #stamp = null; // the chain file and output settings, as last seen
  #chain = null; // the chain as foobar2000 saved it (readChain), or a promise of it
  #gen = 0; // bumped when settings change: measurements taken before are dropped
  async #watch() {
    const [file, conf] = await Promise.all([chainStamp(), tryCall('config.getOutputConfig')]);
    const stamp = `${file}|${JSON.stringify(conf)}`;
    if (this.#stamp !== null && stamp !== this.#stamp) this.#changed('settings');
    this.#stamp = stamp;
  }
  #changed(why) {
    logInfo(`signal path: ${why === 'settings' ? 'DSP or output settings' : why} changed; checking again`);
    this.#gen++;
    this.#chain = null;
    this.#checked.clear();
    clearTimeout(this.#againSoon);
    // A moment for foobar2000 to finish writing it all.
    this.#againSoon = setTimeout(() => this.refresh(), 600);
  }
  #againSoon = 0;

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
    this.#chain ||= readChain();
    const chain = await this.#chain;
    let path = player.active && player.track ? await build(this.#probed.get(player.track.handle), check(player.track.handle), chain) : null;
    // A DSD song: check the audio itself for DoP (once per song), then redo.
    const h = player.track?.handle;
    if (path?.dsd && h && !this.#probed.has(h) && player.state === 'playing') {
      this.#probed.set(h, undefined);
      const found = await probeDop(() => player.track?.handle === h && player.state === 'playing');
      this.#probed.set(h, found);
      if (player.track?.handle === h) path = await build(found, check(h), chain);
    }
    // DSPs in the chain: what they really do to this song, measured once.
    if (path?.hasDsp && !path.dsdKept && h && !this.#checked.has(h) && player.state === 'playing') this.#check(player.track);
    // Logged once, and for each DSD song (the DoP check's outcome).
    // Logged once, and for each DSD or multichannel song (with what foobar2000
    // reports about its channels).
    const multi = path && path.layout && !/^(mono|stereo)$/.test(path.layout);
    if (path && (!this.#logged || path.dsd || multi)) {
      this.#logged = true;
      const ch = multi ? ` channels ${JSON.stringify(channelFields())}` : '';
      logInfo(`signal path: Output Info ${path.outputInfo ? 'found' : 'not found'}; ${path.stages.map((s) => `${s.title}: ${String(s.detail ?? '').replace(/\n/g, ' · ')}${s.hidden ? ' [left out]' : ''}`).join(' → ')} (${path.quality})${ch}`);
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
    const gen = this.#gen;
    const still = () => player.track?.handle === h && player.state === 'playing' && this.#gen === gen;
    setTimeout(async () => {
      if (!still()) return this.#gen === gen && this.#checked.delete(h); // try again next time it plays
      const r = await measureDsp(track, still);
      if (this.#gen !== gen) return; // settings changed meanwhile: measured again from there
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

async function build(dopSeen, check = null, chainFile = null) {
  const pattern = ['%codec%', '[%codec_profile%]', '[%__bitspersample%]', '[%samplerate%]', '[%__channels%]', '[%__encoding%]', '[%bitrate%]', '[%replaygain_track_gain%]', '[%replaygain_album_gain%]', ...OUT.map((f) => `%${f}%`), '[%__channel_mask%]', '[%channels%]', '[%WAVEFORMATEXTENSIBLE_CHANNEL_MASK%]'].join(SEP);
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
  const [chMask, chWord, chTag] = v.slice(9 + OUT.length);
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
  src.layout = layoutOf(src.channels, chMask || chTag, chWord, codec);
  lastChannelFields = { channels, mask: chMask, word: chWord, tag: chTag, layout: src.layout };
  const stages = [];
  const changes = []; // what alters the sound on the way (for the grade)

  // 1. The file.
  stages.push({
    kind: 'source',
    icon: src.lossless ? 'lossless' : 'lossy',
    title: 'Source',
    detail: [src.codec + (profile && !/^lossless$/i.test(profile) ? ` ${profile}` : ''), src.dsd ? (dsd(src.rate).toLowerCase() === src.codec.toLowerCase() ? '' : dsd(src.rate)) : khz(src.rate), src.bits && !src.dsd && `${src.bits}-bit`, src.layout, !src.lossless && src.bitrate && `${src.bitrate} kbps`].filter(Boolean).join(' · '),
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
  // The audio itself, when checked: DoP markers found settle it. Silence in
  // the stream means the DSD skipped foobar2000's PCM processing; only an
  // ASIO driver can take it from there as DSD. Any other output (WASAPI) only
  // takes PCM, so the DAC gets the raw DSD bits as PCM: noise.
  const asio = /asio/i.test(conf?.outputName || '');
  const dsdRaw = src.dsd && dopSeen === 'bypass' && !asio && !nativeOut;
  const dsdKept = src.dsd && !dsdRaw && (nativeOut || dopSeen === 'dop' || dopSeen === 'bypass' || looksDop);
  const bypassed = (stage) => ({ ...stage, detail: 'Bypassed for DSD', note: '', grade: 'lossless', idle: true, hidden: true });

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
    if (dsdKept || dsdRaw) stages.push(bypassed({ kind: 'rg', icon: 'gain', title: 'ReplayGain' }));
    else if (gain == null || Math.abs(gain) >= 0.005) {
      changes.push('ReplayGain');
      stages.push({ kind: 'rg', icon: 'gain', title: 'ReplayGain', detail: gain != null ? `${which === 'album' ? 'Album' : 'Track'} gain ${signed(gain)} dB` : `${which === 'album' ? 'Album' : 'Track'} gain (not tagged)`, grade: gain == null ? 'lossless' : 'enhanced', note: '', clipGuard: /clip/.test(processing) });
    }
  }

  // 3. DSP chain. Every DSP in it sees the audio, but many only act on some
  // songs: those Fusion knows are checked against this one, and shown as
  // passing it through untouched when they don't apply.
  const dsps = (chain?.dsps || []).map((d) => d.name).filter(Boolean);
  const dspList = dsps.length ? dsps : o.output_dsps ? o.output_dsps.split(/\s*[,;]\s*/).filter(Boolean) : [];
  const outRateEarly = num(o.output_samplerate);
  for (const name of dspList) {
    const act = dspActs(name, src, outRateEarly, chainFile);
    if (dsdKept || dsdRaw) {
      stages.push(bypassed({ kind: 'dsp', icon: dspIcon(name), title: name }));
      continue;
    }
    if (act.acts) changes.push(name);
    stages.push({
      kind: 'dsp',
      icon: dspIcon(name),
      title: name,
      detail: act.detail,
      grade: act.acts ? 'enhanced' : 'lossless',
      note: act.note,
      idle: !act.acts,
      hidden: !act.acts, // inactive: left out
      unknown: !!act.unknown,
    });
  }

  // 3b. The DSP chain measured: the audio after it against the file itself
  // (dspcheck.js). It settles what the rules above could only guess.
  if (check && dspList.length && !dsdKept && !dsdRaw && check.kind !== 'silent') {
    let kind = check.kind;
    // The stream turns out to include ReplayGain (the docs say it's taken
    // before it): a level change no louder than its gain is ReplayGain's,
    // lower when foobar2000 holds it back to prevent clipping.
    const rgStage = stages.find((st) => st.kind === 'rg');
    if (kind === 'gain' && rgStage && rgGain != null && check.db <= rgGain + 0.05) {
      kind = 'same';
      if (Math.abs(check.db - rgGain) >= 0.05) rgStage.detail += ` (${signed(check.db)} dB applied${rgStage.clipGuard && check.db < rgGain ? ', to prevent clipping' : ''})`;
    }
    const dspStages = stages.filter((st) => st.kind === 'dsp');
    const unknown = dspStages.filter((st) => st.unknown);
    const dropChange = (st) => {
      const at = changes.indexOf(st.title);
      if (at >= 0) changes.splice(at, 1);
    };
    if (kind === 'same') {
      // Measured: they pass this song through untouched, so they're left out.
      for (const st of dspStages) {
        dropChange(st);
        Object.assign(st, { idle: true, hidden: true, grade: 'lossless' });
      }
    } else if (kind === 'gain' || kind === 'changed') {
      // The DSPs Fusion can't judge by name are what changes it.
      const detail = kind === 'gain' ? `Changes the level: ${signed(check.db)} dB` : 'Changes the sound';
      for (const st of unknown) st.detail = st.icon === 'eq' && st.detail && st.detail !== 'Active' ? `${st.detail} · ${detail.replace(/^Changes the /, '')}` : detail;
      if (!unknown.length && !dspStages.some((st) => !st.hidden)) {
        changes.push('DSP');
        const at = stages.findIndex((st) => st.kind === 'volume' || st.kind === 'output');
        stages.splice(at < 0 ? stages.length : at, 0, { kind: 'dsp', icon: 'dsp', title: 'DSP chain', detail, grade: 'enhanced', note: '' });
      }
    }
    // A different rate or channel count: the DSP that does it is named by the
    // rules above; nothing to add (the rest can't be compared then).
  }

  // 4. Volume: anything below 0 dB scales the samples.
  const dB = o.output_volume && o.output_volume !== '-inf' ? num(o.output_volume) : num(vol?.volume);
  if (dB != null && dB < -0.005 && (dsdKept || dsdRaw)) stages.push(bypassed({ kind: 'volume', icon: 'volume', title: 'Volume' }));
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
  const fmtOut = dsdRaw
    ? [dsd(src.rate), 'raw DSD on a PCM output'].join(' · ')
    : dsdKept
    ? [dsd(src.rate), outDsd ? 'native DSD' : dopSeen === 'bypass' ? 'sent directly' : looksDop ? `DoP (in ${khz(outRate || dopRate)} frames)` : '', chans(outCh)].filter(Boolean).join(' · ')
    : [outDsd ? dsd(outRate) : khz(outRate), !outDsd && outBits && `${outBits}-bit`, chans(outCh)].filter(Boolean).join(' · ');
  if (!src.dsd && outputInfo && src.rate && outRate && outRate !== src.rate && !dspList.some((n) => /resampl/i.test(n))) changes.push('sample rate');
  // DSD turned into PCM on the way, or PCM into DSD (a DSD processor or the output).
  const dsdToPcm = outputInfo && src.dsd && !dsdKept && !dsdRaw && !!outRate && !outDsd;
  const pcmToDsd = outputInfo && !src.dsd && outDsd;
  if (dsdToPcm) changes.push('DSD to PCM');
  if (pcmToDsd) changes.push('PCM to DSD');
  const truncated = !src.dsd && !dsdKept && !outDsd && src.bits && outBits && outBits < src.bits;
  if (truncated) changes.push('bit depth');
  stages.push({
    kind: 'output',
    icon: 'output',
    title: outTitle,
    detail: [deviceName && deviceName !== module ? deviceName : '', fmtOut || (outputInfo ? '' : 'format unknown')].filter(Boolean).join('\n'), // the device, then the format, on their own lines
    grade: dsdRaw ? 'broken' : truncated || dsdToPcm ? 'high' : pcmToDsd ? 'enhanced' : 'lossless',
    note: dsdRaw
      ? `The DSD decoder passes DSD straight through, but ${outTitle} only takes PCM, so the DAC plays it as noise. Use ASIO, or set the DSD decoder to output PCM or DoP.`
      : dsdKept
      ? outDsd
        ? 'Native DSD.'
        : dopSeen === 'dop'
          ? 'DoP, verified from the stream.'
          : dopSeen === 'bypass'
            ? 'DSD sent directly through ASIO. ReplayGain, DSPs and volume are bypassed.'
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
  if (dsdRaw) quality = 'broken';
  else if (!src.lossless) quality = 'low';
  else if (['Windows mixer', 'bit depth', 'sample rate', 'DSD to PCM'].some((c) => changes.includes(c))) quality = 'high';
  else if (changes.length) quality = 'enhanced';
  else quality = 'lossless';
  return { quality, stages, outputInfo, changes, dsd: src.dsd, dsdKept, dsdRaw, hasDsp: dspList.length > 0, hasEq: !dsdKept && !dsdRaw && dspList.some((n) => /^equali[sz]er$/i.test(n)), layout: src.layout };
}

/**
 * Whether a DSP changes this song, for the ones whose rules are known.
 * Others are taken to change it.
 */
// The channel layout's name: from the file's channel mask when foobar2000
// gives one, else the format's own standard order (FLAC, ALAC, AAC, Vorbis,
// Opus, WavPack, AC3, DTS… define 6 channels as 5.1), else just a count (WAV
// or AIFF without a mask can be any 6 channels).
const SPEAKER_LFE = 0x8;
const STANDARD = { 1: 'mono', 2: 'stereo', 3: '3.0', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1' };
const STANDARD_ORDER = /^(flac|alac|aac|vorbis|opus|wavpack|ac3|e-ac3|eac3|dts|truehd|mlp|tta|monkey|ape|dsd|dsf|dff|dst|mp3)/i;
let lastChannelFields = null;
export function layoutOf(count, maskText, word, codec) {
  if (!count) return '';
  const raw = String(maskText || '').trim();
  const mask = /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : /^\d+$/.test(raw) ? +raw : 0;
  if (mask) {
    let bits = 0;
    for (let m = mask; m; m &= m - 1) bits++;
    if (bits === count) {
      const lfe = mask & SPEAKER_LFE ? 1 : 0;
      if (!lfe && count <= 2) return count === 1 ? 'mono' : 'stereo';
      return `${count - lfe}.${lfe}`;
    }
  }
  if (/^\d\.\d$/.test(String(word || '').trim())) return String(word).trim(); // "5.1" from foobar2000 itself
  if (count <= 2 || STANDARD_ORDER.test(codec || '')) return STANDARD[count] || `${count} ch`;
  return `${count} ch`;
}
export const channelFields = () => lastChannelFields;

const isEq = (name) => /^equali[sz]er$/i.test(name);

/** A channel layout as shown in the DSP steps: "4.0 Quad", "5.1 Multi-channel". */
function layoutName(src) {
  const l = src.layout || chans(src.channels);
  if (l === '4.0') return '4.0 Quad';
  return /^\d\.\d$/.test(l) ? `${l} Multi-channel` : l;
}

/** The glyph for a DSP, by its name. */
function dspIcon(name) {
  const n = name.toLowerCase();
  if (isEq(name)) return 'eq';
  if (/resampl|sample rate/.test(n)) return 'resample';
  if (/limiter/.test(n)) return 'limiter';
  if (/downmix/.test(n)) return 'downmix';
  if (/mono to stereo|stereo to 4|to 4 channels/.test(n)) return 'upmix';
  if (/rear/.test(n)) return 'rear';
  if (/reverse stereo|swap/.test(n)) return 'swap';
  if (/skip/.test(n)) return 'skip';
  return 'dsp';
}

/**
 * What a DSP does to this song, for the ones Fusion knows (foobar2000's own,
 * and foo_skip): whether it acts, a line on it, and whether only the DSP
 * check can tell (`unknown`).
 */
function dspActs(name, src, outRate, chainFile) {
  const n = name.toLowerCase();
  // foobar2000's Equalizer: its curve, from the chain file. Flat does nothing.
  if (isEq(name) && chainFile?.eq) {
    const flat = chainFile.eq.every((g) => g === 0);
    return { acts: !flat, detail: describeEq(chainFile.eq), note: '', unknown: !flat };
  }
  // foo_skip: skips songs by your rules; what plays isn't changed.
  if (/skip track/.test(n)) return { acts: false, detail: 'Skips songs by your rules; doesn’t touch the audio', note: '' };
  if (/downmix.*stereo|stereo.*downmix/.test(n)) {
    const acts = src.channels > 2;
    return { acts, detail: acts ? `${layoutName(src)} → stereo` : `Inactive (source is ${src.channels === 1 ? 'mono' : 'stereo'})`, note: '' };
  }
  if (/downmix.*mono/.test(n)) {
    const acts = src.channels > 1;
    return { acts, detail: acts ? `${layoutName(src)} → mono` : 'Inactive (source is mono)', note: '' };
  }
  if (/mono to stereo/.test(n)) {
    const acts = src.channels === 1;
    return { acts, detail: acts ? 'Mono → stereo (the same in both channels)' : `Inactive (source is ${layoutName(src)})`, note: '' };
  }
  if (/stereo to 4|to 4 channels/.test(n)) {
    const acts = src.channels === 2;
    return { acts, detail: acts ? 'Stereo → 4.0 Quad (front copied to the rear)' : `Inactive (source is ${layoutName(src)})`, note: '' };
  }
  if (/rear/.test(n)) {
    const acts = src.channels === 2;
    return { acts, detail: acts ? 'Stereo moved to the rear speakers' : `Inactive (source is ${layoutName(src)})`, note: '' };
  }
  if (/reverse stereo/.test(n)) {
    const acts = src.channels === 2;
    return { acts, detail: acts ? 'Left and right swapped' : `Inactive (source is ${layoutName(src)})`, note: '' };
  }
  if (/hard.*limiter/.test(n)) return { acts: true, detail: 'Hard limiter (−6 dB)', note: '', unknown: true };
  if (/limiter/.test(n)) return { acts: true, detail: 'Limits peaks to prevent clipping', note: '', unknown: true };
  if (/resampl|sample rate/.test(n)) {
    if (outRate && src.rate) {
      const acts = outRate !== src.rate;
      return { acts, detail: acts ? `${khz(src.rate)} → ${khz(outRate)}` : `Inactive (source is ${khz(src.rate)})`, note: '' };
    }
    return { acts: true, detail: 'Resampling', note: '' };
  }
  // Not one Fusion knows: it may or may not change this song (the DSP check
  // settles it when it can).
  return { acts: true, detail: 'Active', note: '', unknown: true };
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
