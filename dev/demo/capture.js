// Takes README screenshots from the demo library (see demo.js).
//
//   python dev/demo/build.py
//   python -m http.server 8765          (in the repo folder)
//   node dev/demo/capture.js [name …]   (needs Playwright)
//
// Writes docs/screenshots/<name>.jpg at 1600x1000, dark theme. With names,
// only those; without, all of them.

const path = require('path');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright'));
}

const URL = process.env.FUSION_URL || 'http://127.0.0.1:8765/index.html?demo';
const OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots');
const QUALITY = '$if($stricmp(%__encoding%,lossless),$ifequal(%__bitspersample%,1,DSD$div(%samplerate%,44100),%__bitspersample%/$div(%samplerate%,1000)$ifequal($mod($div(%samplerate%,100),10),0,,.$mod($div(%samplerate%,100),10))),%bitrate%kbps)';

// A song to have playing, by its place in the library: played from its row
// in the Collection (sorted differently from the library).
async function playSong(p, pick) {
  await p.evaluate(async (pick) => {
    const lib = window.__demoLib;
    const t =
      pick.album != null
        ? lib.find((x) => x.album === pick.album && x.trackNumber === (pick.track || 1))
        : lib.find((x) => (pick.hires ? x.bitsPerSample === 24 && x.sampleRate === 96000 : true) && x.trackNumber === (pick.track || 1) && x.title.length > 4);
    const res = await window.fb2k.invoke('playlist.getMatchingRows', { playlist: 0, query: `%path% IS "${t.handle}"` });
    await window.fb2k.invoke('playlist.playTrack', { playlist: 0, index: res.items[0] });
  }, pick);
  await p.waitForTimeout(1500);
}

const tab = (p, name) => p.evaluate((name) => [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === name)?.click(), name);
const nav = (p, name) => p.click(`.nav-item >> text=${name}`);

const SHOTS = {
  // The signal path, opened from its dot by the seek bar.
  'signal-path': async (p) => {
    await playSong(p, { album: 'Accumulation', track: 2 });
    await nav(p, 'Now playing');
    await p.waitForTimeout(2500);
    await p.click('.sp-chip');
    await p.waitForTimeout(800);
  },
  // Songs, with a column of your own (Quality) and sorted by it.
  songs: async (p) => {
    await p.evaluate(async (q) => {
      const s = await import('/js/core/store.js');
      s.set('customColumns', [{ id: 'xquality', label: 'Quality', pattern: q, right: true }]);
      s.set('songColumns', ['fav', 'title', 'artist', 'album', 'year', 'genre', 'xquality', 'len']);
    }, QUALITY);
    await playSong(p, { track: 3 });
    await tab(p, 'Songs');
    await p.waitForTimeout(1500);
    await p.click('.song-head [data-col=xquality]');
    await p.waitForTimeout(1500);
    // Where 24-bit gives way to CD quality, so the order shows.
    await p.evaluate(async () => {
      const { view } = await import('/js/data/view.js');
      const rows = view.rows || [];
      for (let i = 0; i < rows.length; i += 200) await view.tracks(rows.slice(i, i + 200));
      const at = rows.findIndex((r) => view.cachedTrack(r)?.formats?.x_xquality === '16/44.1');
      document.querySelector('.content').scrollTop = Math.max(0, (at - 6) * 35);
    });
    await p.waitForTimeout(1200);
  },
  // Now playing while shuffling: what's next comes from Fusion's own order.
  nowplaying: async (p) => {
    await p.evaluate(async () => (await import('/js/data/player.js')).player.setOrder('shuffle-tracks'));
    await p.waitForTimeout(800);
    await playSong(p, { album: 'Classics Nouveau', track: 2 });
    await p.waitForTimeout(1500);
    await nav(p, 'Now playing');
    await p.waitForTimeout(2500);
  },
};

(async () => {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(SHOTS);
  const b = await chromium.launch();
  for (const name of names) {
    const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.error(name, 'page error:', e.message));
    // Settings as the screenshots have them: dark, the default accent.
    await p.goto(URL);
    await p.waitForTimeout(1500);
    await p.evaluate(async () => {
      const s = await import('/js/core/store.js');
      s.set('dark', true);
      s.set('waveformSeekbar', true);
    });
    await p.waitForTimeout(1500); // saved (a moment after the last change)
    await p.reload();
    await p.waitForTimeout(4500);
    await SHOTS[name](p);
    await p.mouse.move(1590, 600);
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 86 });
    console.log('wrote', name);
    await ctx.close();
  }
  await b.close();
})();
