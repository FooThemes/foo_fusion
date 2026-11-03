// Settings panel (slides in from the right, like the original).

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { ACCENTS } from '../core/store.js';
import { tryCall, on } from '../core/bridge.js';
import { runMainMenu, confirmDialog, showMenu, foobarMenuItems } from './menus.js';
import { clearCache } from '../data/artwork.js';
import { forgetArtistInfo } from '../data/artistinfo.js';
import { exportArtists } from '../data/artistexport.js';
import { toast } from './toast.js';
import { VERSION } from '../version.js';

export function mountSettings(root, app) {
  const body = el('div.set-body');
  const panel = el('div.settings', { role: 'dialog', 'aria-label': 'Settings' }, el('div.set-head', null, el('h2', { text: 'Settings' }), el('button.btn-icon', { title: 'Close', onclick: () => app.toggleSettings(false) }, icon('close'))), body);
  root.append(panel);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') app.toggleSettings(false);
  });

  // Highlighted while the window is fullscreen.
  const fullscreenBtn = quick('fullscreen', 'Fullscreen', () => tryCall('window.toggleFullscreen'));
  const setFullscreen = (on) => fullscreenBtn.classList.toggle('on', !!on);
  tryCall('window.isFullscreen').then((r) => setFullscreen(r?.fullscreen));
  on('window:stateChanged', (e) => (!e.windowId || e.windowId === 'main') && setFullscreen(e.fullscreen ?? e.isFullscreen));

  function render() {
    clear(body).append(
      el(
        'div.set-quick',
        null,
        quick('menu', 'Main menu', async () => showMenu(await foobarMenuItems())),
        quick('settings', 'Preferences', () => tryCall('misc.showPreferences')),
        fullscreenBtn,
      ),
      section('Theme', [
        choice('Mode', 'dark', [
          [false, 'Light'],
          [true, 'Dark'],
        ]),
        swatches(),
        customColour(),
      ]),
      section('Library', [
        toggle('Separate albums by disc', 'separateDiscs'),
        toggle('Show year under albums', 'showAlbumYear'),
        toggle('Show song counts under albums', 'showTrackCounts'),
        range('Album size', 'tileSize', 110, 260, 10),
        range('Artist size', 'artistTileSize', 100, 240, 10),
        toggle('Sort Collection and Favourites when opened', 'sortOnOpen'),
        folderField('Artist information folder', 'artistInfoFolder', 'One folder per artist with artist.nfo, artist.jpg and fanart.jpg (Kodi layout). Artists not there are looked for in their own music folder, above their albums.'),
        toggle('Grey out edition tags', 'dimEditionTags', 'Dims an ending like “(Single)” or “[Live]” in titles when it contains one of these words'),
        wordsField(),
      ]),
      section('Expanded album', [
        choice('Background', 'listBackground', [
          ['blur', 'Blurred cover', 'The cover, blurred, behind the songs'],
          ['art', 'Album colours', 'Background and title colours taken from the cover'],
          ['plain', 'Plain', 'The normal list colours'],
        ]),
        toggle('Show cover art', 'listArtLeft'),
      ]),
      section('Layout', [
        toggleInverse('Left panel', 'sidebarHidden'),
        toggle('Show playlist song counts', 'showPlaylistCounts'),
        toggle('Large now playing artwork', 'largeNowPlayingArt'),
        toggle('Track info panel', 'infoPanel'),
        toggle('Action bar for selected songs', 'selectionBar', 'Play, queue, like and add-to buttons along the bottom when songs are selected'),
        toggle('Waveform seek bar', 'waveformSeekbar', 'Draws the playing song’s waveform in place of the plain bar'),
        toggle('Smooth scrolling', 'smoothScroll'),
      ]),
      section('foobar2000', [
        link('settings', 'Preferences…', () => tryCall('misc.showPreferences')),
        link('library', 'Configure media library…', () => tryCall('config.showLibraryPreferences')),
        link('refresh', 'Refresh artwork', () => {
          clearCache();
          app.reload();
        }),
        link('person', 'Export artist list…', async () => {
          try {
            const r = await exportArtists();
            toast(`Exported ${r.count} artists (${r.withId} with MusicBrainz IDs) to ${r.path}`, 8000);
          } catch (err) {
            toast(`Export failed: ${err.message}`);
          }
        }),
        link('reset', 'Reset Fusion settings', async () => {
          if (await confirmDialog('Reset settings?', 'All Fusion settings go back to their defaults. Your playlists and library are not affected.', 'Reset')) store.reset();
        }),
      ]),
      el("p.set-about", { text: `Fusion ${VERSION}` }),
    );
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

  function folderField(label, key, hint) {
    const input = el('input.set-hex.set-path', { type: 'text', value: store.get(key) || '', placeholder: 'e.g. E:\\Music\\_Artists', spellcheck: false, 'aria-label': label });
    input.addEventListener('change', () => {
      store.set(key, input.value.trim());
      forgetArtistInfo();
      app.reload?.();
    });
    return el('label.set-folder', null, el('span.set-label', null, el('span', { text: label }), el('small', { text: hint })), input);
  }

  // Edition-tag words as removable chips, with a box to add more.
  function wordsField() {
    const words = () =>
      String(store.get('dimWords') || '')
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
    const save = (list) => store.set('dimWords', [...new Set(list)].join(', '));
    const off = !store.get('dimEditionTags');
    const add = el('input.set-word-add', { type: 'text', placeholder: 'Add a word…', disabled: off, 'aria-label': 'Add a word' });
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const w = add.value.trim().replace(/,/g, '');
      if (w) save([...words(), w]);
      add.value = '';
    });
    const chips = words().map((w) =>
      el('span.set-chip', null, el('span', { text: w }), el('button', { title: `Remove "${w}"`, disabled: off, onclick: () => save(words().filter((x) => x !== w)) }, icon('close'))),
    );
    return el(
      'div.set-words-box' + (off ? '.off' : ''),
      null,
      el('div.set-chips', null, chips, add),
      el('div.set-words-foot', null, el('small', { text: 'Works with (…), […], <…>, {…}, ~…~ and " - …" endings.' }), el('button.set-mini', { text: 'Defaults', disabled: off, onclick: () => store.set('dimWords', store.defaultOf('dimWords')) })),
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
      el(
        'div.seg',
        null,
        options.map(([value, text]) => el('button' + (store.get(key) === value ? '.on' : ''), { text, onclick: () => (store.set(key, value), render()) })),
      ),
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
    const hex = el('input.set-hex', { type: 'text', value: cur.toUpperCase(), maxLength: 7, spellcheck: false, 'aria-label': 'Hex colour' });
    const preview = el('span.set-colour-preview', { style: { background: cur } });
    let timer = 0;
    const apply = (c, from) => {
      c = c.toUpperCase();
      preview.style.background = c;
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
    if (!panel.classList.contains('open')) return;
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
      panel.classList.toggle('open', on);
      // preventScroll: focusing inside the sliding panel must not scroll the
      // main area sideways (that was the brief "shift" when opening).
      if (on) setTimeout(() => panel.querySelector('.set-head button')?.focus({ preventScroll: true }), 230);
    },
    get isOpen() {
      return panel.classList.contains('open');
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
