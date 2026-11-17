// Settings panel (slides in from the right, like the original).

import { el, clear, winPath } from '../core/util.js';
import { SHELVES } from './shelves.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { ACCENTS } from '../core/store.js';
import { tryCall, on } from '../core/bridge.js';
import { confirmDialog, showMenu, foobarMenuItems, promptPath } from './menus.js';
import { dropdown } from './dropdown.js';
import { forgetLyrics } from '../data/lyrics.js';
import { refreshArt } from '../data/artwork.js';
import { forgetArtistInfo } from '../data/artistinfo.js';
import { forgetGenreInfo } from '../data/genreinfo.js';
import { runArtistScript } from '../data/artistscript.js';
import { toast } from './toast.js';
import { VERSION } from '../version.js';
import { TEXT_KINDS } from '../data/versions.js';
import { setVersioned } from './titles.js';
import { overlayScroll } from './oscroll.js';
import { sheet } from './sheet.js';
import { tabBar } from './tabs.js';

const VERSION_CHOICES = [
  ['orig', 'Original'],
  ['en', 'English'],
  ['rom', 'Romanised'],
];
const THEN_CHOICES = [
  ['auto', 'Automatic'],
  ['orig', 'Original'],
  ['en', 'English'],
  ['rom', 'Romanised'],
  ['all', 'Both others'],
  ['none', 'Nothing'],
];
// Kinds of text, with a made-up example of each for the preview.
const LANGUAGE_KINDS = [
  ['albums', 'Album titles', { orig: '狂言', en: 'Farce', rom: 'Kyōgen' }],
  ['discs', 'Disc subtitles', { orig: '初回限定盤', en: 'Limited Edition', rom: 'Shokai Gentei-ban' }],
  ['titles', 'Song titles', { orig: 'スターマーカー (Album Mix)', en: 'Starmarker (Album Mix)', rom: 'Sutāmākā (Album Mix)' }],
  ['artists', 'Artists', { orig: '宇多田ヒカル', en: 'Hikaru Utada', rom: 'Utada Hikaru' }],
];

