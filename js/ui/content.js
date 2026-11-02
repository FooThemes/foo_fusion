// Switches the main area between the tile grid, the song list and Now playing,
// and shows the empty-state messages from the original skin.

import { el, clear } from '../core/util.js';
import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';
import { view } from '../data/view.js';
import { player } from '../data/player.js';
import { playlists, COLLECTION } from '../data/playlists.js';
import { Grid } from './grid.js';
import { SongList } from './songs.js';
import { NowPlaying } from './nowplaying.js';

export function mountContent(root) {
  const scroller = el('div.content', { tabindex: -1 });
  const message = el('div.message', { hidden: true });
  const loading = el('div.loading', { hidden: true, text: 'Loading…' });
  // A thin moving strip under the header while a load takes more than a
  // moment, so a slow regroup never looks like a freeze.
  const busy = el('div.busy-bar', { hidden: true });
  root.append(scroller, message, loading, busy);
  let busyTimer = 0;
  view.on('loading', (on) => {
    clearTimeout(busyTimer);
    if (on) busyTimer = setTimeout(() => (busy.hidden = false), 120);
    else busy.hidden = true;
  });

  let current = null;
  let currentKind = '';
  let lastKey = '';
  const scrollMemo = new Map(); // view key -> scrollTop
  let pendingRestore = null; // key whose scroll position to restore once loaded
  let blankShown = false; // the current key is only showing the blank loading page

  // A click on empty space (not on a song, tile or control) clears the selection.
  scroller.addEventListener('click', (e) => {
    if (!view.selection.size || e.ctrlKey || e.shiftKey) return;
    if (e.target.closest('.song-row, .tp-row, .np-row, .tile, button, a, input, select, label, [role="button"], [role="tab"]')) return;
    view.clearSelection();
  });

  function kindFor(mode) {
    return mode === 'songs' ? 'songs' : mode === 'nowplaying' ? 'nowplaying' : 'grid';
  }

  function ensure() {
    const kind = kindFor(view.mode);
    if (kind === currentKind && current) return false;
    current?.destroy();
    scroller.scrollTop = 0;
    current = kind === 'songs' ? new SongList(scroller) : kind === 'nowplaying' ? new NowPlaying(scroller) : new Grid(scroller);
    currentKind = kind;
    scroller.dataset.kind = kind;
    return true;
  }

  function onChange() {
    const fresh = ensure();
    const key = [view.playlist?.guid, view.mode, view.drill?.key, view.filter, store.get('separateDiscs')].join('|');
    const keep = !fresh && key === lastKey;
    // Back from an artist/genre goes to where you were in the list.
    const cameBack = !keep && !view.drill && lastKey.startsWith(key.split('|').slice(0, 2).join('|') + '|') && lastKey.split('|')[2];
    if (!keep && lastKey && !fresh && !blankShown) scrollMemo.set(lastKey, scroller.scrollTop);
    lastKey = key;
    if (cameBack || view.returning) pendingRestore = key;
    if (currentKind !== 'nowplaying') current.setData(keep);
    // The page is blank while it loads; restore the place once it has content.
    if (!view.groups.length && !view.rows?.length && view.loading) {
      blankShown = !keep;
      renderMessage();
      return;
    }
    blankShown = false;
    if (pendingRestore === key) {
      pendingRestore = null;
      const ret = view.returning;
      view.returning = null;
      if (scrollMemo.has(key)) {
        scroller.scrollTop = scrollMemo.get(key);
        current.render?.();
      }
      if (ret?.expandedKey) current.expandKey?.(ret.expandedKey);
    }
    renderMessage();
  }

  function renderMessage() {
    loading.hidden = !(view.loading && currentKind === 'grid' && !view.groups.length);
    if (currentKind === 'nowplaying' || view.loading) {
      message.hidden = true;
      return;
    }
    const pl = view.playlist;
    clear(message);
    let show = true;
    if (!pl) {
      message.append(el('h2', { text: 'No playlist selected.' }));
    } else if (pl.trackCount === 0) {
      if (pl.name === COLLECTION) {
        message.append(
          el('h2', { text: 'Your media library is empty (no music found).' }),
          el('button.btn-primary', { text: 'Configure the media library', onclick: () => tryCall('config.showLibraryPreferences') }),
        );
      } else {
        message.append(el('h2', { text: "It's lonely in here. Add songs from your collection, or drag some files here." }));
      }
    } else if (view.filter && view.total === 0) {
      message.append(el('h2', { text: "Sorry, we've got no results to show." }));
    } else show = false;
    message.hidden = !show;
  }

  view.on('change', onChange);
  view.on('mode', () => {
    ensure();
    if (view.mode === 'nowplaying') renderMessage();
  });
  view.on('loading', renderMessage);
  view.on('heads', () => current?.refreshHeads?.());
  view.on('metadata', () => current?.refreshTracks?.());
  view.on('selection', () => current?.refreshSelection?.());
  player.on('track', () => current?.refreshPlaying?.());
  player.on('state', () => current?.refreshPlaying?.());
  store.subscribe((k) => {
    if (['tileSize', 'artistTileSize', 'showAlbumYear', 'showTrackCounts', 'listArtLeft', 'listBackground', 'dimEditionTags', 'dimWords'].includes(k) && current?.layout) {
      if (current.expanded >= 0) current.panel.open(view.groups[current.expanded], current.expanded);
      current.layout();
      current.refreshHeads();
    }
  });
  playlists.on('change', renderMessage);

  return {
    scroller,
    get current() {
      return current;
    },
    /** Scroll to the playing track (if it is in the shown playlist). */
    showPlaying() {
      if (player.playingPlaylist !== view.playlist?.index || player.playingIndex < 0) return false;
      current?.showRow?.(player.playingIndex);
      return true;
    },
  };
}
