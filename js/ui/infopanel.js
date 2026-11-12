// Right-hand "properties" panel: details of the selected song, or of the
// playing song when nothing is selected.

import { el, clear, formatTime, debounce } from '../core/util.js';
import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';
import { view, splitValues } from '../data/view.js';
import { player } from '../data/player.js';
import { bindArt } from '../data/artwork.js';
import { icon } from '../core/icons.js';
import { lyricsFor, forgetLyrics, lineAt } from '../data/lyrics.js';
import { runHandlesCommand, hasHandlesCommand } from './menus.js';

export function mountInfoPanel(root) {
  const img = el('img', { alt: '' });
  const art = el('div.art.ph-album.info-art', null, img);
  const heading = el('div.info-heading');
  const table = el('dl.info-table');
  const tags = el('div.info-tags', { hidden: true });
  const empty = el('p.info-empty', { text: 'Select a song, or play one, to see its properties.' });
  const close = el('button.btn-icon.info-close', { title: 'Close the track info panel', 'aria-label': 'Close', onclick: () => store.set('infoPanel', false) }, icon('close'));
  // Details (a summary) / Tags (every tag in the file, ReplayGain) /
  // Technical (the file and its audio) / Lyrics.
  let tab = store.get('infoTab') || 'details';
  const tabBtn = (key, label) =>
    el('button.info-tab', {
      text: label,
      role: 'tab',
      dataset: { tab: key },
      onclick: () => {
        tab = key;
        store.set('infoTab', key);
        render();
      },
    });
  const tabs = el('div.info-tabs', { role: 'tablist' }, tabBtn('details', 'Details'), tabBtn('tags', 'Tags'), tabBtn('technical', 'Technical'), tabBtn('lyrics', 'Lyrics'));
  const tech = el('div.info-tags', { hidden: true });
  const lyr = el('div.info-lyrics', { hidden: true });
  const scroller = el('div.info-scroll', null, art, heading, tabs, table, tags, tech, lyr, empty);
  root.append(close, scroller);

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
    tech.hidden = tab !== 'technical';
    lyr.hidden = tab !== 'lyrics';
    if (!t) {
      clear(heading);
      clear(table);
      clear(tags);
      clear(tech);
      clear(lyr);
      lyricsShown = null;
      shownFor = null;
      return;
    }
    if (tab === 'tags') renderTags(t);
    if (tab === 'technical') renderTechnical(t);
    if (tab === 'lyrics') renderLyrics(t);
    else stopFollow();
    bindArt(img, t.handle, 350, ['front']);
    if (shownFor === t.handle + source) return;
    shownFor = t.handle + source;
    // Every value of the tags that can link to a page (one call), and the
    // names the Collection has, so only those become links.
    const [multi, artists, genres] = await Promise.all([
      tryCall('titleformat.evalFields', {
        path: t.handle,
        fields: { artist: "$meta_sep(artist,'|||')", albumArtist: "$meta_sep(album artist,'|||')", genre: "$meta_sep(genre,'|||')", performer: "$meta_sep(performer,'|||')", composer: "$meta_sep(composer,'|||')" },
      }),
      view.libraryValues('artists'),
      view.libraryValues('genres'),
    ]);
    if (shownFor !== t.handle + source) return;
    const m = multi || {};
    const values = (key, fallback) => (m[key] ? splitValues(m[key], key === 'genre' ? 'genres' : '') : fallback ? [fallback] : []);
    // Names as links when the Collection has them; the rest as text.
    const links = (list, kind) => {
      const known = kind === 'genres' ? genres : artists;
      const out = el('span');
      list.forEach((v, i) => {
        if (i) out.append(kind === 'genres' ? ', ' : '; ');
        const name = known?.get(v.toLowerCase());
        out.append(name ? el('button.info-link', { text: v, title: kind === 'genres' ? `Show ${name} albums` : `Show ${name}`, onclick: () => view.goTo(kind, name) }) : v);
      });
      return out;
    };
    clear(heading);
    clear(table);
    const artistLine = el('div.info-artist');
    const artistValues = values('artist', t.artist);
    if (artistValues.length) artistLine.append(links(artistValues, 'artists'));
    heading.append(el('div.info-source', { text: source }), el('div.info-title', { text: t.title || '' }), artistLine);
    const album = t.album
      ? el('button.info-link', {
          text: t.album,
          title: `Open ${t.album} in the Collection`,
          onclick: async () => view.goTo('albums', await view.albumKeyOf(t.handle)),
        })
      : null;
    const rows = [
      ['Album', album],
      ['Album artist', values('albumArtist', t.albumArtist).length ? links(values('albumArtist', t.albumArtist), 'artists') : null],
      ['Year', t.date],
      ['Genre', values('genre', t.genre).length ? links(values('genre', t.genre), 'genres') : null],
      ['Performer', values('performer').length ? links(values('performer'), 'artists') : null],
      ['Composer', values('composer', t.composer).length ? links(values('composer', t.composer), 'artists') : null],
      ['Track', t.trackNumber ? String(t.trackNumber) + (t.discNumber ? ` (disc ${t.discNumber})` : '') : ''],
      ['Length', t.duration ? formatTime(t.duration) : ''],
      ['Play count', t.playCount != null ? String(t.playCount) : ''],
      ['Last played', t.lastPlayed],
      ['Added', t.added],
      ['Rating', t.rating ? '★'.repeat(t.rating) : ''],
      ['Comment', t.comment],
    ];
    for (const [k, v] of rows) {
      if (!v) continue;
      table.append(el('dt', { text: k }), typeof v === 'string' ? el('dd', { text: v, title: v }) : el('dd', null, v));
    }
  }, 80);
  let shownFor = null;

  const section = (box, title, pairs) => {
    const list = pairs.filter(([, v]) => v != null && String(v).trim() !== '' && v !== '?');
    if (!list.length) return;
    const dl = el('dl.info-table');
    for (const [k, v] of list) dl.append(el('dt', { text: k }), el('dd', { text: String(v), title: String(v) }));
    box.append(...(title ? [el('h3.info-section', { text: title })] : []), dl);
  };

  // Every tag of the file, then ReplayGain.
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
        },
      }),
    ]);
    if (tagsFor !== key) return;
    clear(tags);
    section(tags, 'Tags', tagPairs(meta));
    const f = rg || {};
    section(tags, 'ReplayGain', [
      ['Track gain', f.tg],
      ['Track peak', f.tp],
      ['Album gain', f.ag],
      ['Album peak', f.ap],
    ]);
    if (!f.tg && !f.ag) tags.append(el('p.info-note', { text: 'No ReplayGain information. foobar2000 can scan for it (right-click > ReplayGain > Scan).' }));
  }

  // The file and its audio.
  let techFor = null;
  async function renderTechnical(t) {
    const key = t.handle;
    if (techFor === key && tech.childElementCount) return;
    techFor = key;
    const f =
      (await tryCall('titleformat.evalFields', {
        path: t.handle,
        fields: {
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
      })) || {};
    if (techFor !== key) return;
    clear(tech);
    section(tech, '', [
      ['Codec', [f.codec || t.codec, f.profile].filter(Boolean).join(' · ')],
      ['Encoding', f.enc],
      ['Bit depth', f.bits && `${f.bits} bits`],
      ['Bitrate', (f.br || t.bitrate) && `${f.br || t.bitrate} kbps`],
      ['Sample rate', f.sr && `${Number(f.sr).toLocaleString()} Hz`],
      ['Channels', f.ch],
      ['Length', f.len + (f.samples ? ` (${Number(f.samples).toLocaleString()} samples)` : '')],
      ['Tool', f.tool],
      ['Embedded art', f.embedded],
      ['File size', f.size || (t.fileSize > 0 ? `${(t.fileSize / 1048576).toFixed(1)} MB` : '')],
      ['Last modified', f.mod],
      ['Path', t.absolutePath || t.path],
    ]);
  }

  // --- Lyrics ---------------------------------------------------------------
  // Timed lyrics follow the playing song (the line being sung is lit, and
  // kept in view unless you've just scrolled); a line can be clicked to jump
  // there. foo_openlyrics, when installed, searches for missing ones.
  let lyricsShown = null; // handle the lyrics are drawn for
  let lyricLines = [];
  let lit = -1;
  let raf = 0;
  let userScrolled = 0;
  let retry = 0;
  scroller.addEventListener('wheel', () => (userScrolled = performance.now()), { passive: true });
  scroller.addEventListener('pointerdown', (e) => e.target === scroller && (userScrolled = performance.now()));

  async function renderLyrics(t, { again = false } = {}) {
    if (lyricsShown === t.handle && !again) return follow(t);
    lyricsShown = t.handle;
    clearTimeout(retry);
    stopFollow();
    if (!again) {
      clear(lyr);
      lyr.append(el('p.info-note', { text: 'Looking for lyrics…' }));
    }
    const [found, openLyrics] = await Promise.all([lyricsFor(t), hasHandlesCommand('Search for lyrics', [t.handle])]);
    if (lyricsShown !== t.handle) return;
    clear(lyr);
    lyricLines = [];
    lit = -1;
    const tools = el('div.lyr-tools');
    if (openLyrics) {
      tools.append(
        el('button.btn-text.lyr-btn', { text: found ? 'Search again' : 'Search with OpenLyrics', onclick: () => searchOpenLyrics(t) }),
        el('button.btn-text.lyr-btn', { text: 'Edit', title: 'Edit in foo_openlyrics', onclick: () => runHandlesCommand('Edit lyrics', [t.handle]) }),
      );
    }
    if (!found) {
      lyr.append(
        el('p.info-note', {
          text: openLyrics
            ? 'No lyrics found. foo_openlyrics can search for them (and searches by itself as songs play, if “search even when there are no visible panels” is on in its preferences).'
            : 'No lyrics found. Fusion reads .lrc and .txt files beside the song or where foo_openlyrics saves them, and lyrics tags. Install foo_openlyrics to search for them.',
        }),
        tools,
      );
      // foo_openlyrics may be searching for the playing song right now.
      if (openLyrics && player.track?.handle === t.handle && !again) scheduleRetry(t, [4000, 10000, 25000]);
      return;
    }
    if (found.synced) {
      lyricLines = found.lines;
      const box = el('div.lyr-lines');
      found.lines.forEach((l, i) =>
        box.append(
          el('p.lyr-line', {
            text: l.text || '♪',
            dataset: { i },
            title: formatTime(l.time),
            onclick: () => player.track?.handle === t.handle && player.seek(l.time),
          }),
        ),
      );
      lyr.append(box);
    } else lyr.append(el('div.lyr-plain', { text: found.text }));
    lyr.append(el('p.lyr-source', { text: `${found.synced ? 'Timed lyrics' : 'Lyrics'} from ${found.source.replace(/^.*\\/, '')}`, title: found.source }), tools);
    follow(t);
  }

  function scheduleRetry(t, delays) {
    if (!delays.length) return;
    retry = setTimeout(() => {
      if (lyricsShown !== t.handle || tab !== 'lyrics' || root.hidden) return;
      forgetLyrics(t.handle);
      renderLyrics(t, { again: true }).then(() => !lyricLines.length && !lyr.querySelector('.lyr-plain') && scheduleRetry(t, delays.slice(1)));
    }, delays[0]);
  }

  async function searchOpenLyrics(t) {
    await runHandlesCommand('Search for lyrics', [t.handle]);
    forgetLyrics(t.handle);
    lyricsShown = t.handle;
    scheduleRetry(t, [3000, 8000, 20000]);
  }

  function follow(t) {
    stopFollow();
    if (!lyricLines.length || player.track?.handle !== t.handle) {
      lyr.querySelector('.lyr-line.now')?.classList.remove('now');
      return;
    }
    const tick = () => {
      if (root.hidden || lyr.hidden) {
        lyricsShown = null;
        return stopFollow();
      }
      raf = requestAnimationFrame(tick);
      const i = lineAt(lyricLines, player.now());
      if (i === lit) return;
      lit = i;
      lyr.querySelector('.lyr-line.now')?.classList.remove('now');
      const line = i >= 0 ? lyr.querySelector(`.lyr-line[data-i="${i}"]`) : null;
      if (!line) return;
      line.classList.add('now');
      // Keep it in view, a third of the way down, unless you've just scrolled.
      if (performance.now() - userScrolled > 4000) {
        const top = line.offsetTop - scroller.clientHeight / 3;
        scroller.scrollTo({ top, behavior: store.get('animations') === false ? 'auto' : 'smooth' });
      }
    };
    tick();
  }

  function stopFollow() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  // Slides in and out: the column's width animates (see base.css), and the
  // panel is hidden once it has shut.
  let hideTimer = 0;
  function apply() {
    const on = !!store.get('infoPanel');
    clearTimeout(hideTimer);
    if (on) {
      root.hidden = false;
      requestAnimationFrame(() => document.body.classList.add('info-open'));
    } else {
      document.body.classList.remove('info-open');
      hideTimer = setTimeout(() => (root.hidden = true), document.body.classList.contains('animate-layout') ? 260 : 0);
    }
    render();
  }

  view.on('selection', render);
  view.on('change', () => ((shownFor = tagsFor = techFor = null), render()));
  player.on('track', render);
  player.on('state', () => tab === 'lyrics' && lyricsShown && !root.hidden && render());
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
