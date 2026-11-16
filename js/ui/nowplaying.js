// "Now playing": large artwork and details for the playing track, plus the
// playback queue (or, when the queue is empty, what plays next).

import { setTitle, setVersioned, versionText } from './titles.js';
import { smoothBackdrop } from './smoothbg.js';
import { trackVersions, VERSION_KEYS } from '../data/versions.js';
import * as store from '../core/store.js';
import { dragSource, dropTarget } from './dnd.js';
import { el, formatTime } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall, call } from '../core/bridge.js';
import { player, ORDER_LABELS } from '../data/player.js';
import { nowPlayingUrl, isRawUrl, refreshArt } from '../data/artwork.js';
import { playlists } from '../data/playlists.js';
import { contextMenu } from './menus.js';
import { shuffle } from '../data/shuffle.js';

const UP_NEXT = 50;
const PREVIOUS = 3; // songs played before the current one, shown dimmed (more on request)

export class NowPlaying {
  constructor(scroller) {
    this.scroller = scroller;
    this.bg = el('img.np-bg', { alt: '' });
    this.cover = el('img', { alt: '' });
    this.coverBox = el('div.art.ph-album.np-cover', null, this.cover);
    this.coverBox.addEventListener('contextmenu', (e) => {
      const handle = player.active && player.track?.handle;
      if (!handle) return;
      e.preventDefault();
      contextMenu({ mode: 'nowPlaying' }, [{ label: 'Refresh artwork', run: () => refreshArt([handle]) }]);
    });
    this.offStore = store.subscribe((k) => VERSION_KEYS.includes(k) && this.render());
    this.onArtRefresh = () => {
      this.artUrl = undefined;
      this.render();
    };
    window.addEventListener('fusion:artrefresh', this.onArtRefresh);
    this.title = el('h2.np-title');
    this.artist = el('div.np-artist');
    this.album = el('div.np-album');
    this.tech = el('div.np-tech');
    this.listTitle = el('h3.np-list-title');
    this.list = el('div.np-list');
    this.empty = el('div.np-empty', { text: 'Nothing is playing. Pick something from your collection.' });
    this.wrap = el(
      'div.nowplaying',
      null,
      el('div.np-hero', null, (this.bgWrap = el('div.np-bg-wrap', null, this.bg)), el('div.np-hero-inner', null, this.coverBox, el('div.np-info', null, this.title, this.artist, this.album, this.tech)), this.empty),
      el('div.np-queue', null, this.listTitle, this.list),
    );
    // Drawn without banding, faded out down the page (smoothbg.js).
    this.backdrop = smoothBackdrop(this.bg, this.bgWrap, { blur: 60, at: 1600, opacity: 0.45, bleed: 140, solid: 0.25 });
    scroller.append(this.wrap);
    this.offs = [player.on('track', () => this.render()), player.on('queue', () => this.renderList()), player.on('state', () => this.renderState()), player.on('order', () => this.renderList()), shuffle.on('change', () => this.renderList())];
    this.render();
  }

  destroy() {
    this.backdrop.destroy();
    this.offStore();
    window.removeEventListener('fusion:artrefresh', this.onArtRefresh);
    this.offs.forEach((off) => off());
    this.wrap.remove();
  }

