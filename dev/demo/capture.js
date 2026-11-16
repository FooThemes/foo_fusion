// Takes the README screenshots from the demo library (see demo.js).
//
//   python dev/demo/build.py
//   python -m http.server 8765          (in the repo folder)
//   node dev/demo/capture.js [name …]   (needs Playwright)
//
// Writes docs/screenshots/<name>.jpg, 1600x1000, dark theme unless a shot
// says otherwise. With names, only those; without, all of them.

const fs = require('fs');
const path = require('path');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright'));
}

const URL = process.env.FUSION_URL || 'http://127.0.0.1:8765/index.html?demo';
const OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots');
const W = 1600;
const H = 1000;
const QUALITY = '$if($stricmp(%__encoding%,lossless),$ifequal(%__bitspersample%,1,DSD$div(%samplerate%,44100),%__bitspersample%/$div(%samplerate%,1000)$ifequal($mod($div(%samplerate%,100),10),0,,.$mod($div(%samplerate%,100),10))),%bitrate%kbps)';

const wait = (p, ms) => p.waitForTimeout(ms);
const store = (p, values) =>
  p.evaluate(async (values) => {
    const s = await import('/js/core/store.js');
    for (const [k, v] of Object.entries(values)) s.set(k, v);
  }, values);
const tab = (p, name) => p.evaluate((name) => [...document.querySelectorAll('.head-tools button')].find((n) => n.textContent.trim() === name)?.click(), name);
const nav = (p, name) => p.click(`.nav-item >> text=${name}`);
const goTo = (p, kind, key) => p.evaluate(async ([kind, key]) => (await import('/js/data/view.js')).view.goTo(kind, key), [kind, key]);

/** Plays a song, found by album (and track number), from its Collection row. */
async function playSong(p, album, track = 1, at = 0) {
  await p.evaluate(
    async ([album, track, at]) => {
      const t = window.__demoLib.find((x) => x.album === album && x.trackNumber === track);
      const res = await window.fb2k.invoke('playlist.getMatchingRows', { playlist: 0, query: `%path% IS "${t.handle}"` });
      await window.fb2k.invoke('playlist.playTrack', { playlist: 0, index: res.items[0] });
      if (at) setTimeout(() => window.fb2k.invoke('playback.setPosition', { position: at }), 400);
    },
    [album, track, at],
  );
  await wait(p, 1500);
}

/** A page as the screenshots have it: settings, playlists in a folder, a song playing. */
async function open(b, { dark = true, accent = '#107C10', settings = {}, size = { width: W, height: H }, scale = 1, song = ['Night Ferry', 2, 74] } = {}) {
  const ctx = await b.newContext({ viewport: size, deviceScaleFactor: scale });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error('page error:', e.message));
  await p.goto(URL);
  await wait(p, 1500);
  await store(p, {
    dark,
    accent,
    waveformSeekbar: true,
    artistInfoFolder: 'E:\\Music\\_Artists',
    genreInfoFolder: 'E:\\Music\\_Genres',
    infoPanel: false,
    listBackground: 'blur',
    customColumns: [],
    songColumns: null,
    ...settings,
  });
  await wait(p, 1200); // saved a moment after the last change
  await p.reload();
  await wait(p, 4000);
  // A folder of playlists, and some icons (GUIDs are new on every load).
  await p.evaluate(async () => {
    const s = await import('/js/core/store.js');
    const { playlists } = await import('/js/data/playlists.js');
    await playlists.refresh();
    const g = (n) => playlists.byName(n)?.guid;
    s.set('folders', [{ id: 'moods', name: 'Moods', collapsed: false, parent: null, items: ['Late night', 'Focus', 'Rainy days'].map(g) }]);
    s.set('playlistIcons', Object.fromEntries([['Road trip', 'plCar'], ['Morning coffee', 'plCoffee'], ['Late night', 'plMoon'], ['Focus', 'plBolt'], ['Rainy days', 'plRain'], ['Long drives', 'plGlobe'], ['Vinyl rips', 'plVinyl']].map(([n, i]) => [g(n), i])));
  });
  if (song) await playSong(p, ...song);
  return p;
}

/** Albums open on one album, with the row of tiles above it in view. */
async function openAlbum(p, key) {
  await goTo(p, 'albums', key);
  await wait(p, 2200);
  await p.evaluate(() => (document.querySelector('.content').scrollTop -= 250));
  await wait(p, 900);
}

