// Run tools/fusion-artist-info.py from Fusion (Settings > Artists): export
// the artist list, start the script in a console window (so its progress
// shows, and it waits for Enter at the end), then read the artist
// information again once it has finished.

import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';
import { exportArtists, exportGenres, exportPath } from './artistexport.js';
import { refreshArtistInfo } from './artwork.js';
import { forgetGenreInfo } from './genreinfo.js';
import { logInfo } from '../core/log.js';

/**
 * mode: 'new' (look up artists not done yet), 'refresh' (everything again,
 * filling in existing artist.nfo files) or 'report'. Resolves once started;
 * throws with a readable message when it can't be.
 */
export async function runArtistScript(mode) {
  const script = String(store.get('artistScript') || '').trim().replace(/^"|"$/g, '');
  if (!/\.py$/i.test(script)) throw new Error('Set the location of fusion-artist-info.py first');
  // The lists are written fresh each time, so the script sees the library as it is now.
  if (mode === 'genres' || mode === 'genres-refresh') await exportGenres();
  else await exportArtists();
  const flags = { refresh: ['--refresh'], report: ['--report'], genres: ['--genres'], 'genres-refresh': ['--genres', '--refresh'] }[mode] || [];
  // Fusion's information folders are where the script writes (whatever its
  // settings file says), so the two always agree.
  const folder = (key) => String(store.get(key) || '').trim();
  const where = [...(folder('artistInfoFolder') ? ['--artists-folder', folder('artistInfoFolder')] : []), ...(folder('genreInfoFolder') ? ['--genres-folder', folder('genreInfoFolder')] : [])];
  // And where the lists were exported to.
  const lists = ['--artist-list', await exportPath('fusion-artists.json'), '--genre-list', await exportPath('fusion-genres.json')];
  const args = [script, ...flags, ...where, ...lists, '--pause'];
  // The Python launcher ("py") comes with python.org's installer; else "python".
  let started = null;
  for (const executable of ['py', 'python']) {
    started = await tryCall('shell.spawn', { executable, args, hidden: false, waitForExitMs: 400 });
    if (started) break;
  }
  if (!started) throw new Error("Couldn't start Python (is it installed, with “py” or “python” on the PATH?)");
  logInfo(`artist script started (${mode}), process ${started.processId}`);
  if (mode !== 'report') whenFinished(script);
}

// The script logs "--- 9 new, 845 skipped, …" when it's done; check its log
// now and then. If the log can't be read, read the artist information again
// when the window gets focus back (after pressing Enter in the console).
function whenFinished(script) {
  const log = script.replace(/[^\\/]+$/, 'fusion-artist-info.log');
  const started = Date.now();
  let timer = 0;
  const finish = () => {
    clearInterval(timer);
    window.removeEventListener('focus', onFocus);
    refreshArtistInfo();
    forgetGenreInfo();
  };
  const onFocus = () => setTimeout(check, 500);
  async function check() {
    const res = await tryCall('file.read', { path: log });
    const last = (res?.content || '').trimEnd().split('\n').pop() || '';
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) --- .*\bnew\b/.exec(last);
    if (m && new Date(m[1].replace(' ', 'T')).getTime() >= started - 60000) finish();
    else if (Date.now() - started > 4 * 3600 * 1000) finish();
  }
  timer = setInterval(check, 10000);
  window.addEventListener('focus', onFocus);
}
