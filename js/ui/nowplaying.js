// "Now playing": large artwork and details for the playing track, plus the
// playback queue (or, when the queue is empty, what plays next).

import { setTitle } from './titles.js';
import { afterDrag } from './dnd.js';
import { el, clear, formatTime } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall, call } from '../core/bridge.js';
import { player, ORDER_LABELS } from '../data/player.js';
import { nowPlayingUrl } from '../data/artwork.js';
import { playlists } from '../data/playlists.js';

const UP_NEXT = 25;
const PREVIOUS = 2; // songs played before the current one, shown dimmed

export class NowPlaying {
  constructor(scroller) {
    this.scroller = scroller;
    this.bg = el('img.np-bg', { alt: '' });
    this.cover = el('img', { alt: '' });
    this.coverBox = el('div.art.ph-album.np-cover', null, this.cover);
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
      el('div.np-hero', null, el('div.np-bg-wrap', null, this.bg), el('div.np-hero-inner', null, this.coverBox, el('div.np-info', null, this.title, this.artist, this.album, this.tech)), this.empty),
      el('div.np-queue', null, this.listTitle, this.list),
    );
    scroller.append(this.wrap);
    this.offs = [player.on('track', () => this.render()), player.on('queue', () => this.renderList()), player.on('state', () => this.renderState()), player.on('order', () => this.renderList())];
    this.render();
  }

  destroy() {
    this.offs.forEach((off) => off());
    this.wrap.remove();
  }

  async render() {
    const t = player.track;
    const active = player.active && t;
    this.empty.hidden = !!active;
    this.wrap.classList.toggle('idle', !active);
    setTitle(this.title, active ? t.title || t.path.split(/[\\/]/).pop() : '');
    this.artist.textContent = active ? t.artist : '';
    this.album.textContent = active ? [t.album, (t.date || '').slice(0, 4)].filter(Boolean).join(' · ') : '';
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
    for (const img of [this.cover, this.bg]) {
      if (pre.naturalWidth) {
        img.src = url;
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
   * Repeat (track) repeats. Shuffle and Random are decided by foobar2000 one
   * song at a time, so there's nothing to list ahead for those.
   */
  async renderList() {
    const gen = (this.gen = (this.gen || 0) + 1);
    const q = player.queueCount ? await tryCall('queue.get') : null;
    const queue = q?.items || [];
    const order = player.order || 'default';
    const shuffled = ['random', 'shuffle-tracks', 'shuffle-albums', 'shuffle-folders'].includes(order);
    // After the queue, foobar2000 carries on from the last queued song's place
    // in its playlist; with no queue, from the playing song.
    const last = queue[queue.length - 1];
    const basePl = last ? (last.playlist ?? -1) : player.active ? player.playingPlaylist : -1;
    const baseRow = last ? (last.playlistItem ?? -1) : player.playingIndex;
    const pl = playlists.list[basePl];
    let rows = [];
    let note = '';
    if (pl && baseRow >= 0) {
      if (shuffled) note = `${ORDER_LABELS[order]} is on. foobar2000 keeps its shuffled order to itself, so what plays next can't be listed here.`;
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
      if (shuffled || order === 'repeat-track') rows = !queue.length && basePl === player.playingPlaylist && player.playingIndex >= 0 ? [player.playingIndex] : [];
    }
    const res = rows.length ? await tryCall('playlist.getTracksAt', { playlist: basePl, rows, fields: ['handle', 'title', 'artist', 'album', 'duration'] }) : null;
    if (gen !== this.gen) return;
    const tracks = res?.tracks || [];
    const plName = playlists.isHidden(pl) ? 'Songs' : pl?.name;

    // What played before, dimmed, above the current song (any order).
    const prev = queue.length ? [] : player.history.slice(-PREVIOUS).filter((h) => h.handle !== player.track?.handle);

    clear(this.list);
    prev.forEach((t, n) =>
      this.list.append(
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
    queue.forEach((t, n) => this.list.append(this.#row(t, { kind: 'queue', index: n, number: n + 1, queue, onplay: () => playQueued(t) })));
    if (queue.length && (tracks.length || note)) this.list.append(el('h3.np-list-title.np-then', { text: `Then from ${plName || 'the playlist'}` }));
    if (note) this.list.append(el('div.np-note', { text: note }));
    tracks.forEach((t, n) => {
      const row = rows[n];
      const current = basePl === player.playingPlaylist && row === player.playingIndex;
      this.list.append(this.#row(t, { kind: 'pl', index: row, number: n + 1, current, queue, playlist: pl, editable, onplay: () => call('playlist.playTrack', { playlist: basePl, index: row }) }));
    });
  }

  #row(t, o) {
    const node = el(
      'div.np-row' + (o.current ? '.current' : '') + (o.previous ? '.previous' : ''),
      {
        draggable: !o.previous,
        ondblclick: o.onplay,
        title: `${t.title} - ${t.artist}`,
        // foobar2000's own track menu (Properties, tagging, and so on).
        oncontextmenu: (e) => {
          e.preventDefault();
          if (o.current) tryCall('menu.showNativePopup', { mode: 'nowPlaying' });
          else tryCall('menu.showNativePopup', { mode: 'handles', handles: [t.handle] });
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
    node.dataset.kind = o.kind;
    node.dataset.index = o.index;
    // Drag to reorder the queue, drag a song into the queue, or reorder an
    // ordinary (unlocked) playlist.
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(NP_MIME, JSON.stringify({ kind: o.kind, index: o.index, playlistGuid: o.playlist?.guid }));
    });
    node.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(NP_MIME) || o.previous) return;
      if (o.kind === 'pl' && !o.editable) return;
      e.preventDefault();
      const after = e.offsetY > node.offsetHeight / 2;
      node.classList.toggle('drop-before', !after);
      node.classList.toggle('drop-after', after);
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
    node.addEventListener('drop', async (e) => {
      const after = node.classList.contains('drop-after');
      node.classList.remove('drop-before', 'drop-after');
      const raw = e.dataTransfer.getData(NP_MIME);
      if (!raw) return;
      e.preventDefault();
      const src = JSON.parse(raw);
      const queue = o.queue;
      await afterDrag(() => {});
      if (o.kind === 'queue') {
        // Rebuild the queue with the dragged song at the drop position.
        const refs = queue.map((_, i) => ({ queueIndex: i }));
        let at = o.index + (after ? 1 : 0);
        let moving;
        if (src.kind === 'queue') {
          moving = refs.splice(src.index, 1)[0];
          if (src.index < at) at--;
        } else moving = { playlistGuid: src.playlistGuid, item: src.index };
        if (!moving?.playlistGuid && moving?.queueIndex == null) return;
        refs.splice(at, 0, moving);
        await tryCall('queue.setContents', { items: refs });
      } else if (src.kind === 'pl' && o.editable && src.playlistGuid === o.playlist.guid) {
        let target = o.index + (after ? 1 : 0);
        if (src.index < target) target--;
        if (target !== src.index) await tryCall('playlist.moveTracks', { playlistGuid: src.playlistGuid, items: [src.index], delta: target - src.index });
        this.renderList();
      }
    });
    return node;
  }
}

const NP_MIME = 'application/x-fusion-np';

function playQueued(t) {
  if (t.playlist != null && t.playlistItem != null) return call('playlist.playTrack', { playlist: t.playlist, index: t.playlistItem });
  return call('playback.playPath', { path: t.handle });
}
