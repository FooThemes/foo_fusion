// Main-area header: playlist title + actions, view tabs, sort, counts.

import { el, clear, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { SORTS, VIEW_SORTS } from '../core/store.js';
import { call } from '../core/bridge.js';
import { view, isPage } from '../data/view.js';
import { player, ORDER_LABELS } from '../data/player.js';
import { playlists } from '../data/playlists.js';
import { addToItems, renamePlaylist, deletePlaylist } from './menus.js';
import { dropdown } from './dropdown.js';
import { editArtist, editGenre } from './infoeditor.js';
import { editAutoplaylist } from './autoplaylist.js';
import { tabBar } from './tabs.js';

const TABS = [
  ['albums', 'Albums'],
  ['artists', 'Artists'],
  ['genres', 'Genres'],
  ['folders', 'Folders'],
  ['songs', 'Songs'],
];

export function mountHeader(root, app) {
  const showSide = el('button.btn-icon.head-side', { title: 'Show the left panel', onclick: () => app.toggleSidebar(true) }, icon('menu'));
  const back = el('button.btn-icon.head-back', { title: 'Back', onclick: () => view.closeDrill() }, icon('back'));
  const title = el('h1.head-title.ellipsis');
  const actions = el('div.head-actions');
  const sortBtn = el('button.sort-btn', { onclick: sortMenu });
  const dirBtn = el('button.btn-icon.dir-btn', { onclick: () => view.setSort(view.currentSortKey(), !store.get('sortDescending')) });
  const count = el('span.head-count');
  const tabs = tabBar(TABS, {
    label: 'Show',
    // The tab already showing: back to the top of it.
    onPick: (mode) => (mode === view.mode && !view.drill ? window.dispatchEvent(new CustomEvent('fusion:scrolltop')) : view.setMode(mode)),
  });
  const tools = el('div.head-tools', null, tabs.node, sortBtn, dirBtn, count);

  root.append(el('div.head-row', null, showSide, back, title, actions), tools);


  function render() {
    const pl = view.playlist;
    const np = view.mode === 'nowplaying';
    const page = isPage(view.mode);
    back.hidden = !view.drill || page;
    showSide.hidden = !store.get('sidebarHidden');
    title.textContent = np ? 'Now playing' : view.mode === 'stats' ? 'Listening stats' : view.drill ? view.drill.label : view.filter ? `Results for "${view.filter}"` : pl?.name || 'No playlist';

    clear(actions);
    if (np) {
      actions.append(
        textBtn('queue', 'Clear queue', () => call('queue.clear'), !player.userQueueCount),
        textBtn('shuffle', `Order: ${ORDER_LABELS[player.order]}`, orderMenu),
      );
    } else if (page) {
      /* the stats page has its own controls */
    } else if (pl) {
      const has = pl.trackCount > 0;
      actions.append(textBtn('play', 'Play all', () => view.play(view.rowAt(0)), !has || view.total === 0));
      actions.append(textBtn('shuffle', 'Shuffle all', shuffleAll, !has));
      if (view.total) actions.append(textBtn('add', 'Add to', (e) => addAll(e), !has));
      // An artist's or genre's page: edit its information and pictures.
      if (view.drill) {
        const d = view.drill;
        if (d.kind === 'artists') actions.append(textBtn('edit', 'Edit artist', () => editArtist(d.key, view.groups.find((g) => g.head?.handle)?.head.handle)));
        if (d.kind === 'genres') actions.append(textBtn('edit', 'Edit genre', () => editGenre(d.key)));
      }
      // Collection and Favourites are Fusion's own: nothing to change there.
      else if (pl.isAutoplaylist && !playlists.isSpecial(pl)) actions.append(textBtn('autoplaylist', 'Properties', () => editAutoplaylist(pl)));
      if (!playlists.isSpecial(pl) && !view.drill) {
        actions.append(textBtn('rename', 'Rename', () => renamePlaylist(pl)));
        actions.append(textBtn('delete', 'Delete', () => deletePlaylist(pl)));
      }
    }

    tools.hidden = page;
    tabs.set(view.mode);
    const sortKey = view.currentSortKey();
    // Folders are listed by name, within their folder: "folder", fixed (like
    // Artists and Genres, which have one order each).
    const sortLabel = view.mode === 'folders' && !view.drill ? 'folder' : (SORTS[sortKey]?.label || 'Album').toLowerCase();
    clear(sortBtn).append(el('span.sort-label', { text: 'Sort by ' }), el('span.sort-value', { text: sortLabel }), icon('chevronDown'));
    const sortable = view.canSort();
    sortBtn.disabled = VIEW_SORTS[view.drill ? 'albums' : view.mode]?.length < 2 || !sortable;
    sortBtn.title = sortable ? '' : 'This autoplaylist keeps its own order. Change it in the autoplaylist settings.';
    dirBtn.disabled = !view.playlist;
    const desc = store.get('sortDescending');
    clear(dirBtn).append(icon(desc ? 'sortDesc' : 'sortAsc'));
    dirBtn.title = desc ? 'Descending' : 'Ascending';

    count.textContent = countText();
  }

  function countText() {
    if (view.loading && !view.groups.length && view.mode !== 'songs') return 'Loading…';
    const n = view.groups.length;
    if (view.mode === 'songs') return view.total ? plural(view.total, 'song') : 'empty';
    if (view.mode === 'folders') return view.tree ? `${plural(view.tree.folders.length, 'folder')} · ${plural(view.total, 'song')}` : '';
    if (view.drill || view.mode === 'albums') return n ? plural(n, 'album') : '';
    if (view.mode === 'artists') return n ? plural(n, 'artist') : '';
    if (view.mode === 'genres') return n ? plural(n, 'genre') : '';
    return '';
  }

  function sortMenu(e) {
    const keys = VIEW_SORTS[view.drill ? 'albums' : view.mode] || [];
    const cur = view.currentSortKey();
    dropdown(e.currentTarget, keys.map((k) => ({ label: SORTS[k].label, checked: k === cur, run: () => view.setSort(k) })));
  }

  function orderMenu(e) {
    // Default | repeats | Random | shuffles (as the play bar's menu).
    const items = Object.entries(ORDER_LABELS).flatMap(([k, label]) => [...(k === 'repeat-playlist' || k === 'random' || k === 'shuffle-tracks' ? ['-'] : []), { label, checked: player.order === k, run: () => player.setOrder(k) }]);
    dropdown(e.currentTarget, items);
  }

  async function shuffleAll() {
    await player.setOrder('shuffle-tracks');
    const n = view.total;
    if (n) view.play(view.rowAt(Math.floor(Math.random() * n)));
  }

  function addAll(e) {
    const rows = view.rows || (view.groups.length ? view.groups.flatMap((g) => view.groupRows(g)) : Array.from({ length: view.total }, (_, i) => i));
    dropdown(e.currentTarget, addToItems(rows));
  }

  view.on('change', render);
  view.on('loading', render);
  view.on('mode', render);
  view.on('filter', render);
  player.on('queue', render);
  player.on('order', render);
  playlists.on('change', render);
  store.subscribe((k) => (k === 'sortDescending' || k === 'sidebarHidden') && render());
  render();
}

function textBtn(iconName, label, onclick, disabled = false) {
  return el('button.btn-text', { onclick, disabled }, icon(iconName), el('span', { text: label }));
}
