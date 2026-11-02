// Fusion for foo_ui_webview2 - entry point.
//
// Boot order: bridge (or the dev mock) -> settings -> data models -> UI.

import { el } from './core/util.js';
import { tryCall } from './core/bridge.js';
import * as store from './core/store.js';
import { player } from './data/player.js';
import { playlists } from './data/playlists.js';
import { view } from './data/view.js';
import { mountSidebar } from './ui/sidebar.js';
import { mountHeader } from './ui/header.js';
import { mountContent } from './ui/content.js';
import { mountPlayerBar } from './ui/playerbar.js';
import { mountSettings } from './ui/settings.js';
import { mountInfoPanel } from './ui/infopanel.js';
import { mountSelectionBar } from './ui/selectionbar.js';
import { mountKeyboard } from './ui/keyboard.js';
import { installLog, logInfo } from './core/log.js';
import { VERSION } from './version.js';

async function boot() {
  if (!window.fb2k) {
    // Opened outside foobar2000 (e.g. in a browser while developing).
    const { installMock } = await import('../dev/mock-bridge.js');
    await installMock();
  }

  installLog(VERSION);
  // foo_ui_webview2 opens its main window without a frame, expecting the theme
  // to draw one. Fusion uses the normal Windows title bar, like the original.
  tryCall('window.setFrameless', { frameless: false });
  const t0 = performance.now();
  await store.load();
  applyTheme();
  store.subscribe((k) => (k === 'dark' || k === 'accent') && applyTheme());

  await Promise.all([player.init(), playlists.init()]);
  await view.init();

  // Panels call each other through this object; members are filled in below.
  let content, settings, sidebar;
  const app = {
    toggleSettings(on = !settings.isOpen) {
      settings.open(on);
    },
    showPlaying() {
      if (!content.showPlaying()) view.setMode('nowplaying');
    },
    focusSearch() {
      if (store.get('sidebarCollapsed')) store.set('sidebarCollapsed', false);
      sidebar.focusSearch();
    },
    reload() {
      view.load();
    },
    escape() {
      if (settings.isOpen) return settings.open(false);
      const grid = content.current;
      if (grid?.expanded >= 0) return grid.collapse();
      if (view.drill) return view.closeDrill();
      if (view.filter) return view.setFilter('');
      if (view.selection.size) return view.clearSelection();
    },
  };

  const main = document.getElementById('main');
  const head = el('header.head');
  main.append(head);
  mountHeader(head);
  content = mountContent(main);
  settings = mountSettings(main, app);
  mountSelectionBar(main);
  mountInfoPanel(document.getElementById('info-panel'));
  sidebar = mountSidebar(document.getElementById('sidebar'));
  mountPlayerBar(document.getElementById('playerbar'), app);
  mountKeyboard(app);

  // Follow the playing track into view when it changes, if it's in this playlist.
  player.on('track', () => {
    if (view.mode === 'songs') content.showPlaying();
  });

  await view.load();
  document.body.classList.add('ready');
  logInfo(`ready in ${Math.round(performance.now() - t0)} ms, ${innerWidth}x${innerHeight} @${devicePixelRatio}x: ${view.playlist?.name} (${view.playlist?.trackCount} tracks, ${view.groups.length} groups)`, view.playlist);
  tryCall('window.setTitle', { title: 'foobar2000' });
}

function applyTheme() {
  const root = document.documentElement;
  const dark = !!store.get('dark');
  root.dataset.theme = dark ? 'dark' : 'light';
  const accent = store.get('accent') || '#107C10';
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-text', luminance(accent) > 0.6 ? '#111' : '#fff');
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

boot().catch((err) => {
  console.error('[fusion] failed to start:', err);
  document.body.append(el('pre.boot-error', { text: `Fusion failed to start:\n${err.stack || err}` }));
});
