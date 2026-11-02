// Development stand-in for foo_ui_webview2's window.fb2k bridge.
//
// Lets the theme run in an ordinary browser (open index.html through any
// static server) with a generated music library, so layout and behaviour can
// be worked on without foobar2000. Like the real host, it rejects parameters a
// method does not declare (list generated from the component's docs into
// api-params.json by tools/extract-api.py).

import { TF } from '../js/data/patterns.js';

const GENRES = ['Rock', 'Electronic', 'Jazz', 'Hip-Hop', 'Classical', 'Folk', 'Pop', 'Ambient', 'Metal', 'Soul'];
const WORDS = 'Midnight Echo Paper Glass River Neon Velvet Static Golden Hollow Silver Northern Quiet Broken Electric Distant Summer Winter Ocean Desert Signal Ghost Satellite Crimson Lantern Harbor Atlas Coral Ember Meadow'.split(' ');
const NOUNS = 'Hearts Lines Machines Gardens Roads Skies Waves Cities Dreams Lights Rooms Mirrors Fields Wires Tides Stories Songs Shadows Engines Islands'.split(' ');

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function buildLibrary() {
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const artists = Array.from({ length: 46 }, (_, i) => (i % 3 === 0 ? `The ${pick(WORDS)} ${pick(NOUNS)}` : `${pick(WORDS)} ${pick(NOUNS)}`));
  const tracks = [];
  let added = 0;
  artists.forEach((artist, ai) => {
    const genre = GENRES[ai % GENRES.length];
    const albums = 1 + Math.floor(r() * 5);
    for (let a = 0; a < albums; a++) {
      const album = `${pick(WORDS)} ${pick(NOUNS)}`;
      const year = String(1968 + Math.floor(r() * 56));
      const discs = ai === 2 && a === 0 ? 10 : r() < 0.08 ? 2 : 1;
      const hasArt = r() > 0.12;
      for (let d = 1; d <= discs; d++) {
        const n = 6 + Math.floor(r() * 9);
        for (let t = 1; t <= n; t++) {
          const path = `C:\\Music\\${artist}\\${album}\\${d > 1 ? `CD${d}\\` : ''}${String(t).padStart(2, '0')} ${pick(WORDS)} ${pick(NOUNS)}.flac`;
          tracks.push({
            path,
            handle: path,
            absolutePath: path,
            subsong: 0,
            title: `${pick(WORDS)} ${pick(NOUNS)}`,
            artist: r() < 0.06 ? pick(artists) : artist,
            album,
            albumArtist: artist,
            genre,
            date: year,
            trackNumber: t,
            discNumber: d,
            totalDiscs: discs,
            discSubtitle: d === 2 ? 'Acoustic' : discs > 2 && d % 3 === 0 ? `Live ${d}` : '',
            duration: 120 + Math.floor(r() * 300),
            codec: 'FLAC',
            bitrate: 700 + Math.floor(r() * 400),
            sampleRate: 44100,
            channels: 2,
            fileSize: 20000000 + Math.floor(r() * 30000000),
            rating: 0,
            mood: r() < 0.1 ? 'Like it' : '',
            added: added++,
            hasArt,
            artSeed: discs > 1 ? d : 0,
          });
        }
      }
    }
  });
  return tracks;
}

