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
  // Left out: a cover that's nearly blank, which led the home shelves.
  const SKIP = new Set(['dmt005']);
  for (const a of albums) {
    if (SKIP.has(a.id) || a.album === '[ ]') continue;
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
  // "Night Ferry" by Harbour Lights: made up for the demo, so it can have
  // lyrics (see LYRICS) without borrowing anyone's.
  const ferry = { id: 'harbour-lights', album: 'Night Ferry', artist: 'Harbour Lights', genre: 'Indie Rock; Dream Pop', date: '2024-03-08' };
  const ferryTracks = ['Last Boat Out', 'Turn It Up', 'Salt Air', 'Signal Fires', 'Lighthouse Keeper', 'Low Tide', 'Crossing', 'Morning Ferry'];
  ferryTracks.forEach((title, i) => {
    const path = `E:\\Music\\Harbour Lights\\2024 - Night Ferry\\${String(i + 1).padStart(2, '0')} - ${title}.flac`;
    covers.set(path, new URL('covers/harbour-lights.jpg', DATA).href);
    tracks.push({
      path, handle: path, absolutePath: path, subsong: 0, title, artist: ferry.artist, artistsTag: null, album: ferry.album, albumArtist: ferry.artist,
      genre: ferry.genre, date: ferry.date, trackNumber: i + 1, discNumber: 1, totalDiscs: 1, discSubtitle: '',
      duration: [212, 236, 198, 251, 284, 189, 307, 263][i], codec: 'FLAC', bitrate: 1450 + i * 23, bitsPerSample: 24, sampleRate: 48000, channels: 2,
      fileSize: 40000000, rating: 0, mood: i === 1 ? 'Like it' : '', added: added++, hasArt: true, artSeed: 0,
    });
  });
  // Albums per artist (for their pictures and pages) and per genre.
  const byArtist = new Map();
  for (const a of [...albums.filter((a) => !SKIP.has(a.id) && a.album !== '[ ]'), ferry]) byArtist.set(a.artist.toLowerCase(), [...(byArtist.get(a.artist.toLowerCase()) || []), a]);
  for (const list of byArtist.values()) list.sort((x, y) => x.date.localeCompare(y.date));
  window.__demoArtists = byArtist;
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
    // The cover's bytes (album colours are read from these).
    case 'artwork.getForTrack': {
      const url = (p.type || 'front') === 'front' && covers?.get(p.path);
      return url ? base64Of(url).then((b64) => ({ available: true, type: 'front', mimeType: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${b64}` })) : { available: false, reason: 'not_found' };
    }
    // Artists' folders: their pictures. Albums' folders: none (covers come
    // from foobar2000's artwork, above). Genres: none (a collage instead).
    case 'artwork.getFolderImages': {
      const artist = artistIn(p.directory);
      return artist ? { images: [{ name: 'artist.jpg', path: `${p.directory}\\artist.jpg`, size: 90000 }, { name: 'fanart.jpg', path: `${p.directory}\\fanart.jpg`, size: 250000 }] } : { images: [] };
    }
    case 'file.exists': {
      const known = /\\artist\.nfo$/i.test(p.path) ? !!artistIn(p.path.replace(/\\[^\\]+$/, '')) : /\\genre\.nfo$/i.test(p.path) ? !!GENRES[genreIn(p.path)] : LRC.test(p.path);
      return { exists: known, isFile: known, isDirectory: false };
    }
    case 'file.read': {
      if (LRC.test(p.path)) return { content: LYRICS };
      if (/\\genre\.nfo$/i.test(p.path)) return GENRES[genreIn(p.path)] ? { content: genreNfo(genreIn(p.path)) } : undefined;
      const dir = p.path.replace(/\\[^\\]+$/, '');
      const list = artistIn(dir);
      if (!list) return undefined;
      if (/\\artist\.nfo$/i.test(p.path)) return { content: artistNfo(list) };
      // The artist's picture: their first album's cover; the backdrop: their latest.
      const a = /fanart/i.test(p.path) ? list[list.length - 1] : list[0];
      return base64Of(new URL(`covers/${a.id}.jpg`, DATA)).then((content) => ({ content }));
    }
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

// --- Artist and genre information ------------------------------------------

const ARTISTS_DIR = /^E:\\Music\\_Artists\\([^\\]+)$/i;
const GENRES_DIR = /^E:\\Music\\_Genres\\([^\\]+)\\/i;
const safeName = (n) => n.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '').toLowerCase();

/** An artist's albums, for a folder in the demo's artist folder. */
function artistIn(dir) {
  const m = ARTISTS_DIR.exec(dir || '');
  if (!m) return null;
  const want = m[1].toLowerCase();
  for (const [name, list] of window.__demoArtists || []) if (safeName(name) === want) return list;
  return null;
}

const genreIn = (path) => GENRES_DIR.exec(path)?.[1] || '';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function artistNfo(list) {
  const name = list[0].artist;
  const years = list.map((a) => a.date.slice(0, 4));
  const genres = [...new Set(list.flatMap((a) => a.genre.split('; ')))].slice(0, 3);
  const titles = list.map((a) => `${a.album} (${a.date.slice(0, 4)})`);
  const named = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0];
  const bio =
    name === 'Harbour Lights'
      ? 'Harbour Lights isn\'t a real band. They were made up for this demo, so one album could have lyrics to show. Night Ferry (2024) is the only record, and its cover is a drawing of a harbour at night.'
      : `${name} released ${named} on netlabels, free to download under a Creative Commons licence.\n\nThe covers and track lists in this demo are the ones published with ${list.length > 1 ? 'those albums' : 'that album'} on the Internet Archive. The picture and this text are stand-ins.`;
  return `<?xml version="1.0"?><artist><name>${esc(name)}</name>${genres.map((g) => `<genre>${esc(g)}</genre>`).join('')}<yearsactive>${years[0]}${years.at(-1) !== years[0] ? ` - ${years.at(-1)}` : ''}</yearsactive><biography>${esc(bio)}</biography></artist>`;
}

// Short descriptions of the demo's genres (written for it), with where each
// comes from and what came of it.
const GENRES = {
  Ambient: { since: '1970s', parent: ['Electronic'], sub: ['Dark Ambient', 'Drone'], influence: ['Minimalism', 'Musique concrète'], text: 'Music that sets a mood instead of asking for attention. Ambient pieces tend to be long and slow, built from sustained tones, loops and textures rather than beats or melodies. It took its name from Brian Eno in the late 1970s, though the idea goes back to Erik Satie\'s "furniture music", and it has since spread into film scores, sleep playlists and the quieter end of electronic music.' },
  Electronic: { since: '1950s', parent: [], sub: ['Ambient', 'Techno', 'IDM', 'Trance'], influence: ['Musique concrète', 'Disco'], text: 'Music made mainly with synthesisers, drum machines, samplers and computers. It started in studios and universities in the 1950s, moved onto dance floors with disco and house, and is now as broad as rock or pop: from club tracks to headphone listening to pieces that are barely music at all.' },
  Trance: { since: '1990s', parent: ['Electronic'], sub: ['Psytrance'], influence: ['Techno', 'House'], text: 'Club music built on long builds and releases: a steady four-to-the-floor beat around 130 to 145 BPM, layered synth melodies, and breakdowns that pull everything back before the beat returns. It grew out of German techno in the early 1990s.' },
  Experimental: { since: '1950s', parent: [], sub: ['Noise', 'Drone'], influence: ['Avant-garde', 'Free jazz'], text: 'Music that tries things first and worries about genre later: found sounds, unusual tunings, broken equipment, chance. Much of the netlabel scene lives here.' },
  IDM: { since: '1990s', parent: ['Electronic'], sub: ['Glitch'], influence: ['Techno', 'Ambient'], text: 'Electronic music meant more for listening than dancing, with intricate, often broken-up rhythms and detailed sound design. The name, short for "intelligent dance music", came from a 1990s mailing list and has never quite been liked by the people it describes.' },
  Noise: { since: '1970s', parent: ['Experimental'], sub: [], influence: ['Industrial'], text: 'Music made from what most music avoids: feedback, distortion, static and sheer volume. Noise treats texture as the whole point.' },
  Techno: { since: '1980s', parent: ['Electronic'], sub: ['Minimal'], influence: ['Electro', 'House'], text: 'Repetitive, machine-made dance music that came out of Detroit in the mid 1980s and found a second home in Berlin. Drum machines, sequenced synths and a steady beat, built up and stripped back over long tracks.' },
  'Dark Ambient': { since: '1980s', parent: ['Ambient'], sub: [], influence: ['Industrial'], text: 'Ambient music with the lights off: low drones, distant rumbles and unsettling textures, closer to a horror film than a spa.' },
  Industrial: { since: '1970s', parent: ['Experimental'], sub: [], influence: ['Noise', 'Punk'], text: 'Harsh, mechanical music that began with Throbbing Gristle in the late 1970s: tape loops, metal percussion and distorted voices, later folded into rock and dance music.' },
  'Indie Rock': { since: '1980s', parent: ['Rock'], sub: ['Dream Pop'], influence: ['Punk', 'Post-Punk'], text: 'Rock made outside the major labels, or at least sounding like it. Jangly or noisy guitars, home-made recordings and songs that care more about feel than polish.' },
  'Dream Pop': { since: '1980s', parent: ['Indie Rock'], sub: [], influence: ['Ambient', 'Post-Punk'], text: 'Pop songs drowned in reverb: hazy guitars, soft vocals and slow tempos, aiming for a mood more than a hook.' },
  'Hip-Hop': { since: '1970s', parent: [], sub: [], influence: ['Funk', 'Soul'], text: 'Rhythm and rhyme over beats built from samples and drum machines, born at block parties in the Bronx in the 1970s. On netlabels it is often instrumental: beats made to be listened to.' },
  Downtempo: { since: '1990s', parent: ['Electronic'], sub: ['Trip-Hop'], influence: ['Ambient', 'Hip-Hop'], text: 'Slow, relaxed electronic music for after the club: easy beats, warm samples and plenty of space.' },
  Minimal: { since: '1990s', parent: ['Techno'], sub: [], influence: ['Minimalism'], text: 'Techno pared down to a few sounds that change very slowly, so small shifts in rhythm or texture carry a whole track.' },
  'Lo-Fi': { since: '1980s', parent: [], sub: [], influence: ['Indie Rock'], text: 'Music that keeps the hiss, the room and the mistakes. Recorded cheaply, often at home, and all the warmer for it.' },
  Drone: { since: '1960s', parent: ['Ambient'], sub: [], influence: ['Minimalism'], text: 'Music built on sustained notes that hold for minutes at a time, so the listener hears the small changes inside one sound.' },
};

function genreNfo(name) {
  const g = GENRES[name];
  const tags = (tag, list) => list.map((v) => `<${tag}>${esc(v)}</${tag}>`).join('');
  return `<?xml version="1.0"?><genre><name>${esc(name)}</name><description>${esc(g.text)}</description><since>${g.since}</since>${tags('parent', g.parent)}${tags('subgenre', g.sub)}${tags('influence', g.influence)}</genre>`;
}

// --- Lyrics for "Turn It Up" (written for the demo) ------------------------

const LRC = /Harbour Lights\\2024 - Night Ferry\\02 - Turn It Up\.lrc$/i;
const LYRICS = `[ar:Harbour Lights]
[ti:Turn It Up]
[al:Night Ferry]
[00:14.20]The harbour's lit like a birthday cake
[00:19.60]Every window wide awake
[00:25.00]You said the night was ours to keep
[00:30.40]I said the tide won't let us sleep
[00:36.10]Turn it up, turn it up
[00:40.80]Let the ferry horns join in
[00:45.50]Turn it up, turn it up
[00:50.20]Till the morning lets us in
[00:58.00]Salt on the railings, rain in the air
[01:03.40]Somebody's radio playing somewhere
[01:08.90]The last boat leaves at a quarter to two
[01:14.30]And I'm not leaving without you
[01:20.00]Turn it up, turn it up
[01:24.70]Let the ferry horns join in
[01:29.40]Turn it up, turn it up
[01:34.10]Till the morning lets us in
[01:42.00]Lights on the water, lights in your eyes
[01:47.40]Counting the cranes against the sky
[01:52.80]If this is all the night can give
[01:58.20]It's all I need to live
[02:04.00]Turn it up, turn it up
[02:08.70]Let the ferry horns join in
[02:13.40]Turn it up, turn it up
[02:18.10]Till the morning lets us in
`;

/** The demo's playlists: the Collection and a few of your own. */
export function demoPlaylists(lib, mkPl) {
  const has = (t, ...gs) => gs.some((g) => t.genre.includes(g));
  const every = (n, k = 0) => (_, i) => (i + k) % n === 0;
  return [
    mkPl('Collection', [...lib], true, 'ALL'),
    mkPl('Road trip', lib.filter((t) => has(t, 'Trance', 'Techno', 'Electro', 'Indie Rock')).filter(every(3))),
    mkPl('Morning coffee', lib.filter((t) => has(t, 'Downtempo', 'Lo-Fi', 'Classical', 'Dream Pop'))),
    mkPl('Late night', lib.filter((t) => has(t, 'Ambient', 'Drone')).filter(every(2))),
    mkPl('Focus', lib.filter((t) => has(t, 'IDM', 'Minimal')).filter(every(2, 1))),
    mkPl('Rainy days', lib.filter((t) => has(t, 'Dark Ambient', 'Lo-Fi', 'Dream Pop'))),
    mkPl('Long drives', lib.filter(every(11))),
    mkPl('Vinyl rips', lib.filter(every(29, 3))),
  ];
}

async function base64Of(url) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
