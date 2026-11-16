// Switches the main area between the tile grid, the song list and Now playing,
// and shows the empty-state messages from the original skin.

import { VERSION_KEYS } from '../data/versions.js';
import { redrawArt } from '../data/artwork.js';
import { el, clear } from '../core/util.js';
import { tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';
import { view, isPage } from '../data/view.js';
import { logInfo } from '../core/log.js';
import { player } from '../data/player.js';
import { playlists, COLLECTION } from '../data/playlists.js';
import { Grid } from './grid.js';
import { overlayScroll } from './oscroll.js';
import { FolderTree } from './foldertree.js';
import { SongList } from './songs.js';
import { NowPlaying } from './nowplaying.js';
import { StatsPage } from './stats.js';

export function mountContent(root) {
  const scroller = el('div.content', { tabindex: -1 });
  const message = el('div.message', { hidden: true });
  const loading = el('div.loading', { hidden: true, text: 'Loading…' });
  // A thin moving strip under the header while a load takes more than a
  // moment, so a slow regroup never looks like a freeze.
  const busy = el('div.busy-bar', { hidden: true });
  // Fusion draws its own slim scrollbar on top of the list, so the page (and
  // the open album's panel) can run all the way to the window's edge under
  // it, as in the original skin.
  root.append(scroller, message, loading, busy);
  overlayScroll(scroller, { onUpdate: () => (busy.style.top = scroller.offsetTop + 'px') });
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

  // Ctrl + mouse wheel resizes the album/artist art, as in the original skin
  // (instead of zooming the whole page).
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (currentKind !== 'grid') return;
      const key = view.mode === 'artists' && !view.drill ? 'artistTileSize' : 'tileSize';
      const [min, max] = key === 'artistTileSize' ? [100, 240] : [110, 260];
      const cur = store.get(key);
      const next = Math.max(min, Math.min(max, cur + (e.deltaY < 0 ? 10 : -10)));
      if (next !== cur) store.set(key, next); // the grid re-lays itself out on this
    },
    { passive: false },
  );

  // A click on empty space (not on a song, tile or control) clears the selection.
  scroller.addEventListener('click', (e) => {
    if (!view.selection.size || e.ctrlKey || e.shiftKey) return;
    if (e.target.closest('.song-row, .tp-row, .np-row, .ft-row, .tile, button, a, input, select, label, [role="button"], [role="tab"]')) return;
    view.clearSelection();
  });

  window.addEventListener('fusion:scrolltop', () => scroller.scrollTo({ top: 0, behavior: store.get('smoothScroll') ? 'smooth' : 'auto' }));

  function kindFor(mode) {
    return mode === 'songs' ? 'songs' : mode === 'nowplaying' ? 'nowplaying' : mode === 'stats' ? 'stats' : mode === 'folders' ? 'folders' : 'grid';
  }

  function ensure() {
    const kind = kindFor(view.mode);
    if (kind === currentKind && current) return false;
    current?.destroy();
    scroller.scrollTop = 0;
    current = kind === 'songs' ? new SongList(scroller) : kind === 'nowplaying' ? new NowPlaying(scroller) : kind === 'stats' ? new StatsPage(scroller) : kind === 'folders' ? new FolderTree(scroller) : new Grid(scroller);
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
    if (!isPage(currentKind)) current.setData(keep);
    // The page is blank while it loads; restore the place once it has content.
    if (!view.groups.length && !view.rows?.length && view.loading) {
      blankShown = !keep;
      renderMessage();
      return;
    }
    blankShown = false;
    if (pendingRestore === key) {
      const ret = view.returning;
      if (ret?.jump) {
        // Going to an album: straight there, already open, no scrolling. The
        // Collection can reload a few times on the way (a re-sort, foobar2000
        // refilling it), so the page stays hidden until it has settled.
        settleJump(key, ret);
        return;
      } else {
        if (scrollMemo.has(key)) {
          scroller.scrollTop = scrollMemo.get(key);
          current.render?.();
        }
        if (ret?.expandedKey) current.expandKey?.(ret.expandedKey);
      }
      pendingRestore = null;
      view.returning = null;
    }
    renderMessage();
  }

  let jumpTimer = 0;
  let jumpStarted = 0;
  let jumpBusyAt = 0; // last seen loading
  function settleJump(key, ret) {
    if (!jumpStarted) jumpStarted = jumpBusyAt = performance.now();
    scroller.classList.add('jumping');
    clearTimeout(jumpTimer);
    jumpTimer = setTimeout(() => {
      if (pendingRestore !== key || lastKey !== key) return finishJump();
      const now = performance.now();
      // The Collection can take a while on the way (re-sorted, refilled):
      // waited for, up to 12 s.
      const late = now - jumpStarted > 12000;
      if (view.loading) jumpBusyAt = now;
      if (view.loading && !late) return settleJump(key, ret);
      const found = current?.expandKey?.(ret.expandedKey, { jump: true });
      if (!found) {
        // Its tile has another key than the file gave: found by the song's row.
        if (ret.handle && !ret.byRow) {
          ret.byRow = true;
          view.albumKeyByRow(ret.handle).then((k) => {
            if (k && k !== ret.expandedKey) logInfo(`go to album: found by its song as ${k}`);
            if (k) ret.expandedKey = k;
            settleJump(key, ret);
          });
          return;
        }
        // Another reload may be on its way: a moment's grace after the last.
        if (!late && now - jumpBusyAt < 2500) return settleJump(key, ret);
        logInfo(`go to album: not found: ${ret.expandedKey} (${view.groups.length} albums, ${Math.round(now - jumpStarted)} ms)`);
      } else logInfo(`go to album: opened in ${Math.round(now - jumpStarted)} ms`);
      pendingRestore = null;
      view.returning = null;
      finishJump();
    }, 120);
  }
  function finishJump() {
    jumpStarted = 0;
    scroller.classList.remove('jumping');
    renderMessage();
  }

  function renderMessage() {
    loading.hidden = !(view.loading && currentKind === 'grid' && !view.groups.length) || scroller.classList.contains('jumping');
    if (isPage(currentKind) || view.loading) {
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
    // Songs: below the column headers, which would otherwise cover it.
    const head = show && scroller.querySelector('.song-head');
    if (head) {
      const r = (message.offsetParent || root).getBoundingClientRect();
      message.style.top = `${Math.round(head.getBoundingClientRect().bottom - r.top) + 32}px`;
    } else message.style.top = '';
  }

  view.on('change', onChange);
  view.on('mode', () => {
    ensure();
    if (isPage(view.mode)) renderMessage();
  });
  view.on('loading', renderMessage);
  view.on('heads', () => current?.refreshHeads?.());
  view.on('metadata', () => current?.refreshTracks?.());
  view.on('selection', () => current?.refreshSelection?.());
  player.on('track', () => current?.refreshPlaying?.());
  player.on('state', () => current?.refreshPlaying?.());
  store.subscribe((k) => {
    if (k === 'gifCovers') redrawArt();
    if (['tileSize', 'artistTileSize', 'showAlbumYear', 'showTrackCounts', 'listArtLeft', 'listBackground', 'dimEditionTags', 'dimWords', 'artistNoPicture', 'genreTiles', 'genreInfoFolder', ...VERSION_KEYS].includes(k) && current?.layout) {
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
