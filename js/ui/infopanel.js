// Right-hand "properties" panel: details of the selected song, or of the
// playing song when nothing is selected.

import { el, clear, formatTime, debounce } from '../core/util.js';
import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt } from '../data/artwork.js';
import { icon } from '../core/icons.js';

export function mountInfoPanel(root) {
  const img = el('img', { alt: '' });
  const art = el('div.art.ph-album.info-art', null, img);
  const heading = el('div.info-heading');
  const table = el('dl.info-table');
  const empty = el('p.info-empty', { text: 'Select a song, or play one, to see its properties.' });
  const close = el('button.btn-icon.info-close', { title: 'Close the track info panel', 'aria-label': 'Close', onclick: () => store.set('infoPanel', false) }, icon('close'));
  root.append(close, el('div.info-scroll', null, art, heading, table, empty));

  const render = debounce(async () => {
    if (root.hidden) return;
    let t = null;
    let source = '';
    const sel = [...view.selection];
    if (sel.length && view.playlist) {
      const res = await tryCall('playlist.getTracksAt', { playlist: view.playlist.index, rows: [Math.min(...sel)] });
      t = res?.tracks?.[0] || null;
      source = sel.length > 1 ? `${sel.length} songs selected · showing the first` : 'Selected song';
    } else if (player.active && player.track) {
      t = player.track;
      source = 'Now playing';
    }
    empty.hidden = !!t;
    art.hidden = !t;
    clear(heading);
    clear(table);
    if (!t) return;
    bindArt(img, t.handle, 350, ['front']);
    heading.append(el('div.info-source', { text: source }), el('div.info-title', { text: t.title || '' }), el('div.info-artist', { text: t.artist || '' }));
    const rows = [
      ['Album', t.album],
      ['Album artist', t.albumArtist],
      ['Year', t.date],
      ['Genre', t.genre],
      ['Track', t.trackNumber ? String(t.trackNumber) + (t.discNumber ? ` (disc ${t.discNumber})` : '') : ''],
      ['Composer', t.composer],
      ['Length', t.duration ? formatTime(t.duration) : ''],
      ['Codec', t.codec],
      ['Bitrate', t.bitrate ? `${t.bitrate} kbps` : ''],
      ['Sample rate', t.sampleRate ? `${t.sampleRate.toLocaleString()} Hz` : ''],
      ['Channels', t.channels ? String(t.channels) : ''],
      ['File size', t.fileSize > 0 ? `${(t.fileSize / 1048576).toFixed(1)} MB` : ''],
      ['Play count', t.playCount != null ? String(t.playCount) : ''],
      ['Last played', t.lastPlayed],
      ['Added', t.added],
      ['Rating', t.rating ? '★'.repeat(t.rating) : ''],
      ['Comment', t.comment],
      ['Path', t.absolutePath || t.path],
    ];
    for (const [k, v] of rows) {
      if (!v) continue;
      table.append(el('dt', { text: k }), el('dd', { text: v, title: v }));
    }
  }, 80);

  function apply() {
    root.hidden = !store.get('infoPanel');
    render();
  }

  view.on('selection', render);
  view.on('change', render);
  player.on('track', render);
  store.subscribe((k) => k === 'infoPanel' && apply());
  apply();
}