// Emulate exactly the title formatting patterns Fusion uses.
function tfEval(pattern, t) {
  const aa = t.albumArtist || 'Unknown Artist';
  const al = t.album || 'Single(s)';
  const map = {
    [TF.albumKey]: () => `${aa}|${al}`,
    [TF.albumDiscKey]: () => `${aa}|${al}|${t.discNumber}`,
    [TF.discSubtitle]: () => t.discSubtitle || '',
    [TF.artistKey]: () => aa,
    [TF.genreKey]: () => t.genre || 'Unknown Genre',
    [TF.albumTitle]: () => al,
    [TF.albumDiscTitle]: () => (t.totalDiscs > 1 ? `${al} (Disc ${t.discNumber})` : al),
    [TF.albumArtist]: () => aa,
    [TF.year]: () => t.date.slice(0, 4),
    [TF.genre]: () => t.genre || 'Unknown Genre',
    [TF.trackNumber]: () => String(t.trackNumber).padStart(2, '0'),
  };
  if (map[pattern]) return map[pattern]();
  // Sort patterns: approximate with the leading field.
  const lead = pattern.split('|')[0];
  if (lead.includes('%album artist%')) return `${aa}|${t.date}|${al}|${String(t.discNumber).padStart(3, '0')}|${String(t.trackNumber).padStart(3, '0')}`;
  if (lead.includes('%date%')) return `${t.date}|${aa}|${al}|${String(t.discNumber).padStart(3, '0')}|${String(t.trackNumber).padStart(3, '0')}`;
  if (lead.includes('%genre%')) return `${t.genre}|${aa}|${t.date}|${al}|${String(t.discNumber).padStart(3, '0')}|${String(t.trackNumber).padStart(3, '0')}`;
  if (lead.includes('%added%')) return String(t.added).padStart(8, '0');
  if (lead.includes('%title%')) return t.title;
  if (lead.includes('%length')) return String(t.duration).padStart(6, '0');
  if (lead.includes('%path%')) return t.path;
  return `${al}|${aa}|${t.date}|${String(t.discNumber).padStart(3, '0')}|${String(t.trackNumber).padStart(3, '0')}`;
}

