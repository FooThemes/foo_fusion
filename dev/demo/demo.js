// The demo library, for the README screenshots: real Creative Commons albums
// (see docs/screenshots/CREDITS.md) in place of the mock's generated one.
//
//   python dev/demo/build.py        downloads them into dev/demo/data/
//   index.html?demo                 opens Fusion with them (see main.js)
//
// The albums keep their covers, titles and track lists; the rest (formats,
// play counts, the output setup) is made up so every part of the page has
// something to show.

const DATA = new URL('./data/', import.meta.url);

function hash(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');

/** Tracks in the mock's format. */
export async function demoTracks() {
  const albums = await fetch(new URL('library.json', DATA)).then((r) => r.json());
  const tracks = [];
  const covers = new Map(); // handle -> cover URL
  let added = 0;
  // Formats: mostly CD-quality FLAC, some hi-res, a few lossy.
  const FORMATS = [
    { codec: 'FLAC', bits: 16, rate: 44100, kbps: 880, n: 10 },
    { codec: 'FLAC', bits: 24, rate: 96000, kbps: 2650, n: 3 },
    { codec: 'FLAC', bits: 24, rate: 48000, kbps: 1400, n: 2 },
    { codec: 'MP3', bits: 0, rate: 44100, kbps: 320, n: 2 },
    { codec: 'AAC', bits: 0, rate: 44100, kbps: 256, n: 1 },
  ];
  const formatOf = (id) => {
    let k = hash(id) % FORMATS.reduce((n, f) => n + f.n, 0);
    for (const f of FORMATS) if ((k -= f.n) < 0) return f;
    return FORMATS[0];
  };
  for (const a of albums) {
    const fmt = formatOf(a.id);
    const ext = fmt.codec === 'FLAC' ? 'flac' : fmt.codec === 'MP3' ? 'mp3' : 'm4a';
    const dir = `E:\\Music\\${safe(a.artist)}\\${a.date.slice(0, 4)} - ${safe(a.album)}`;
    const cover = new URL(`covers/${a.id}.jpg`, DATA).href;
    for (const t of a.tracks) {
      const path = `${dir}\\${String(t.track).padStart(2, '0')} - ${safe(t.title)}.${ext}`;
      covers.set(path, cover);
      const h = hash(path);
      tracks.push({
        path,
        handle: path,
        absolutePath: path,
        subsong: 0,
        title: t.title,
        artist: t.artist,
        artistsTag: null,
        album: a.album,
        albumArtist: a.artist,
        genre: a.genre,
        date: a.date.length >= 10 ? a.date : a.date.slice(0, 4),
        trackNumber: t.track,
        discNumber: 1,
        totalDiscs: 1,
        discSubtitle: '',
        duration: t.length || 180 + (h % 200),
        codec: fmt.codec,
        bitrate: fmt.kbps + (fmt.codec === 'FLAC' ? (h % 300) - 150 : 0),
        bitsPerSample: fmt.bits,
        sampleRate: fmt.rate,
        channels: 2,
        fileSize: (t.length || 200) * fmt.kbps * 125,
        rating: 0,
        mood: h % 11 === 0 ? 'Like it' : '',
        added: added++,
        hasArt: true,
        artSeed: 0,
      });
    }
  }
  window.__demoCovers = covers;
  window.__demoLib = tracks;
  return tracks;
}

// What the signal path reads for the playing song (made up: an ASIO DAC,
// ReplayGain on, two DSPs that only act on some files).
const OUTPUT = {
  output_samplerate: '96000',
  output_bitdepth: '32',
  output_channels: '2',
  output_device: 'ASIO : Topping USB Audio Device',
  output_dsps: 'Skip Track, Downmix channels to stereo',
  output_dsp_preset: 'Default',
  output_volume: '0.00',
  output_rg_mode: 'album',
  output_rg_source: 'album',
  output_rg_gain: '-6.81',
  output_buffer_length: '1000',
};

function evalPlaying(pattern, t) {
  const fields = {
    codec: t.codec,
    codec_profile: '',
    __bitspersample: t.bitsPerSample ? String(t.bitsPerSample) : '',
    samplerate: String(t.sampleRate),
    __channels: '2',
    __encoding: t.codec === 'FLAC' ? 'lossless' : 'lossy',
    bitrate: String(t.bitrate),
    replaygain_track_gain: '-7.12 dB',
    replaygain_album_gain: '-6.81 dB',
    ...OUTPUT,
  };
  // Formats differ: the output follows the source's rate.
  fields.output_samplerate = String(t.sampleRate);
  return pattern.replace(/\[%([^%\]]+)%\]|%([^%]+)%/g, (_, a, b) => fields[a || b] ?? '');
}

