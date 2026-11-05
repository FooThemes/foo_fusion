// Main-area header: playlist title + actions, view tabs, sort, counts.

import { el, clear, plural } from '../core/util.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import { SORTS, VIEW_SORTS } from '../core/store.js';
import { call } from '../core/bridge.js';
import { view } from '../data/view.js';
import { player, ORDER_LABELS } from '../data/player.js';
import { playlists } from '../data/playlists.js';
import { showMenu, addToItems, renamePlaylist, deletePlaylist } from './menus.js';
import { editAutoplaylist } from './autoplaylist.js';

const TABS = [
  ['albums', 'Albums'],
  ['artists', 'Artists'],
  ['genres', 'Genres'],
  ['songs', 'Songs'],
];

export function mountHeader(root, app) {
  const showSide = el('button.btn-icon.head-side', { title: 'Show the left panel', onclick: () => app.toggleSidebar(true) }, icon('menu'));
  const back = el('button.btn-icon.head-back', { title: 'Back', onclick: () => view.closeDrill() }, icon('back'));
  const title = el('h1.head-title.ellipsis');
  const actions = el('div.head-actions');
  const tabs = el('div.tabs', { role: 'tablist' });
  const sortBtn = el('button.sort-btn', { onclick: sortMenu });
  const dirBtn = el('button.btn-icon.dir-btn', { onclick: () => view.setSort(view.currentSortKey(), !store.get('sortDescending')) });
  const count = el('span.head-count');
  const tools = el('div.head-tools', null, tabs, sortBtn, dirBtn, count);

  root.append(el('div.head-row', null, showSide, back, title, actions), tools);

  for (const [mode, label] of TABS) {
    tabs.append(el('button.tab', { role: 'tab', dataset: { mode }, onclick: () => view.setMode(mode) }, label));
  }

  function render() {
    const pl = view.playlist;
    const np = view.mode === 'nowplaying';
    back.hidden = !view.drill || np;
    showSide.hidden = !store.get('sidebarHidden');
    title.textContent = np ? 'Now playing' : view.drill ? view.drill.label : view.filter ? `Results for "${view.filter}"` : pl?.name || 'No playlist';

    clear(actions);
    if (np) {
      actions.append(
        textBtn('queue', 'Clear queue', () => call('queue.clear'), !player.queueCount),
        textBtn('shuffle', `Order: ${ORDER_LABELS[player.order]}`, orderMenu),
      );
    } else if (pl) {
      const has = pl.trackCount > 0;
      actions.append(textBtn('play', 'Play all', () => view.play(view.rowAt(0)), !has || view.total === 0));
      actions.append(textBtn('shuffle', 'Shuffle all', shuffleAll, !has));
      if (view.total) actions.append(textBtn('add', 'Add to', () => addAll(), !has));
      // Collection and Favourites are Fusion's own: nothing to change there.
      if (pl.isAutoplaylist && !playlists.isSpecial(pl)) actions.append(textBtn('autoplaylist', 'Properties', () => editAutoplaylist(pl)));
      if (!playlists.isSpecial(pl)) {
        actions.append(textBtn('rename', 'Rename', () => renamePlaylist(pl)));
        actions.append(textBtn('delete', 'Delete', () => deletePlaylist(pl)));
      }
    }

    tools.hidden = np;
    for (const t of tabs.children) {
      const on = t.dataset.mode === view.mode;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    const sortKey = view.currentSortKey();
    clear(sortBtn).append(el('span.sort-label', { text: 'Sort by ' }), el('span.sort-value', { text: (SORTS[sortKey]?.label || 'Album').toLowerCase() }), icon('chevronDown'));
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
    if (view.drill || view.mode === 'albums') return n ? plural(n, 'album') : '';
    if (view.mode === 'artists') return n ? plural(n, 'artist') : '';
    if (view.mode === 'genres') return n ? plural(n, 'genre') : '';
    return '';
  }

  function sortMenu() {
    const keys = VIEW_SORTS[view.drill ? 'albums' : view.mode] || [];
    const cur = view.currentSortKey();
    showMenu(keys.map((k) => ({ label: SORTS[k].label, checked: k === cur, run: () => view.setSort(k) })));
  }

  function orderMenu() {
    showMenu(Object.entries(ORDER_LABELS).map(([k, label]) => ({ label, checked: player.order === k, run: () => player.setOrder(k) })));
  }

  async function shuffleAll() {
    await player.setOrder('shuffle-tracks');
    const n = view.total;
    if (n) view.play(view.rowAt(Math.floor(Math.random() * n)));
  }

  function addAll() {
    const rows = view.rows || (view.groups.length ? view.groups.flatMap((g) => view.groupRows(g)) : Array.from({ length: view.total }, (_, i) => i));
    showMenu(addToItems(rows));
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
