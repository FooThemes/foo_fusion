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
  const tags = el('div.info-tags', { hidden: true });
  const empty = el('p.info-empty', { text: 'Select a song, or play one, to see its properties.' });
  const close = el('button.btn-icon.info-close', { title: 'Close the track info panel', 'aria-label': 'Close', onclick: () => store.set('infoPanel', false) }, icon('close'));
  // Details (a summary) / Tags (every tag in the file, ReplayGain, technical info).
  let tab = 'details';
  const tabBtn = (key, label) =>
    el('button.info-tab', {
      text: label,
      role: 'tab',
      dataset: { tab: key },
      onclick: () => {
        tab = key;
        render();
      },
    });
  const tabs = el('div.info-tabs', { role: 'tablist' }, tabBtn('details', 'Details'), tabBtn('tags', 'Tags'));
  root.append(close, el('div.info-scroll', null, art, heading, tabs, table, tags, empty));

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
    tabs.hidden = !t;
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === tab);
    table.hidden = tab !== 'details';
    tags.hidden = tab !== 'tags';
    clear(heading);
    clear(table);
    if (!t) return clear(tags);
    if (tab === 'tags') renderTags(t);
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

  // Every tag of the file, then ReplayGain and the technical details.
  let tagsFor = null;
  async function renderTags(t) {
    const key = t.handle;
    if (tagsFor === key && tags.childElementCount) return;
    tagsFor = key;
    const [meta, rg] = await Promise.all([
      tryCall('metadata.readByPath', { path: t.handle }),
      tryCall('titleformat.evalFields', {
        path: t.handle,
        fields: {
          tg: '%replaygain_track_gain%',
          tp: '%replaygain_track_peak%',
          ag: '%replaygain_album_gain%',
          ap: '%replaygain_album_peak%',
          codec: '%codec%',
          profile: '[%codec_profile%]',
          bits: '[%__bitspersample%]',
          enc: '[%__encoding%]',
          tool: '[%__tool%]',
          br: '[%bitrate%]',
          sr: '[%samplerate%]',
          ch: '[%channels%]',
          len: '%length%',
          samples: '[%length_samples%]',
          size: '[%filesize_natural%]',
          mod: '[%last_modified%]',
          embedded: '[%__embedded_art%]',
        },
      }),
    ]);
    if (tagsFor !== key) return;
    clear(tags);
    const section = (title, pairs) => {
      const list = pairs.filter(([, v]) => v != null && String(v).trim() !== '' && v !== '?');
      if (!list.length) return;
      const dl = el('dl.info-table');
      for (const [k, v] of list) dl.append(el('dt', { text: k }), el('dd', { text: String(v), title: String(v) }));
      tags.append(el('h3.info-section', { text: title }), dl);
    };
    section('Tags', tagPairs(meta));
    const f = rg || {};
    section('ReplayGain', [
      ['Track gain', f.tg],
      ['Track peak', f.tp],
      ['Album gain', f.ag],
      ['Album peak', f.ap],
    ]);
    if (!f.tg && !f.ag) tags.append(el('p.info-note', { text: 'No ReplayGain information. foobar2000 can scan for it (right-click > ReplayGain > Scan).' }));
    section('Technical', [
      ['Codec', [f.codec, f.profile].filter(Boolean).join(' · ')],
      ['Encoding', f.enc],
      ['Bit depth', f.bits && `${f.bits} bits`],
      ['Bitrate', f.br && `${f.br} kbps`],
      ['Sample rate', f.sr && `${Number(f.sr).toLocaleString()} Hz`],
      ['Channels', f.ch],
      ['Length', f.len + (f.samples ? ` (${Number(f.samples).toLocaleString()} samples)` : '')],
      ['Tool', f.tool],
      ['Embedded art', f.embedded],
      ['File size', f.size],
      ['Last modified', f.mod],
    ]);
  }

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

/** [name, value] pairs from metadata.readByPath, whatever shape it comes in. */
function tagPairs(res) {
  if (!res) return [];
  const src = res.metadata || res.meta || res.tags || res.info?.meta || res;
  const out = [];
  const add = (k, v) => {
    if (v == null || typeof v === 'object' && !Array.isArray(v)) return;
    out.push([String(k).toUpperCase(), Array.isArray(v) ? v.join('; ') : String(v)]);
  };
  if (Array.isArray(src)) for (const it of src) add(it.name ?? it.key ?? it.field, it.values ?? it.value);
  else if (typeof src === 'object') for (const [k, v] of Object.entries(src)) if (!['path', 'success', 'info', 'technical', 'subsong', 'cueIndex'].includes(k)) add(k, v);
  return out.sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
}

// The usual tags first, in a familiar order; the rest alphabetical.
const FIRST = ['TITLE', 'ARTIST', 'ALBUM ARTIST', 'ALBUM', 'DATE', 'GENRE', 'TRACKNUMBER', 'TOTALTRACKS', 'DISCNUMBER', 'TOTALDISCS', 'COMPOSER', 'PERFORMER', 'COMMENT'];
const order = (k) => (FIRST.includes(k) ? FIRST.indexOf(k) : 100);