export function mountSettings(root, app) {
  const body = el('div.set-body');
  overlayScroll(body);
  const sh = sheet({ side: 'right', title: 'Settings', className: 'settings', toggle: '[data-settings-toggle]', close: () => app.toggleSettings(false) }, body);
  const panel = sh.node;
  root.append(panel);
  // foobar2000's own windows: out of the way first.
  const foobar = (method) => () => {
    app.toggleSettings(false);
    tryCall(method);
  };

  // Highlighted while the window is fullscreen.
  const fullscreenBtn = quick('fullscreen', 'Fullscreen', () => tryCall('window.toggleFullscreen'));
  const setFullscreen = (on) => fullscreenBtn.classList.toggle('on', !!on);
  tryCall('window.isFullscreen').then((r) => setFullscreen(r?.fullscreen));
  on('window:stateChanged', (e) => (!e.windowId || e.windowId === 'main') && setFullscreen(e.fullscreen ?? e.isFullscreen));

  // Pages of the panel; the last one opened is remembered for the session.
  const TABS = [
    ['look', 'Look'],
    ['library', 'Library'],
    ['artists', 'Artists'],
    ['genres', 'Genres'],
    ['languages', 'Languages'],
    ['more', 'More'],
  ];
  let tab = 'look';
  const tabs = tabBar(TABS, { className: 'line set-tabs', label: 'Settings pages', onPick: (id) => ((tab = id), (body.scrollTop = 0), render()) });
  // Main menu, Preferences, Fullscreen: above the tabs, on every page.
  const quickRow = el(
    'div.set-quick.set-quick-top',
    null,
    quick('menu', 'Main menu', async () => showMenu(await foobarMenuItems())),
    quick('settings', 'Preferences', foobar('misc.showPreferences')),
    fullscreenBtn,
  );
  panel.insertBefore(quickRow, body);
  panel.insertBefore(tabs.node, body);

  function render() {
    tabs.set(tab);
    clear(body).append(...PAGES[tab]());
  }

  const PAGES = {
    look: () => [
      section('Theme', [
        choice('Mode', 'dark', [
          [false, 'Light'],
          [true, 'Dark'],
        ]),
        swatches(),
        customColour(),
      ]),
      section('Layout', [
        toggleInverse('Left panel', 'sidebarHidden'),
        toggle('Show playlist song counts', 'showPlaylistCounts'),
        toggle('Large now playing artwork', 'largeNowPlayingArt'),
        toggle('Track info panel', 'infoPanel'),
        toggle('Action bar for selected songs', 'selectionBar', 'Play, queue, like and add-to buttons along the bottom when songs are selected'),
        toggle('Waveform seek bar', 'waveformSeekbar', 'Draws the playing song’s waveform in place of the plain bar'),
        toggle('Pause releases ASIO', 'releaseOnPause', 'Pausing on an ASIO output frees the device for other programs. Play resumes from the same point.'),
        toggle('Volume follows Windows', 'volumeFollowsWindows', "The volume slider and volume keys set Windows' volume. On exclusive and ASIO outputs foobar2000's volume matches it, so switching outputs doesn't change the loudness. Takes effect after a restart."),
        select('Volume on ASIO and exclusive outputs', 'exclusiveCurve', [
          ['amp', 'Plain', 'The level as a plain fraction: 50% is half the signal (−6 dB). Use this if Windows’ dB figures sound quieter than shared mode.'],
          ['windows', 'Windows’ dB', 'The dB Windows reports for the same level in shared mode'],
        ]),
        toggle('Animate scrolling to an opened album', 'smoothScroll', 'Glides to an album when it opens below the fold, rather than jumping'),
      ]),
      section('Expanded album', [
        select('Background', 'listBackground', [
          ['blur', 'Blurred cover', 'The cover, blurred, behind the songs'],
          ['art', 'Album colours', 'Background and title colours taken from the cover'],
          ['plain', 'Plain', 'The normal list colours'],
        ]),
        toggle('Show cover art', 'listArtLeft'),
      ]),
    ],
    library: () => [
      section('Albums', [
        toggle('Separate albums by disc', 'separateDiscs'),
        toggle('Show year under albums', 'showAlbumYear'),
        toggle('Show song counts under albums', 'showTrackCounts'),
        toggle('Sort Collection and Favourites when opened', 'sortOnOpen'),
      ]),
      section('Home shelves', [
        toggle('Show shelves above the Collection’s albums', 'homeShelves', 'Rows of albums at the top of the Albums tab. Uses play counts from foo_playcount (or Playcount 2003).'),
        shelvesField(),
      ]),
      section('Tile sizes', [range('Albums', 'tileSize', 110, 260, 10), range('Artists', 'artistTileSize', 100, 240, 10)]),
      section('Covers', [
        select('Animated GIF covers', 'gifCovers', [
          ['large', 'Large covers only', 'The open album and Now Playing animate; tiles show a still frame (much lighter with big GIFs)'],
          ['everywhere', 'Everywhere', 'Every GIF cover animates, tiles included'],
          ['never', 'Never', 'Still frames everywhere'],
        ]),
      ]),
      section('Edition tags', [
        toggle('Grey out edition tags', 'dimEditionTags', 'Dims an ending like “(Single)” or “[Live]” in titles when it contains one of these words'),
        wordsField(),
      ]),
      section('Lyrics', [
        lyricsFilesField(),
        toggle('Hide credits in timed lyrics', 'lyricsHideCredits', 'Lines like “Lyrics by：…”, “Composed by：…” or “作词 : …”, and a first line that’s just the title and artist, which some lyric sources add as timed lines.'),
      ]),
    ],
    artists: () => [
      section('Artists', [
        select('Artists without a picture', 'artistNoPicture', [
          ['cover', 'Album cover', 'One of their album covers stands in'],
          ['placeholder', 'Coloured silhouette', 'A silhouette on a colour of their own'],
          ['plain', 'Plain silhouette', 'A grey silhouette, the same for everyone'],
        ]),
        toggle('Hide placeholder artists', 'hidePlaceholderArtists', 'No artist tiles for MusicBrainz placeholder credits like [unknown], [dialogue] and [traditional]. Their songs stay in albums, Songs and search.'),
      ]),
      section('Artist information', [
        folderField('Artist information folder', 'artistInfoFolder', 'One folder per artist with artist.nfo, artist.jpg and fanart.jpg (Kodi layout). Artists not there are looked for in their own music folder, above their albums.'),
        link('refresh', 'Refresh artwork and artist information', () => {
          refreshArt();
          toast('Looking for artwork and artist information again');
        }),
      ]),
      section('Artist information script', [
        scriptField(),
        link('person', 'Look up new artists', () => startScript('new', 'Looking up new artists in a console window…')),
        link('refresh', 'Refresh all artists', () => startScript('refresh', 'Refreshing all artists in a console window (this takes a while)…')),
        link('info', 'Show report', () => startScript('report', '')),
      ]),
    ],
    genres: () => [
      section('Genres', [genreSplitField()]),
      section('Genre information', [
        folderField('Genre information folder', 'genreInfoFolder', 'One folder per genre with genre.nfo and folder.jpg (square). The artist script fills it in with “Look up new genres”; without a picture, genres show four of their album covers.', 'e.g. E:\\Music\\_Genres'),
      ]),
      section('Genre information script', [
        scriptField(),
        link('tag', 'Look up new genres', () => startScript('genres', 'Looking up new genres in a console window…')),
        link('refresh', 'Refresh all genres', () => startScript('genres-refresh', 'Refreshing all genres in a console window…')),
      ]),
    ],
    languages: () => [
      el('p.set-note', {
        text: 'For songs tagged with original, English and romanised versions (TITLE_ORIG, TITLE_EN, TITLE_ROM and the same for artist, album and disc subtitle, as the Language Variants Picard plugin writes). Other songs show as tagged.',
      }),
      ...LANGUAGE_KINDS.map(([kind, label, sample]) => languageCard(kind, label, sample)),
      toggle('List every version in tooltips', 'versionTooltips', 'Point at a title to see its original, English and romanised versions'),
    ],
    more: () => [
      section('foobar2000', [
        link('settings', 'Preferences…', foobar('misc.showPreferences')),
        link('library', 'Configure media library…', foobar('config.showLibraryPreferences')),
      ]),
      section('Fusion', [
        toggle('Mini player stays on top', 'miniOnTop', 'Alt+M, or the mini player button in the play bar, shrinks the window to just the play bar.'),
        toggle('Diagnostics', 'diagnostics', 'Write timings and other details to fusion.log in foobar2000’s profile folder, for tracking down slowness or a fault. Warnings and errors are logged either way.'),
        link('info', 'Open the log file', openLog),
        link('reset', 'Reset Fusion settings', async () => {
          if (await confirmDialog('Reset settings?', 'All Fusion settings go back to their defaults. Your playlists and library are not affected.', 'Reset')) store.reset();
        }),
      ]),
      about(),
    ],
  };

  /** fusion.log, in foobar2000's profile folder: opened, or shown in Explorer. */
  async function openLog() {
    const res = await tryCall('misc.getProfilePath');
    const dir = (typeof res === 'string' ? res : res?.path || res?.profilePath || res?.directory || '').replace(/[\\/]$/, '');
    if (!dir) return toast("Couldn't find foobar2000's profile folder");
    const path = `${dir}\\fusion.log`;
    const opened = await tryCall('shell.openExternal', { url: 'file:///' + path.replace(/\\/g, '/') });
    if (!opened) await tryCall('shell.showInExplorer', { path });
  }

  // Before the script runs: where it is, and where it writes (the folder
  // these pages show), asked for when they're not set yet.
  async function startScript(mode, message) {
    const genres = mode.startsWith('genres');
    if (!/\.py$/i.test(String(store.get('artistScript') || '').trim().replace(/^"|"$/g, ''))) {
      const path = await promptPath('Where is the artist script?', 'Fusion runs fusion-artist-info.py (in Fusion’s tools folder) with Python. Its settings file sits beside it.', {
        folder: false,
        placeholder: 'e.g. C:\\Tools\\artist-info\\fusion-artist-info.py',
        filter: { name: 'Python script', extensions: ['py'] },
      });
      if (!path) return;
      store.set('artistScript', path);
    }
    const key = genres ? 'genreInfoFolder' : 'artistInfoFolder';
    if (mode !== 'report' && !String(store.get(key) || '').trim()) {
      const path = await promptPath(
        genres ? 'Choose a genre information folder' : 'Choose an artist information folder',
        genres ? 'The script writes a folder for each genre here (genre.nfo and its picture), and Fusion reads them from here.' : 'The script writes a folder here for each artist who doesn’t have their own music folder, and Fusion reads them from here.',
        { placeholder: genres ? 'e.g. E:\\Music\\_Genres' : 'e.g. E:\\Music\\_Artists', okLabel: 'Use this folder' },
      );
      if (!path) return;
      setFolder(key, path);
    }
    try {
      await runArtistScript(mode);
      if (message) toast(message, 6000);
    } catch (err) {
      toast(err.message, 8000);
    }
  }

  function scriptField() {
    return pathField('Script', 'artistScript', 'Where fusion-artist-info.py is (its settings file sits beside it). Needs Python.', 'e.g. C:\\Tools\\artist-info\\fusion-artist-info.py', { folder: false, filter: { name: 'Python script', extensions: ['py'] } });
  }

  // A path box with a Browse button (the system's picker).
  function pathField(label, key, hint, placeholder, { folder = true, filter = null, onSet: set = (v) => store.set(key, v), startIn = null } = {}) {
    const input = el('input.field.set-hex.set-path', { type: 'text', value: store.get(key) || '', placeholder, spellcheck: false, 'aria-label': label });
    // Either slash will do; the path is kept the Windows way.
    const onSet = (v) => {
      const path = winPath(v);
      input.value = path;
      set(path);
    };
    input.addEventListener('change', () => onSet(input.value));
    const browse = el('button.btn-soft.set-browse', {
      type: 'button',
      text: 'Browse…',
      onclick: async (e) => {
        e.preventDefault();
        const start = winPath(input.value) || startIn?.() || '';
        const res = folder
          ? await tryCall('dialog.openFolder', { title: label, defaultPath: start })
          : await tryCall('dialog.openFile', { title: label, defaultPath: start.replace(/[\\/][^\\/]*$/, ''), ...(filter ? { filters: [filter] } : {}) });
        const picked = folder ? res?.folderPath : res?.filePaths?.[0] || res?.filePath;
        if (picked) onSet(picked);
      },
    });
    return el('div.set-folder', null, el('span.set-label', null, el('span', { text: label }), el('small', { text: hint })), el('div.set-path-row', null, input, browse));
  }

  // Characters that separate genres within one tag.
  function genreSplitField() {
    const input = el('input.field.set-hex.set-split', { type: 'text', value: store.get('genreSplit') ?? ';', spellcheck: false, maxLength: 12, 'aria-label': 'Split genres at' });
    input.addEventListener('change', () => store.set('genreSplit', [...new Set(input.value.replace(/\s+/g, ''))].join(' ')));
    return el(
      'div.set-folder',
      null,
      el(
        'div.set-split-line',
        null,
        el('span.set-label', null, el('span', { text: 'Split genres at' }), el('small', { text: 'Characters that separate genres within one tag. With “; , /”, “Pop/Rock” shows under Pop and under Rock (“Singer/Songwriter” stays whole).' })),
        input,
      ),
    );
  }

  // Fusion's version, and foobar2000's and its WebView2 component's, a
  // line each, under the last section.
  let hostVersions = null;
  function about() {
    const line = el('p.set-about', { text: `Fusion ${VERSION}` });
    const fb = el('p.set-about');
    const plugin = el('p.set-about');
    const fill = (v) => {
      if (!v) return;
      // The version can come with the name already ("foobar2000 v2.26.2").
      const ver = String(v.version || '').replace(/^foobar2000\s*/i, '');
      fb.textContent = [`foobar2000 ${ver}`.trim(), [v.is64bit ? '64-bit' : '32-bit', v.isPortable ? 'portable' : ''].filter(Boolean).join(', ')].join(' · ');
      plugin.textContent = v.plugin?.version ? `${v.plugin.name || 'foo_ui_webview2'} ${String(v.plugin.version).replace(new RegExp(`^${v.plugin.name || 'foo_ui_webview2'}\\s*`, 'i'), '')}` : '';
      plugin.hidden = !plugin.textContent;
    };
    if (hostVersions) fill(hostVersions);
    else tryCall('config.getVersionInfo').then((v) => fill((hostVersions = v)));
    return el('div.set-versions', null, line, fb, plugin);
  }

  // One kind of text: which version shows, what follows it, and how that looks.
  function languageCard(kind, label, sample) {
    const k = TEXT_KINDS[kind];
    const preview = el('div.set-lang-preview');
    const tip = setVersioned(preview, sample.orig, sample, kind);
    preview.title = tip;
    return el(
      'div.set-lang',
      null,
      el('div.set-lang-head', null, el('span', { text: label }), preview),
      el(
        'div.set-lang-row',
        null,
        miniSelect('Show', `lead${k}`, VERSION_CHOICES),
        miniSelect('Then', `then${k}`, THEN_CHOICES),
      ),
    );
  }

  // Fusion's drop-down (themed like Sort by), in place of a <select>.
  function selectButton(label, key, options) {
    const cur = options.find(([v]) => v === store.get(key)) || options[0];
    const btn = el(
      'button.set-select',
      {
        type: 'button',
        'aria-label': label,
        'aria-haspopup': 'menu',
        onclick: () => dropdown(btn, options.map(([value, text]) => ({ label: text, checked: store.get(key) === value, run: () => store.set(key, value) })), { align: 'right' }),
      },
      el('span', { text: cur[1] }),
      icon('chevronDown'),
    );
    return btn;
  }

  function miniSelect(label, key, options) {
    return el('div.set-mini-select', null, el('small', { text: label }), selectButton(label, key, options));
  }

  // A choice of three or more: one row with a drop-down, and the chosen
  // option's explanation under it.
  function select(label, key, options) {
    const cur = options.find(([v]) => v === store.get(key));
    return el(
      'div.set-select-row',
      null,
      el('div.set-select-line', null, el('span', { text: label }), selectButton(label, key, options)),
      cur?.[2] ? el('small.hint', { text: cur[2] }) : null,
    );
  }

  // Each shelf on or off, in the order they appear (arrows move one).
  function shelvesField() {
    const list = el('div.shelf-order');
    const draw = () => {
      const cur = store.get('shelves') || [];
      const save = (next) => (store.set('shelves', next), draw());
      list.replaceChildren(
        ...cur.filter(([id]) => SHELVES[id]).map(([id, on], i) => {
          const input = el('input', { type: 'checkbox', checked: !!on, onchange: () => save(cur.map((x, k) => (k === i ? [x[0], input.checked] : x))) });
          const move = (d) => {
            const next = cur.slice();
            [next[i], next[i + d]] = [next[i + d], next[i]];
            save(next);
          };
          return el(
            'div.shelf-order-row',
            { dataset: { shelf: id } },
            el('label.set-toggle', null, el('span.set-label', null, el('span', { text: SHELVES[id].label }), el('small', { text: SHELVES[id].hint })), input, el('span.switch')),
            el('button.btn-icon', { title: 'Move up', disabled: i === 0, onclick: () => move(-1) }, icon('chevronDown', 'flip')),
            el('button.btn-icon', { title: 'Move down', disabled: i === cur.length - 1, onclick: () => move(1) }, icon('chevronDown')),
          );
        }),
      );
      list.classList.toggle('off', store.get('homeShelves') === false);
    };
    draw();
    return list;
  }

  function section(title, items) {
    return el('section.set-section', null, el('h3', { text: title }), items);
  }

  function toggle(label, key, hint) {
    const input = el('input', { type: 'checkbox', checked: !!store.get(key), onchange: () => store.set(key, input.checked) });
    const text = hint ? el('span.set-label', null, el('span', { text: label }), el('small', { text: hint })) : el('span', { text: label });
    return el('label.set-toggle', null, text, input, el('span.switch'));
  }

  function toggleInverse(label, key) {
    const input = el('input', { type: 'checkbox', checked: !store.get(key), onchange: () => store.set(key, !input.checked) });
    return el('label.set-toggle', null, el('span', { text: label }), input, el('span.switch'));
  }

  function setFolder(key, value) {
    value = winPath(value);
    store.set(key, value);
    forgetArtistInfo();
    forgetGenreInfo();
    app.reload?.();
  }

  function folderField(label, key, hint, placeholder = 'e.g. E:\\Music\\_Artists') {
    return pathField(label, key, hint, placeholder, { onSet: (v) => setFolder(key, v) });
  }

  // Edition-tag words as removable chips, with a box to add more.
  // Where lyric files are looked for (title formatting, one a line).
  function lyricsFilesField() {
    const box = el('textarea.field.set-hex.set-patterns', { rows: 3, spellcheck: false, value: store.get('lyricsFiles') || '', 'aria-label': 'Lyric files' });
    box.addEventListener('change', () => {
      store.set('lyricsFiles', box.value.split('\n').map((l) => l.trim()).filter(Boolean).join('\n'));
      forgetLyrics();
    });
    return el(
      'div.set-folder',
      null,
      el('span.set-label', null, el('span', { text: 'Lyric files' }), el('small', { text: 'Where the Lyrics tab looks, one title formatting pattern a line, without the extension (.lrc, then .txt). %profile% is foobar2000’s profile folder. The second line is where foo_openlyrics saves by default; change it if you set it to save elsewhere. Lyrics in tags (UNSYNCED LYRICS, LYRICS…) are read too.' })),
      box,
      el('div.set-words-foot', null, el('small'), el('button.btn-soft', { text: 'Defaults', onclick: () => (store.set('lyricsFiles', store.defaultOf('lyricsFiles')), forgetLyrics()) })),
    );
  }

  function wordsField() {
    const words = () =>
      String(store.get('dimWords') || '')
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
    const save = (list) => store.set('dimWords', [...new Set(list)].join(', '));
    const off = !store.get('dimEditionTags');
    const add = el('input.set-word-add', { type: 'text', placeholder: 'Add a word…', disabled: off, 'aria-label': 'Add a word' });
    // Enter, comma or Tab finishes a word (Tab with nothing typed moves on as usual).
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ',' && !(e.key === 'Tab' && !e.shiftKey && add.value.trim())) return;
      e.preventDefault();
      const w = add.value.trim().replace(/,/g, '');
      add.value = '';
      if (w) save([...words(), w]);
      // The list is redrawn: carry on typing in the new box.
      requestAnimationFrame(() => document.querySelector('.set-word-add')?.focus());
    });
    const chips = words().map((w) =>
      el('span.set-chip', null, el('span', { text: w }), el('button', { title: `Remove "${w}"`, disabled: off, onclick: () => save(words().filter((x) => x !== w)) }, icon('close'))),
    );
    return el(
      'div.set-words-box' + (off ? '.off' : ''),
      null,
      el('div.set-chips', null, chips, add),
      el('div.set-words-foot', null, el('small', { text: 'Works with (…), […], <…>, {…}, ‹…›, «…», 【…】, ~…~, 〜…〜, -…- and " - …" endings.' }), el('button.btn-soft', { text: 'Defaults', disabled: off, onclick: () => store.set('dimWords', store.defaultOf('dimWords')) })),
    );
  }

  function quick(iconName, label, onclick) {
    return el('button.set-quick-btn', { onclick, title: label }, icon(iconName), el('span.set-quick-label', { text: label }));
  }

  function choice(label, key, options) {
    // Three or more options: a list of radio rows (a row of buttons would wrap).
    if (options.length > 2) {
      return el(
        'div.set-radio',
        { role: 'radiogroup', 'aria-label': label },
        el('span.set-radio-label', { text: label }),
        options.map(([value, text, hint]) =>
          el(
            'button.set-radio-row' + (store.get(key) === value ? '.on' : ''),
            { role: 'radio', 'aria-checked': String(store.get(key) === value), onclick: () => store.set(key, value) },
            el('span.set-radio-dot'),
            el('span.set-radio-text', null, el('span', { text }), hint ? el('small', { text: hint }) : null),
          ),
        ),
      );
    }
    return el(
      'div.set-choice',
      null,
      el('span', { text: label }),
      tabBar(options, { className: 'small', label, picked: store.get(key), onPick: (value) => (store.set(key, value), render()) }).node,
    );
  }

  function range(label, key, min, max, step) {
    const out = el('span.set-range-value', { text: store.get(key) + ' px' });
    const input = el('input', { type: 'range', min, max, step, value: store.get(key) });
    input.addEventListener('input', () => (out.textContent = input.value + ' px'));
    input.addEventListener('change', () => store.set(key, Number(input.value)));
    return el('label.set-range', null, el('span', { text: label }), out, input);
  }

  function swatches() {
    const cur = store.get('accent').toLowerCase();
    return el(
      'div.swatches',
      { role: 'radiogroup', 'aria-label': 'Accent colour' },
      ACCENTS.map((c) => {
        const on = c.toLowerCase() === cur;
        return el(
          'button.swatch' + (on ? '.on' : ''),
          { style: { '--sw': c }, title: c, role: 'radio', 'aria-checked': String(on), onclick: () => store.set('accent', c) },
          on ? icon('check') : null,
        );
      }),
    );
  }

  // Your own colour: a hue strip for quick picks, plus the system colour
  // picker and a hex box for exact values.
  function customColour() {
    const cur = store.get('accent');
    const hsl = hexToHsl(cur);
    const hue = el('input.hue', { type: 'range', min: 0, max: 359, step: 1, value: Math.round(hsl.h), 'aria-label': 'Hue' });
    const shade = el('input.shade', { type: 'range', min: 25, max: 65, step: 1, value: Math.round(clampN(hsl.l, 25, 65)), 'aria-label': 'Lightness' });
    const picker = el('input.set-picker', { type: 'color', value: cur, title: 'Pick any colour' });
    const hex = el('input.field.set-hex', { type: 'text', value: cur.toUpperCase(), maxLength: 7, spellcheck: false, 'aria-label': 'Hex colour' });
    // Picked like the swatches above: ringed, with a tick, when it's the colour in use.
    const custom = (c) => !ACCENTS.some((a) => a.toLowerCase() === c.toLowerCase());
    const preview = el('span.set-colour-preview' + (custom(cur) ? '.on' : ''), { style: { background: cur } }, icon('check'));
    let timer = 0;
    const apply = (c, from) => {
      c = c.toUpperCase();
      preview.style.background = c;
      preview.classList.toggle('on', custom(c));
      if (from !== 'hex') hex.value = c;
      if (from !== 'picker') picker.value = c.toLowerCase();
      if (from !== 'slider') {
        const h = hexToHsl(c);
        hue.value = Math.round(h.h);
        shade.value = Math.round(clampN(h.l, 25, 65));
      }
      document.documentElement.style.setProperty('--accent', c);
      clearTimeout(timer);
      timer = setTimeout(() => store.get('accent').toUpperCase() !== c && store.set('accent', c), 250);
    };
    const fromSliders = () => apply(hslToHex(Number(hue.value), 72, Number(shade.value)), 'slider');
    hue.addEventListener('input', fromSliders);
    shade.addEventListener('input', fromSliders);
    shade.style.setProperty('--h', hue.value);
    hue.addEventListener('input', () => shade.style.setProperty('--h', hue.value));
    picker.addEventListener('input', () => apply(picker.value, 'picker'));
    hex.addEventListener('input', () => {
      let v = hex.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) apply(v, 'hex');
    });
    return el(
      'div.set-custom',
      null,
      el('div.set-custom-head', null, el('span', { text: 'Custom colour' }), preview),
      hue,
      shade,
      el('div.set-custom-row', null, el('label.set-picker-wrap', { title: 'Pick any colour' }, icon('palette'), picker), hex),
    );
  }

  function link(iconName, label, onclick) {
    return el('button.set-link', { onclick }, icon(iconName), el('span', { text: label }));
  }

  // Re-render on changes, keeping the scroll position (and not while the
  // custom colour controls are being dragged or typed in).
  store.subscribe(() => {
    if (!sh.isOpen) return;
    if (panel.querySelector('.set-custom')?.contains(document.activeElement)) return;
    const refocus = document.activeElement?.classList.contains('set-word-add');
    const top = body.scrollTop;
    render();
    body.scrollTop = top;
    if (refocus) panel.querySelector('.set-word-add')?.focus({ preventScroll: true });
  });
  return {
    open(on) {
      if (on) render();
      sh.set(on);
      // preventScroll: focusing inside the sliding panel must not scroll the
      // main area sideways (that was the brief "shift" when opening).
      if (on) setTimeout(() => sh.closeBtn.focus({ preventScroll: true }), 230);
    },
    get isOpen() {
      return sh.isOpen;
    },
  };
}

function clampN(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}