async function shoot(p, name) {
  await p.mouse.move(W - 6, H / 2);
  await wait(p, 500);
  const file = path.join(OUT, `${name}.jpg`);
  await p.screenshot({ path: file, type: 'jpeg', quality: 86 });
  console.log('wrote', name);
  return file;
}

/** Lays images out on a page and screenshots it (for the combined shots). */
async function compose(b, name, html, size = { width: W, height: H }) {
  const ctx = await b.newContext({ viewport: size });
  const p = await ctx.newPage();
  await p.setContent(`<!doctype html><html><body style="margin:0;background:#111;font:600 15px 'Segoe UI',sans-serif">${html}</body></html>`);
  await wait(p, 600);
  await p.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 });
  await ctx.close();
  console.log('wrote', name);
}

const img = (file) => `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;

const SHOTS = {
  albums: async (b) => {
    const p = await open(b);
    await shoot(p, 'albums');
  },
  'album-open': async (b) => {
    const p = await open(b);
    await openAlbum(p, 'Abraham Lincoln|Declaration of Independence LP');
    await shoot(p, 'album-open');
  },
  artists: async (b) => {
    const p = await open(b);
    await tab(p, 'Artists');
    await wait(p, 3000);
    await shoot(p, 'artists');
  },
  'artist-page': async (b) => {
    const p = await open(b);
    await goTo(p, 'artists', 'B.L.Underwood');
    await wait(p, 3500);
    await shoot(p, 'artist-page');
  },
  genres: async (b) => {
    const p = await open(b);
    await tab(p, 'Genres');
    await wait(p, 3500);
    await shoot(p, 'genres');
  },
  'genre-page': async (b) => {
    const p = await open(b);
    await goTo(p, 'genres', 'Ambient');
    await wait(p, 3500);
    await shoot(p, 'genre-page');
  },
  folders: async (b) => {
    const p = await open(b);
    await tab(p, 'Folders');
    await wait(p, 1800);
    for (const name of ['A New World Sampled', 'Promo 2012 Alternate Version']) {
      await p.locator('.ft-dir', { hasText: name }).first().click();
      await wait(p, 700);
    }
    await shoot(p, 'folders');
  },
  // Songs, with a column of your own (Quality) and sorted by it, where
  // 24-bit gives way to CD quality.
  songs: async (b) => {
    const p = await open(b, {
      settings: { customColumns: [{ id: 'xquality', label: 'Quality', pattern: QUALITY, right: true }], songColumns: ['fav', 'title', 'artist', 'album', 'year', 'genre', 'xquality', 'len'] },
      song: ['Ritorno a casa in un pomeriggio estivo', 3],
    });
    await tab(p, 'Songs');
    await wait(p, 1500);
    await p.click('.song-head [data-col=xquality]');
    await wait(p, 1500);
    await p.evaluate(async () => {
      const { view } = await import('/js/data/view.js');
      const rows = view.rows || [];
      for (let i = 0; i < rows.length; i += 200) await view.tracks(rows.slice(i, i + 200));
      const at = rows.findIndex((r) => view.cachedTrack(r)?.formats?.x_xquality === '16/44.1');
      document.querySelector('.content').scrollTop = Math.max(0, (at - 6) * 35);
    });
    await wait(p, 1200);
    await shoot(p, 'songs');
  },
  // Now playing while shuffling: what's next comes from Fusion's own order.
  nowplaying: async (b) => {
    const p = await open(b, { song: null });
    await p.evaluate(async () => (await import('/js/data/player.js')).player.setOrder('shuffle-tracks'));
    await wait(p, 800);
    await playSong(p, 'Classics Nouveau', 2);
    await nav(p, 'Now playing');
    await wait(p, 2500);
    await shoot(p, 'nowplaying');
  },
  'signal-path': async (b) => {
    const p = await open(b, { song: ['Accumulation', 2] });
    await nav(p, 'Now playing');
    await wait(p, 2500);
    await p.click('.sp-chip');
    await wait(p, 800);
    await shoot(p, 'signal-path');
  },
  lyrics: async (b) => {
    const p = await open(b, { settings: { infoPanel: true, infoTab: 'lyrics' }, song: ['Night Ferry', 2, 66] });
    await wait(p, 3000);
    await shoot(p, 'lyrics');
  },
  stats: async (b) => {
    const p = await open(b);
    await nav(p, 'Listening stats');
    await wait(p, 3500);
    await shoot(p, 'stats');
  },
  playlists: async (b) => {
    const p = await open(b);
    await p.keyboard.press('Control+m');
    await wait(p, 1500);
    await shoot(p, 'playlists');
  },
  autoplaylist: async (b) => {
    const p = await open(b);
    await p.evaluate(async () => {
      (await import('/js/ui/autoplaylist.js')).newPlaylistDialog('auto');
    });
    await wait(p, 800);
    const fields = p.locator('.dialog input.field');
    await fields.nth(0).fill('Long and quiet');
    await fields.nth(1).click();
    await p.keyboard.type('GENRE HAS ambient AND %length_seconds% GREATER 4', { delay: 40 });
    await wait(p, 1500);
    await shoot(p, 'autoplaylist');
  },
  settings: async (b) => {
    const p = await open(b);
    await p.click('[data-settings-toggle]');
    await wait(p, 1200);
    await shoot(p, 'settings');
  },
  light: async (b) => {
    const p = await open(b, { dark: false });
    await openAlbum(p, 'B.L.Underwood|Classics Nouveau');
    await shoot(p, 'light');
  },
  // The mini player (Alt+M), at twice the size so it stays sharp.
  mini: async (b) => {
    const p = await open(b, { size: { width: 480, height: 200 }, scale: 2 });
    await p.evaluate(async () => (await import('/js/ui/mini.js')).toggleMini(true));
    await wait(p, 1500);
    await p.screenshot({ path: path.join(OUT, 'mini.jpg'), type: 'jpeg', quality: 90 });
    console.log('wrote mini');
  },
  // One page in four accent colours: the part where the accent shows (the
  // sidebar, the tabs, an opened album), at a readable size.
  colours: async (b) => {
    const accents = ['#107C10', '#1BA1E2', '#D80073', '#FA6800'];
    const files = [];
    for (const [i, accent] of accents.entries()) {
      const p = await open(b, { accent });
      await goTo(p, 'albums', 'Fature|Choice by Definition');
      await wait(p, 2500);
      await p.mouse.move(W - 6, H / 2);
      const file = path.join(OUT, `tmp-colour-${i}.jpg`);
      await p.screenshot({ path: file, type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1176, height: 735 } });
      files.push(file);
      await p.context().close();
    }
    await compose(b, 'colours', `<div style="display:grid;grid-template-columns:797px 797px;gap:6px">${files.map((f) => `<img src="${img(f)}" style="width:797px;height:497px;display:block">`).join('')}</div>`);
    files.forEach((f) => fs.unlinkSync(f));
  },
  // An opened album over its blurred cover, and over the cover's colours.
  backgrounds: async (b) => {
    const files = [];
    for (const listBackground of ['blur', 'art']) {
      const p = await open(b, { settings: { listBackground } });
      await goTo(p, 'albums', 'Lezet|Accumulation');
      await wait(p, 2500);
      await p.mouse.move(W - 6, 20);
      const file = path.join(OUT, `tmp-bg-${listBackground}.jpg`);
      const box = await p.locator('.trackpanel:visible').first().boundingBox();
      await p.screenshot({ path: file, type: 'jpeg', quality: 90, clip: { x: 250, y: box.y, width: W - 250, height: Math.min(box.height, 480) } });
      files.push({ file, h: Math.min(box.height, 480) });
      await p.context().close();
    }
    const label = (t) => `<div style="position:absolute;top:16px;right:20px;padding:6px 14px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff">${t}</div>`;
    const part = ({ file, h }, t) => `<div style="position:relative;height:${h}px"><img src="${img(file)}" style="display:block">${label(t)}</div>`;
    await compose(b, 'backgrounds', `<div style="display:flex;flex-direction:column;gap:6px">${part(files[0], 'Blurred cover')}${part(files[1], 'Album colours')}</div>`, { width: W - 250, height: files[0].h + files[1].h + 6 });
    files.forEach((f) => fs.unlinkSync(f.file));
  },
};

(async () => {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(SHOTS);
  const b = await chromium.launch();
  for (const name of names) {
    if (!SHOTS[name]) {
      console.error('no such shot:', name);
      continue;
    }
    await SHOTS[name](b);
    for (const ctx of b.contexts()) await ctx.close();
  }
  await b.close();
})();
