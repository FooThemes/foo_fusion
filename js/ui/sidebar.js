// Left panel: title, search, Collection / Favorites / Now playing, playlists.

import { el, clear, debounce, clamp } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { playlists, COLLECTION, FAVORITES } from '../data/playlists.js';
import { player } from '../data/player.js';
import { view, isPage } from '../data/view.js';
import { playingGuid } from '../data/playing.js';
import { playlistMenu, folderMenu } from './menus.js';
import { folders } from '../data/folders.js';
import { newPlaylistDialog } from './autoplaylist.js';
import { draggablePlaylist, playlistDropTarget, folderDropTarget, draggableFolder } from './dnd.js';

export function mountSidebar(root, app) {
  const search = el('input.search-input', {
    type: 'search',
    placeholder: 'Search',
    spellcheck: false,
    'aria-label': 'Search this playlist',
  });
  const searchBox = el('div.search', null, search, el('button.search-btn', { title: 'Search', onclick: () => search.focus() }, icon('search')));

  // Leaving Now playing for another playlist: switch tab without loading the
  // old playlist first (that briefly showed its covers).
  const leaveNowPlaying = (name) => {
    if (!isPage(view.mode)) return;
    const tab = store.get('view');
    view.setMode(isPage(tab) ? 'albums' : tab, { load: playlists.activePlaylist?.name === name });
  };
  const navCollection = navItem('collection', 'Collection', () => {
    leaveNowPlaying(COLLECTION);
    playlists.ensureCollection();
  });
  const navFavorites = navItem('heart', 'Favourites', () => {
    leaveNowPlaying(FAVORITES);
    playlists.ensureFavorites();
  });
  const queueBadge = el('span.badge', { hidden: true });
  const navNow = navItem('nowPlaying', 'Now playing', () => view.setMode('nowplaying'), queueBadge);
  const navStats = navItem('stats', 'Listening stats', () => view.setMode('stats'));
  const newPlaylist = navItem('add', 'New playlist', () => newPlaylistDialog());
  newPlaylist.classList.add('nav-new');
  const manage = el('button.btn-icon.side-manage', { 'data-plm-toggle': '', title: 'Playlist manager (Ctrl+M)', onclick: () => app.togglePlaylistManager() }, icon('playlist'));
  const newRow = el('div.side-newrow', null, newPlaylist, manage);

  const list = el('div.pl-list', { role: 'listbox', 'aria-label': 'Playlists' });

  const toggle = el('button.btn-icon.side-toggle', { title: 'Collapse or expand the left panel', onclick: () => store.set('sidebarCollapsed', !store.get('sidebarCollapsed')) }, icon('menu'));

  root.append(
    el('div.side-head', null, toggle, el('div.side-title', { text: 'foobar2000' })),
    searchBox,
    el('div.side-sep'),
    el('nav.side-nav', null, navCollection, navFavorites, navNow, navStats),
    el('div.side-sep'),
    newRow,
    list,
  );

  // Search always looks through the whole Collection, whichever playlist
  // (or Now playing) was showing.
  const searchFor = async (text) => {
    if (text && (isPage(view.mode) || playlists.activePlaylist?.name !== COLLECTION)) {
      leaveNowPlaying(COLLECTION);
      await playlists.ensureCollection();
    }
    view.setFilter(text);
  };
  const runSearch = debounce(() => searchFor(search.value.trim()), 250);
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      view.setFilter('');
      search.blur();
    } else if (e.key === 'Enter') {
      runSearch.cancel();
      searchFor(search.value.trim());
    }
    e.stopPropagation();
  });
  view.on('filter', (t) => {
    if (search.value.trim() !== t) search.value = t;
  });

  function render() {
    const active = playlists.active;
    const np = isPage(view.mode);
    const coll = playlists.byName(COLLECTION);
    const fav = playlists.byName(FAVORITES);
    const pg = playingGuid();
    setState(navCollection, !np && coll && coll.index === active, coll && coll.guid === pg);
    navFavorites.hidden = false;
    setState(navFavorites, !np && fav && fav.index === active, fav && fav.guid === pg);
    setState(navNow, view.mode === 'nowplaying', false);
    setState(navStats, view.mode === 'stats', false);
    navCollection.title = coll ? `${COLLECTION} - ${coll.trackCount.toLocaleString()} songs` : 'Collection';

    clear(list);
    const showCounts = store.get('showPlaylistCounts');
    const item = (p, nested) => {
      const row = el(
        'button.pl-item' + (nested ? '.nested' : ''),
        {
          role: 'option',
          title: `${p.name} - ${p.trackCount.toLocaleString()} songs`,
          onclick: () => {
            if (isPage(view.mode)) view.setMode(isPage(store.get('view')) ? 'albums' : store.get('view'), { load: p.index === playlists.active });
            playlists.activate(p.index);
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            playlistMenu(p);
          },
        },
        icon(p.isAutoplaylist ? 'autoplaylist' : 'playlist'),
        el('span.label.ellipsis', { text: p.name }),
        showCounts ? el('span.count', { text: p.trackCount.toLocaleString() }) : null,
      );
      setState(row, !np && p.index === active, p.guid === pg);
      row.setAttribute('aria-selected', String(!np && p.index === active));
      draggablePlaylist(row, p);
      playlistDropTarget(row, () => playlists.list.find((x) => x.guid === p.guid));
      return row;
    };
    for (const node of folders.rows()) {
      if (node.type === 'playlist') {
        if (!playlists.isSpecial(node.p)) {
          const row = item(node.p, node.depth > 0);
          row.style.setProperty('--depth', node.depth);
          list.append(row);
        }
        continue;
      }
      const f = node.folder;
      const head = el(
        'button.pl-item.pl-folder',
        { title: `${f.name} - ${node.members.length} playlists`, 'aria-expanded': String(!f.collapsed), onclick: () => folders.toggle(f.id), oncontextmenu: (e) => (e.preventDefault(), folderMenu(f)) },
        icon(f.collapsed ? 'chevronRight' : 'chevronDown', 'chev'),
        icon('folder'),
        el('span.label.ellipsis', { text: f.name }),
        node.members.some((m) => m.guid === pg) ? el('span.dot') : null,
      );
      head.style.setProperty('--depth', node.depth);
      draggableFolder(head, f);
      folderDropTarget(head, f);
      list.append(head);
    }
  }

  function renderQueue() {
    queueBadge.hidden = !player.queueCount;
    queueBadge.textContent = player.queueCount;
  }

  function applyWidth() {
    const collapsed = store.get('sidebarCollapsed');
    document.body.classList.toggle('side-collapsed', collapsed);
    document.body.classList.toggle('no-sidebar', !!store.get('sidebarHidden'));
    document.documentElement.style.setProperty('--sidebar-w', collapsed ? '56px' : clamp(store.get('sidebarWidth'), 180, 480) + 'px');
  }

  playlists.on('change', render);
  // The playing playlist's mark follows playback itself.
  const renderSoon = debounce(render, 50);
  player.on('track', renderSoon);
  player.on('state', renderSoon);
  folders.on('change', render);
  playlists.on('active', render);
  view.on('mode', render);
  player.on('queue', renderQueue);
  store.subscribe((k) => {
    if (k === 'sidebarCollapsed' || k === 'sidebarWidth' || k === 'sidebarHidden') applyWidth();
    if (k === 'showPlaylistCounts') render();
  });
  applyWidth();
  render();
  renderQueue();
  // Animate the panel's width only after the first layout (not on start).
  setTimeout(() => document.body.classList.add('animate-layout'), 800);

  // Drag the divider to resize the panel (like the original's playlist manager).
  const resizer = document.getElementById('sidebar-resizer');
  resizer.addEventListener('pointerdown', (e) => {
    if (store.get('sidebarCollapsed')) return;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-sidebar');
    const move = (ev) => document.documentElement.style.setProperty('--sidebar-w', clamp(ev.clientX, 180, 480) + 'px');
    const up = (ev) => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-sidebar');
      store.set('sidebarWidth', clamp(ev.clientX, 180, 480));
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });

  return { focusSearch: () => search.focus() };
}

function navItem(iconName, label, onclick, extra) {
  return el('button.nav-item', { onclick, title: label }, icon(iconName), el('span.label.ellipsis', { text: label }), extra);
}

function setState(node, active, playing) {
  node.classList.toggle('active', !!active);
  node.classList.toggle('playing', !!playing && !active);
}