/** Answers the mock passes to the page first (see mock-bridge.js). */
export function demoOverride(method, p) {
  const covers = window.__demoCovers;
  switch (method) {
    case 'artwork.getFb2kUrlByPathBatch':
      return {
        artworks: (p.items || p.paths.map((path) => ({ path }))).map((it) => {
          const type = it.type || p.type || 'front';
          const url = type === 'front' ? covers?.get(it.path) : null;
          return { path: it.path, available: !!url, type, dataUrl: url || undefined };
        }),
      };
    case 'artwork.getFb2kUrl':
      return window.fb2k.invoke('playback.getCurrentTrack').then((r) => {
        const url = r?.track && covers?.get(r.track.handle);
        return url ? { available: true, type: p.type || 'front', dataUrl: url } : { available: false, reason: r?.track ? 'not_found' : 'no_track' };
      });
    // No folder pictures: covers come from foobar2000's artwork (above).
    case 'artwork.getFolderImages':
      return { images: [] };
    case 'config.getOutputConfig':
      return { outputName: 'ASIO', deviceName: 'Topping USB Audio Device', bitDepth: 32, useDither: false };
    case 'dsp.getChain':
      return { dsps: [{ name: 'Skip Track' }, { name: 'Downmix channels to stereo' }] };
    case 'replaygain.getMode':
      return { sourceMode: 'album', processingMode: 'apply gain and prevent clipping according to peak' };
    case 'replaygain.getPreamp':
      return { withRg: 0, withoutRg: 0 };
    case 'audio.getOutputInfo':
      return { volume: 0 };
    case 'titleformat.eval':
      if (!p.path && /%output_samplerate%/.test(p.pattern || '')) {
        return window.fb2k.invoke('playback.getCurrentTrack').then((r) => (r?.track ? { result: evalPlaying(p.pattern, window.__demoLib.find((x) => x.handle === r.track.handle) || {}) } : undefined));
      }
      return undefined;
  }
  return undefined;
}

/**
 * Patterns the mock doesn't evaluate: the Quality column (a title formatting
 * column of the kind you'd add yourself) and its sort.
 */
export function demoTf(pattern, t) {
  if (!/%__encoding%|%__bitspersample%/.test(pattern)) return null;
  const lossless = t.codec === 'FLAC';
  const khz = (r) => String(Math.floor(r / 1000)) + (Math.floor(r / 100) % 10 ? '.' + (Math.floor(r / 100) % 10) : '');
  // The sort: DSD, lossless, lossy; the best of each first.
  if (/^\$ifequal\(%__bitspersample%,1,1,/.test(pattern)) {
    const head = lossless ? `2|${String(99 - t.bitsPerSample).padStart(2, '0')}|${String(99999999 - t.sampleRate).padStart(8, '0')}` : `3|${String(99999 - t.bitrate).padStart(5, '0')}`;
    return `${head}|${t.albumArtist}|${t.album}|${String(t.trackNumber).padStart(3, '0')}`;
  }
  return lossless ? `${t.bitsPerSample}/${khz(t.sampleRate)}` : `${t.bitrate}kbps`;
}
