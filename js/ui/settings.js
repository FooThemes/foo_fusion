// Settings panel (slides in from the right, like the original).

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { ACCENTS } from '../core/store.js';
import { tryCall } from '../core/bridge.js';
import { runMainMenu, confirmDialog } from './menus.js';
import { clearCache } from '../data/artwork.js';
import { VERSION } from '../version.js';

export function mountSettings(root, app) {
  const body = el('div.set-body');
  const panel = el('div.settings', { role: 'dialog', 'aria-label': 'Settings' }, el('div.set-head', null, el('h2', { text: 'Settings' }), el('button.btn-icon', { title: 'Close', onclick: () => app.toggleSettings(false) }, icon('close'))), body);
  root.append(panel);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') app.toggleSettings(false);
  });

  function render() {
    clear(body).append(
      section('Theme', [
        choice('Mode', 'dark', [
          [false, 'Light'],
          [true, 'Dark'],
        ]),
        swatches(),
      ]),
      section('Library', [
        toggle('Separate albums by disc', 'separateDiscs'),
        toggle('Show year under albums', 'showAlbumYear'),
        toggle('Show song counts under albums', 'showTrackCounts'),
        range('Album size', 'tileSize', 110, 260, 10),
        range('Artist size', 'artistTileSize', 100, 240, 10),
        toggle('Sort Collection and Favorites when opened', 'sortOnOpen'),
      ]),
      section('Expanded album', [
        choice('Background', 'listBackground', [
          ['blur', 'Blurred cover'],
          ['plain', 'Plain'],
        ]),
        toggle('Show cover art', 'listArtLeft'),
      ]),
      section('Layout', [
        toggle('Show playlist song counts', 'showPlaylistCounts'),
        toggle('Large now playing artwork', 'largeNowPlayingArt'),
        toggle('Track info panel', 'infoPanel'),
        toggle('Selection bar', 'selectionBar'),
        toggle('Smooth scrolling', 'smoothScroll'),
      ]),
      section('foobar2000', [
        link('Preferences…', () => runMainMenu('File/Preferences')),
        link('Configure media library…', () => tryCall('config.showLibraryPreferences')),
        link('Refresh artwork', () => {
          clearCache();
          app.reload();
        }),
        link('Reset Fusion settings', async () => {
          if (await confirmDialog('Reset settings?', 'All Fusion settings go back to their defaults. Your playlists and library are not affected.', 'Reset')) store.reset();
        }),
      ]),
      el('p.set-about', { text: `Fusion ${VERSION} for foo_ui_webview2. Based on the original Fusion skin by NadirP.` }),
    );
  }

  function section(title, items) {
    return el('section.set-section', null, el('h3', { text: title }), items);
  }

  function toggle(label, key) {
    const input = el('input', { type: 'checkbox', checked: !!store.get(key), onchange: () => store.set(key, input.checked) });
    return el('label.set-toggle', null, el('span', { text: label }), input, el('span.switch'));
  }

  function choice(label, key, options) {
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
      ACCENTS.map((c) =>
        el('button.swatch' + (c.toLowerCase() === cur ? '.on' : ''), {
          style: { background: c },
          title: c,
          role: 'radio',
          'aria-checked': String(c.toLowerCase() === cur),
          onclick: () => (store.set('accent', c), render()),
        }),
      ),
    );
  }

  function link(label, onclick) {
    return el('button.set-link', { text: label, onclick });
  }

  store.subscribe(() => panel.classList.contains('open') && render());
  return {
    open(on) {
      if (on) render();
      panel.classList.toggle('open', on);
      if (on) panel.querySelector('button')?.focus();
    },
    get isOpen() {
      return panel.classList.contains('open');
    },
  };
}