  async render() {
    const t = player.track;
    const active = player.active && t;
    const v = active ? await trackVersions(t) : null;
    if (player.track !== t) return;
    this.empty.hidden = !!active;
    this.wrap.classList.toggle('idle', !active);
    this.title.title = setVersioned(this.title, active ? t.title || t.path.split(/[\\/]/).pop() : '', v?.title, 'titles');
    setVersioned(this.artist, active ? t.artist : '', active ? v?.artist : null, 'artists');
    this.album.textContent = active ? [versionText(t.album, v?.album, 'albums'), (t.date || '').slice(0, 4)].filter(Boolean).join(' · ') : '';
    this.tech.textContent = active ? [t.codec, t.bitrate ? `${t.bitrate} kbps` : '', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '', t.duration ? formatTime(t.duration) : ''].filter(Boolean).join(' · ') : '';
    this.renderList();
    const url = active ? await nowPlayingUrl(480, 'front', t?.handle) : null;
    if (url === this.artUrl) return;
    this.artUrl = url;
    if (!url) {
      for (const img of [this.cover, this.bg]) img.classList.remove('loaded'), img.removeAttribute('src');
      return;
    }
    // Decode the next cover before swapping, so the old one stays up until
    // then (no blank flash on Next/Previous).
    const pre = new Image();
    pre.src = url;
    try {
      await pre.decode();
    } catch {
      /* missing art: falls through to the placeholder */
    }
    if (this.artUrl !== url) return;
    // The old cover stays over the new one for a moment and fades out.
    if (this.cover.classList.contains('loaded') && this.cover.getAttribute('src') && pre.naturalWidth && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const ghost = this.cover.cloneNode(false);
      ghost.classList.add('np-cover-ghost');
      this.coverBox.append(ghost);
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, delay: 30, easing: 'ease-out', fill: 'forwards' }).finished.finally(() => ghost.remove());
    }
    for (const img of [this.cover, this.bg]) {
      if (pre.naturalWidth) {
        img.src = url;
        img.classList.toggle('alpha', isRawUrl(url));
        img.classList.add('loaded');
      } else {
        img.classList.remove('loaded');
        img.removeAttribute('src');
      }
    }
  }

  renderState() {
    for (const node of this.list.querySelectorAll('.np-row.current .np-n')) node.replaceChildren(icon(player.state === 'paused' ? 'pause' : 'nowPlaying'));
  }

  /**
   * The queue first (if any), then what foobar2000 plays after it, following
   * the playback order: Default stops at the end, Repeat (playlist) wraps,
   * Repeat (track) repeats. The shuffles are Fusion's own (shuffle.js), so
   * their order is listed; Random is foobar2000's, decided one song at a
   * time, so there's nothing to list ahead for that.
   */
  renderList() {
    // Several changes arrive together when a song changes (the song, the
    // queue, the shuffle): one redraw for all of them.
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => this.#renderList(), 40);
  }

  async #renderList() {
    const gen = (this.gen = (this.gen || 0) + 1);
    const q = player.queueCount ? await tryCall('queue.get') : null;
    // Fusion's own queued song (its shuffle feeding foobar2000) isn't shown
    // as queued: it's the first of the shuffle's songs listed below.
    const queue = (q?.items || []).filter((it) => !shuffle.isOurs(it));
    const order = player.order || 'default';
    const ours = shuffle.active && !!playlists.list.find((p) => p.guid === shuffle.guid);
    const shuffled = !ours && ['random', 'shuffle-tracks', 'shuffle-albums', 'shuffle-folders'].includes(order);
    // After the queue, foobar2000 carries on from the last queued song's place
    // in its playlist; with no queue, from the playing song.
    const last = queue[queue.length - 1];
    let basePl = last ? (last.playlist ?? -1) : player.active ? player.playingPlaylist : -1;
    let baseRow = last ? (last.playlistItem ?? -1) : player.playingIndex;
    if (ours) {
      basePl = playlists.list.findIndex((p) => p.guid === shuffle.guid);
      baseRow = Math.max(0, player.playingIndex);
    }
    const pl = playlists.list[basePl];
    let rows = [];
    let note = '';
    if (pl && baseRow >= 0) {
      if (ours) {
        const playingHere = basePl === player.playingPlaylist && player.playingIndex >= 0;
        rows = [...(!queue.length && playingHere ? [player.playingIndex] : []), ...shuffle.upcoming(UP_NEXT)];
      } else if (shuffled) note = `${ORDER_LABELS[order]} is on. foobar2000 keeps its shuffled order to itself, so what plays next can't be listed here.`;
      else if (order === 'repeat-track' && !queue.length) note = 'Repeat (track) is on: this song plays again.';
      else {
        const n = pl.trackCount;
        const from = queue.length ? baseRow + 1 : baseRow; // include the playing song when there's no queue
        for (let i = 0; i < UP_NEXT && rows.length < n; i++) {
          let r = from + i;
          if (r >= n) {
            if (order !== 'repeat-playlist') break;
            r %= n;
          }
          rows.push(r);
        }
      }
      if (!ours && (shuffled || order === 'repeat-track')) rows = !queue.length && basePl === player.playingPlaylist && player.playingIndex >= 0 ? [player.playingIndex] : [];
    }
    const res = rows.length ? await tryCall('playlist.getTracksAt', { playlist: basePl, rows, fields: ['handle', 'title', 'artist', 'album', 'duration'] }) : null;
    if (gen !== this.gen) return;
    const tracks = res?.tracks || [];
    const plName = playlists.isHidden(pl) ? 'Songs' : pl?.name;

    // What played before, dimmed, above the current song (any order): the
    // last few, or all that are kept when asked.
    const history = queue.length ? [] : player.history.filter((h) => h.handle !== player.track?.handle);
    const prev = history.slice(-(this.allPrevious ? history.length : PREVIOUS));

    const out = [];
    if (history.length > PREVIOUS) {
      const more = history.length - PREVIOUS;
      out.push(
        el('button.np-earlier', {
          type: 'button',
          dataset: { key: 'earlier' },
          text: this.allPrevious ? 'Hide earlier songs' : `Show ${more} earlier ${more === 1 ? 'song' : 'songs'}`,
          onclick: () => {
            this.allPrevious = !this.allPrevious;
            this.#renderList();
          },
        }),
      );
    }
    prev.forEach((t, n) =>
      out.push(
        this.#row(t, {
          kind: 'prev',
          index: t.index,
          number: n - prev.length,
          previous: true,
          queue,
          onplay: () => (t.playlist >= 0 && t.index >= 0 ? call('playlist.playTrack', { playlist: t.playlist, index: t.index }) : call('playback.playPath', { path: t.handle })),
        }),
      ),
    );
    this.listTitle.textContent = queue.length ? `Queue · ${queue.length}` : tracks.length || note ? `Up next${plName ? ` from ${plName}` : ''}` : '';
    const editable = pl && !pl.isLocked && !pl.isAutoplaylist;
    queue.forEach((t, n) => out.push(this.#row(t, { kind: 'queue', index: n, number: n + 1, queue, onplay: () => playQueued(t, n) })));
    if (queue.length && (tracks.length || note)) out.push(el('h3.np-list-title.np-then', { dataset: { key: 'then' }, text: `Then from ${plName || 'the playlist'}` }));
    if (note) out.push(el('div.np-note', { dataset: { key: 'note' }, text: note }));
    let number = 0;
    tracks.forEach((t, n) => {
      const row = rows[n];
      const current = basePl === player.playingPlaylist && row === player.playingIndex && !queue.length && n === 0;
      // Fusion's shuffle: its upcoming songs can be dragged into another order.
      const movable = ours && !current;
      out.push(this.#row(t, { kind: movable ? 'shuffle' : 'pl', index: row, number: current ? 0 : ++number, current, queue, playlist: pl, editable: editable || movable, onplay: () => call('playlist.playTrack', { playlist: basePl, index: row }) }));
    });
    this.#swap(out);
  }

  /**
   * Put the new rows in, all at once. A song that was already listed slides
   * from where it was to where it is now (Next moves the list up a row
   * instead of redrawing it); new ones fade in.
   */
  #swap(nodes) {
    const before = new Map();
    const had = this.list.children.length > 0;
    for (const n of this.list.children) if (n.dataset.key) before.set(n.dataset.key, n.getBoundingClientRect().top);
    // A song can be listed twice (played before and coming up): key each
    // occurrence on its own.
    const seen = new Map();
    for (const n of nodes) {
      if (!n.dataset.key) continue;
      const c = (seen.get(n.dataset.key) || 0) + 1;
      seen.set(n.dataset.key, c);
      if (c > 1) n.dataset.key += '#' + c;
    }
    this.list.replaceChildren(...nodes);
    if (!had || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const n of nodes) {
      const was = before.get(n.dataset.key);
      if (was == null) {
        n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
        continue;
      }
      const dy = was - n.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5 && Math.abs(dy) < 2000) n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  }

  #row(t, o) {
    const node = el(
      'div.row.np-row' + (o.current ? '.current' : '') + (o.previous ? '.previous' : ''),
      {
        ondblclick: o.onplay,
        title: `${t.title} - ${t.artist}`,
        // foobar2000's own track menu (Properties, tagging, and so on).
        oncontextmenu: (e) => {
          e.preventDefault();
          const extra = [{ label: 'Refresh artwork', run: () => refreshArt([t.handle]) }];
          // Queued and coming-up songs: play from there on (in place of
          // foobar2000's Play, which plays just the one song).
          if (!o.current && !o.previous) extra.unshift({ label: 'Play from here', replaces: 'Play', run: o.onplay });
          if (o.current) contextMenu({ mode: 'nowPlaying' }, extra);
          else contextMenu({ mode: 'handles', handles: [t.handle] }, extra);
        },
      },
      el('span.np-n', null, o.current ? icon(player.state === 'paused' ? 'pause' : 'nowPlaying') : o.previous ? '' : String(o.number)),
      el('span.np-t.ellipsis', null),
      el('span.np-a.ellipsis', { text: t.artist }),
      el('span.np-al.ellipsis', { text: t.album }),
      el('span.np-l', { text: formatTime(t.duration) }),
      o.kind === 'queue' ? el('button.btn-icon.np-x', { title: 'Remove from queue', onclick: () => call('queue.remove', { indices: [o.index] }) }, icon('close')) : el('span'),
    );
    setTitle(node.children[1], t.title);
    node.dataset.key = t.handle;
    node.dataset.kind = o.kind;
    node.dataset.index = o.index;
    // Drag to reorder the queue, drag a song into the queue, or reorder an
    // ordinary (unlocked) playlist.
    if (!o.previous) {
      dragSource(node, () => ({ type: 'np', kind: o.kind, index: o.index, playlistGuid: o.playlist?.guid, label: t.title }));
      dropTarget(node, {
        accept: (d) => d.type === 'np' && (o.kind === 'queue' || (o.kind === 'pl' && o.editable && d.kind === 'pl' && d.playlistGuid === o.playlist?.guid) || (o.kind === 'shuffle' && d.kind === 'shuffle')),
        over: (d, info) => (info.after ? 'after' : 'before'),
        drop: async (src, info) => {
          const queue = o.queue;
          if (o.kind === 'queue') {
            // Rebuild the queue with the dragged song at the drop position.
            const refs = queue.map((_, i) => ({ queueIndex: i }));
            let at = o.index + (info.after ? 1 : 0);
            let moving;
            if (src.kind === 'queue') {
              moving = refs.splice(src.index, 1)[0];
              if (src.index < at) at--;
            } else moving = { playlistGuid: src.playlistGuid, item: src.index };
            if (!moving?.playlistGuid && moving?.queueIndex == null) return;
            refs.splice(at, 0, moving);
            await tryCall('queue.setContents', { items: refs });
          } else if (o.kind === 'shuffle') {
            // Fusion's shuffle order: the song moves before or after this one.
            shuffle.move(src.index, o.index, !!info.after);
          } else {
            let target = o.index + (info.after ? 1 : 0);
            if (src.index < target) target--;
            if (target !== src.index) await tryCall('playlist.moveTracks', { playlistGuid: src.playlistGuid, items: [src.index], delta: target - src.index });
            this.renderList();
          }
        },
      });
    }
    return node;
  }
}


/**
 * Double-click in the queue: play from that song on. The songs before it
 * are skipped (taken off the queue); the ones after it stay queued.
 */
async function playQueued(t, n) {
  try {
    if (n > 0) await call('queue.remove', { indices: Array.from({ length: n }, (_, i) => i) });
    await call('queue.playNow', { index: 0 });
  } catch {
    // Older host without queue.playNow: play the song itself.
    if (t.playlist != null && t.playlistItem != null) return call('playlist.playTrack', { playlist: t.playlist, index: t.playlistItem });
    return call('playback.playPath', { path: t.handle });
  }
}