function coverSvg(seed, label) {
  const r = rng(seed);
  const h1 = Math.floor(r() * 360);
  const h2 = (h1 + 40 + Math.floor(r() * 120)) % 360;
  const shape = Math.floor(r() * 3);
  const deco = [
    `<circle cx="${30 + r() * 40}" cy="${30 + r() * 40}" r="${18 + r() * 20}" fill="hsl(${h2} 70% 70% / .55)"/>`,
    `<rect x="${r() * 50}" y="${r() * 50}" width="50" height="50" transform="rotate(${r() * 90} 50 50)" fill="hsl(${h2} 70% 65% / .5)"/>`,
    `<path d="M0 ${60 + r() * 30} Q50 ${r() * 60} 100 ${50 + r() * 40} V100 H0Z" fill="hsl(${h2} 60% 60% / .6)"/>`,
  ][shape];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="hsl(${h1} 45% 35%)"/>${deco}<text x="8" y="92" font-family="Segoe UI,sans-serif" font-size="9" fill="white" opacity=".85">${label.replace(/[<&]/g, '')}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export async function installMock() {
  const params = await fetch(new URL('./api-params.json', import.meta.url)).then((r) => r.json());
  const lib = buildLibrary();
  const listeners = new Map();
  const emit = (event, data) => setTimeout(() => (listeners.get(event) || []).forEach((fn) => fn(data)), 0);
  let config = {};
  try {
    config = JSON.parse(localStorage.getItem('fusion-mock-config') || '{}');
  } catch {}

  const mkPl = (name, items, auto = false, query = '') => ({ guid: `{${crypto.randomUUID()}}`, name, items, auto, query, selection: new Set(), focus: -1, locked: auto });
  const pls = [mkPl('Collection', [...lib], true, 'ALL'), mkPl('Road trip', lib.filter((_, i) => i % 17 === 0)), mkPl('Late night', lib.filter((t) => t.genre === 'Jazz' || t.genre === 'Ambient')), mkPl('Empty playlist', [])];
  let active = 0;
  const pb = { state: 'stopped', pl: -1, idx: -1, pos: 0, vol: 72, muted: false, order: 0, sac: false };
  const queue = [];
  const ORDERS = ['default', 'repeat-playlist', 'repeat-track', 'random', 'shuffle-tracks', 'shuffle-albums', 'shuffle-folders'];

  const info = (p, i) => ({ index: i, guid: p.guid, name: p.name, trackCount: p.items.length, isActive: i === active, isPlaying: i === pb.pl, isLocked: p.locked, isAutoplaylist: p.auto });
  const row = (t, i, fields, formats) => {
    let out;
    if (fields) {
      out = { index: i };
      for (const f of fields) out[f] = t[f];
    } else {
      out = { ...t, index: i, playCount: 3, lastPlayed: '2026-10-30 21:14:00', added: '2025-02-11 10:00:00' };
      delete out.hasArt;
      delete out.artSeed;
      delete out.discSubtitle;
      delete out.mood;
    }
    if (formats) out.formats = Object.fromEntries(Object.entries(formats).map(([k, p]) => [k, tfEval(p, t)]));
    return out;
  };
  const getPl = (p) => {
    const i = p.playlist ?? (p.playlistGuid ? pls.findIndex((x) => x.guid === p.playlistGuid) : active);
    if (!pls[i]) throw err('INVALID_INDEX', 'Invalid playlist index');
    return [pls[i], i];
  };
  const err = (code, error) => Object.assign(new Error(error), { mockCode: code });
  const cur = () => (pb.pl >= 0 ? pls[pb.pl]?.items[pb.idx] : null);
  const playAt = (pi, idx) => {
    pb.pl = pi;
    pb.idx = idx;
    pb.pos = 0;
    pb.state = 'playing';
    emit('playback:trackChanged', { ...cur(), position: 0 });
    emit('playback:stateChanged', { state: 'playing', position: 0, duration: cur().duration, canSeek: true });
  };
  setInterval(() => {
    if (pb.state !== 'playing') return;
    pb.pos += 1;
    if (pb.pos >= cur().duration) return api['playback.next']();
    emit('playback:time', { position: pb.pos });
  }, 1000);

  const api = {
    'config.get': (p) => ({ key: p.key, value: config[p.key] ?? p.default ?? null, found: p.key in config }),
    'config.set': (p) => {
      config[p.key] = p.value;
      localStorage.setItem('fusion-mock-config', JSON.stringify(config));
      return { key: p.key };
    },
    'config.showLibraryPreferences': () => ({}),
    'playlist.getAll': () => ({ playlists: pls.map(info), count: pls.length }),
    'playlist.setActive': (p) => {
      const old = active;
      [, active] = getPl(p);
      emit('playlist:activated', { oldIndex: old, newIndex: active, newGuid: pls[active].guid });
      return {};
    },
    'playlist.create': (p) => {
      pls.push(mkPl(p.name || 'New playlist', []));
      emit('playlist:created', { index: pls.length - 1, guid: pls.at(-1).guid, name: pls.at(-1).name });
      return { index: pls.length - 1, guid: pls.at(-1).guid };
    },
    'playlist.createAutoplaylist': (p) => {
      const items = p.query.includes('Like it') ? lib.filter((t) => t.mood === 'Like it') : [...lib];
      pls.push(mkPl(p.name, items, true, p.query));
      emit('playlist:created', { index: pls.length - 1 });
      return { index: pls.length - 1, playlist: pls.length - 1, guid: pls.at(-1).guid, name: p.name, query: p.query };
    },
    'playlist.reorderPlaylists': (p) => {
      const actGuid = pls[active].guid;
      const re = p.newOrder.map((i) => pls[i]);
      pls.splice(0, pls.length, ...re);
      active = pls.findIndex((x) => x.guid === actGuid);
      emit('playlist:reordered', {});
      return { count: pls.length };
    },
    'playlist.rename': (p) => {
      getPl(p)[0].name = p.name;
      emit('playlist:renamed', {});
      return {};
    },
    'playlist.remove': (p) => {
      const [, i] = getPl(p);
      pls.splice(i, 1);
      if (active >= pls.length) active = pls.length - 1;
      emit('playlist:removed', {});
      emit('playlist:activated', { newIndex: active });
      return {};
    },
    'playlist.duplicate': (p) => {
      const [pl] = getPl(p);
      pls.push(mkPl(p.name || pl.name + ' (copy)', [...pl.items]));
      emit('playlist:created', {});
      return { index: pls.length - 1 };
    },
    'playlist.showAutoplaylistUI': () => ({}),
    'playlist.removeAutoplaylist': (p) => {
      const [pl, i] = getPl(p);
      pl.auto = pl.locked = false;
      return { playlist: i, source: 'sdk' };
    },
    'playlist.convertToAutoplaylist': (p) => {
      const [pl, i] = getPl(p);
      if (pl.auto) throw err('OPERATION_FAILED', 'already an autoplaylist');
      pl.items = p.query.includes('Like it') ? lib.filter((t) => t.mood === 'Like it') : [...lib];
      if (p.sort) {
        const keyed = pl.items.map((t) => [tfEval(p.sort, t).toLowerCase(), t]);
        keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        pl.items = keyed.map((k) => k[1]);
      }
      pl.auto = pl.locked = true;
      emit('playlist:itemsReplaced', { playlist: i });
      return { playlist: i };
    },
    'playlist.sort': (p) => {
      const [pl, i] = getPl(p);
      if (pl.locked) throw err('LOCKED', 'Playlist is locked');
      const keyed = pl.items.map((t) => [tfEval(p.pattern, t).toLowerCase(), t]);
      keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      pl.items = keyed.map((k) => k[1]);
      if (p.descending) pl.items.reverse();
      emit('playlist:itemsReordered', { playlist: i });
      return {};
    },
    'playlist.getMatchingRows': (p) => {
      const [pl, i] = getPl(p);
      const words = [...p.query.matchAll(/HAS "([^"]+)"/g)].map((m) => m[1].toLowerCase());
      const uniq = [...new Set(words)];
      const items = [];
      pl.items.forEach((t, n) => {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.albumArtist} ${t.genre}`.toLowerCase();
        if (uniq.every((w) => hay.includes(w))) items.push(n);
      });
      return { playlist: i, total: pl.items.length, items, count: items.length };
    },
    'playlist.getGroupRuns': (p) => {
      const [pl, i] = getPl(p);
      const runsFor = (pattern, start, end) => {
        const runs = [];
        for (let n = start; n < end; n++) {
          const k = tfEval(pattern, pl.items[n]);
          const last = runs.at(-1);
          if (last && last.key.toLowerCase() === k.toLowerCase()) last.count++;
          else runs.push({ start: n, count: 1, key: k });
        }
        return runs;
      };
      const runs = runsFor(p.patterns[0], 0, pl.items.length);
      if (p.patterns[1]) runs.forEach((r) => (r.sub = runsFor(p.patterns[1], r.start, r.start + r.count)));
      return { playlist: i, playlistGuid: pl.guid, total: pl.items.length, runs };
    },
    'playlist.getTracksAt': (p) => {
      const [pl, i] = getPl(p);
      const tracks = p.rows.filter((r) => pl.items[r]).map((r) => row(pl.items[r], r, p.fields, p.formats));
      return { playlist: i, tracks, count: tracks.length };
    },
    'playlist.getTracks': (p) => {
      const [pl, i] = getPl(p);
      const start = p.start || 0;
      const count = p.count ?? 100;
      const tracks = pl.items.slice(start, start + count).map((t, n) => row(t, start + n, p.fields, p.formats));
      return { playlist: i, start, count: tracks.length, total: pl.items.length, tracks };
    },
    'playlist.getSelection': (p) => {
      const [pl, i] = getPl(p);
      const items = [...pl.selection].sort((a, b) => a - b);
      return { items, count: items.length, playlist: i };
    },
    'playlist.setSelection': (p) => {
      const [pl, i] = getPl(p);
      if (p.clearOthers !== false) pl.selection.clear();
      p.indices.forEach((n) => pl.selection.add(n));
      return {};
    },
    'playlist.setFocusedTrack': (p) => {
      getPl(p)[0].focus = p.index;
      return {};
    },
    'playlist.playTrack': (p) => {
      const [, i] = getPl(p);
      playAt(i, p.index || 0);
      return {};
    },
    'playlist.removeTracks': (p) => {
      const [pl, i] = getPl(p);
      const drop = new Set(p.items);
      pl.items = pl.items.filter((_, n) => !drop.has(n));
      pl.selection.clear();
      emit('playlist:itemsRemoved', { playlist: i, newCount: pl.items.length });
      return {};
    },
    'playlist.addHandles': (p) => {
      const [pl, i] = getPl(p);
      const byPath = new Map(lib.map((t) => [t.handle, t]));
      const add = p.handles.map((h) => byPath.get(h)).filter(Boolean);
      pl.items.push(...add);
      emit('playlist:itemsAdded', { playlist: i, count: add.length });
      return { playlist: i, addedCount: add.length };
    },
    'queue.add': (p) => {
      const [pl, i] = getPl(p);
      (p.tracks || [p.track]).forEach((r) => queue.push({ ...pl.items[r], playlist: i, playlistItem: r }));
      emit('playback:queueChanged', { count: queue.length });
      return { addedCount: p.tracks?.length || 1, queueCount: queue.length };
    },
    'queue.get': () => ({ items: queue.map((t, n) => ({ ...t, queueIndex: n })), count: queue.length }),
    'queue.getCount': () => ({ count: queue.length, hasItems: queue.length > 0 }),
    'queue.clear': () => {
      queue.length = 0;
      emit('playback:queueChanged', { count: 0 });
      return {};
    },
    'queue.remove': (p) => {
      (p.indices || [p.index]).sort((a, b) => b - a).forEach((n) => queue.splice(n, 1));
      emit('playback:queueChanged', { count: queue.length });
      return { queueCount: queue.length };
    },
    'playback.getState': () => ({ state: pb.state, canSeek: pb.state !== 'stopped', canPause: true }),
    'playback.getCurrentTrack': () => (cur() ? { found: true, track: cur() } : { found: false }),
    'playback.getCurrentTrackIndex': () => (cur() ? { found: true, playlist: pb.pl, index: pb.idx } : { found: false, playlist: null, index: null }),
    'playback.getPosition': () => ({ position: pb.pos, duration: cur()?.duration || 0 }),
    'playback.getVolume': () => ({ volume: pb.muted ? 0 : pb.vol, muted: pb.muted }),
    'playback.getPlaybackOrder': () => ({ order: pb.order, orderName: ORDERS[pb.order] }),
    'playback.getStopAfterCurrent': () => ({ enabled: pb.sac }),
    'playback.toggleStopAfterCurrent': () => ((pb.sac = !pb.sac), emit('playback:stopAfterCurrentChanged', { enabled: pb.sac }), {}),
    'playback.playOrPause': () => {
      if (pb.state === 'stopped') playAt(active, Math.max(0, pls[active].focus));
      else {
        pb.state = pb.state === 'playing' ? 'paused' : 'playing';
        emit('playback:stateChanged', { state: pb.state, position: pb.pos, duration: cur().duration, canSeek: true });
      }
      return {};
    },
    'playback.next': () => {
      if (queue.length) {
        const q = queue.shift();
        emit('playback:queueChanged', { count: queue.length });
        playAt(q.playlist, q.playlistItem);
      } else if (cur()) playAt(pb.pl, (pb.idx + 1) % pls[pb.pl].items.length);
      return {};
    },
    'playback.previous': () => (cur() && playAt(pb.pl, Math.max(0, pb.idx - 1)), {}),
    'playback.stop': () => {
      pb.state = 'stopped';
      emit('playback:stopped', { reason: 'user' });
      return {};
    },
    'playback.setPosition': (p) => {
      pb.pos = p.position;
      emit('playback:seeked', { position: p.position });
      return {};
    },
    'playback.setVolume': (p) => {
      pb.vol = p.volume;
      pb.muted = false;
      emit('playback:volumeChanged', { volume: pb.vol, muted: false });
      return {};
    },
    'playback.toggleMute': () => {
      pb.muted = !pb.muted;
      emit('playback:volumeChanged', { volume: pb.muted ? 0 : pb.vol, muted: pb.muted });
      return {};
    },
    'playback.setPlaybackOrder': (p) => {
      pb.order = p.name ? ORDERS.indexOf(p.name) : p.order;
      emit('playback:orderChanged', { orderIndex: pb.order, order: pb.order });
      return { order: pb.order, orderName: ORDERS[pb.order] };
    },
    'playback.playPath': () => ({}),
    'artwork.getFb2kUrlByPathBatch': (p) => {
      const byPath = new Map(lib.map((t) => [t.handle, t]));
      return {
        artworks: (p.items || p.paths.map((path) => ({ path }))).map((it) => {
          const t = byPath.get(it.path);
          const type = it.type || p.type || 'front';
          const ok = t && t.hasArt && type === 'front';
          return { path: it.path, available: !!ok, type, dataUrl: ok ? coverSvg(hashStr(t.albumArtist + t.album) + t.artSeed * 7, t.artSeed ? `${t.album} CD${t.discNumber}` : t.album) : undefined };
        }),
      };
    },
    'artwork.getFb2kUrl': () => {
      const t = cur();
      if (!t) return { available: false, reason: 'no_track' };
      return t.hasArt ? { available: true, type: 'front', dataUrl: coverSvg(hashStr(t.albumArtist + t.album), t.album) } : { available: false, reason: 'not_found' };
    },
    'ui.showCustomMenu': (p) => showMockMenu(p.items),
    'menu.showNativePopup': () => (console.info('[mock] native context menu'), {}),
    'menu.getMainMenu': () => ({
      items: ['File', 'Edit', 'View', 'Playback', 'Library', 'Help'].map((l) => ({ type: 'submenu', label: l, path: l, children: [{ type: 'command', label: `${l} command`, path: `${l}/${l} command`, enabled: true }] })),
    }),
    'menu.runMainMenuCommand': (p) => (console.info('[mock] main menu:', p.command), {}),
    'menu.getContextMenu': () => ({ mode: 'selection', items: [{ type: 'command', label: 'Open containing folder', commandId: 1 }], targetKey: 'x' }),
    'menu.runContextCommandById': () => ({}),
  };
  const noop = ['window.setTitle', 'window.setDarkMode', 'window.setFrameless', 'window.reload', 'window.toggleFullscreen', 'window.toggleAlwaysOnTop'];
  noop.forEach((m) => (api[m] = () => ({})));

  window.fb2k = {
    mock: true,
    async invoke(method, p = {}) {
      await new Promise((r) => setTimeout(r, 2 + Math.random() * 6));
      if (!params[method]) throw Object.assign(new Error(`Method not found: ${method}`), { code: 'METHOD_NOT_FOUND' });
      const unknown = Object.keys(p).filter((k) => !params[method].includes(k));
      if (unknown.length) {
        console.error(`[mock] ${method}: undeclared params`, unknown);
        return { success: false, code: 'INVALID_PARAMS', error: `Unknown parameter(s): ${unknown.join(', ')}` };
      }
      if (!api[method]) {
        console.warn(`[mock] ${method} not emulated`);
        return { success: true };
      }
      try {
        return { success: true, ...(await api[method](p)) };
      } catch (e) {
        return { success: false, code: e.mockCode || 'OPERATION_FAILED', error: e.message };
      }
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
  };
  console.info(`[mock] foo_ui_webview2 mock with ${lib.length} tracks`);
}

function hashStr(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// A plain DOM menu standing in for the native popup menu.
function showMockMenu(items) {
  return new Promise((resolve) => {
    document.querySelector('.mock-menu')?.remove();
    const root = document.createElement('div');
    root.className = 'mock-menu';
    Object.assign(root.style, { position: 'fixed', zIndex: 999, background: '#2b2b2b', color: '#eee', font: '13px Segoe UI, sans-serif', padding: '4px 0', minWidth: '200px', boxShadow: '0 6px 20px rgba(0,0,0,.4)' });
    const add = (list, parent) =>
      list.forEach((it) => {
        if (it.type === 'separator') return parent.append(Object.assign(document.createElement('hr'), { style: 'border:0;border-top:1px solid #444;margin:4px 0' }));
        const b = document.createElement('div');
        b.textContent = (it.checked ? '✓ ' : '   ') + it.label + (it.submenu ? '  ›' : '');
        Object.assign(b.style, { padding: '5px 16px', opacity: it.enabled === false ? 0.4 : 1, whiteSpace: 'pre' });
        b.onmouseenter = () => (b.style.background = '#444');
        b.onmouseleave = () => (b.style.background = '');
        b.onclick = (e) => {
          e.stopPropagation();
          if (it.submenu) {
            const sub = document.createElement('div');
            sub.style.paddingLeft = '12px';
            add(it.submenu, sub);
            b.after(sub);
            return;
          }
          if (it.enabled === false) return;
          root.remove();
          resolve({ selectedId: it.id });
        };
        parent.append(b);
      });
    add(items, root);
    const x = window.__mockMouse?.x ?? 200;
    const y = window.__mockMouse?.y ?? 200;
    root.style.left = Math.min(x, innerWidth - 220) + 'px';
    root.style.top = Math.min(y, innerHeight - 30 * items.length - 20) + 'px';
    document.body.append(root);
    setTimeout(() =>
      document.addEventListener(
        'mousedown',
        (e) => {
          if (!root.contains(e.target)) {
            root.remove();
            resolve({ selectedId: null });
          }
        },
        { once: true },
      ),
    );
  });
}
document.addEventListener('mousemove', (e) => (window.__mockMouse = { x: e.clientX, y: e.clientY }), { passive: true });
