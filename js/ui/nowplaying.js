// "Now playing": large artwork and details for the playing track, plus the
// playback queue (or, when the queue is empty, what plays next).

import { el, clear, formatTime } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall, call } from '../core/bridge.js';
import { player } from '../data/player.js';
import { nowPlayingUrl } from '../data/artwork.js';
import { playlists } from '../data/playlists.js';

const UP_NEXT = 25;

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
    this.offs = [player.on('track', () => this.render()), player.on('queue', () => this.renderList()), player.on('state', () => this.renderState())];
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
    this.title.textContent = active ? t.title || t.path.split(/[\\/]/).pop() : '';
    this.artist.textContent = active ? t.artist : '';
    this.album.textContent = active ? [t.album, (t.date || '').slice(0, 4)].filter(Boolean).join(' · ') : '';
    this.tech.textContent = active ? [t.codec, t.bitrate ? `${t.bitrate} kbps` : '', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '', t.duration ? formatTime(t.duration) : ''].filter(Boolean).join(' · ') : '';
    const url = active ? await nowPlayingUrl(480) : null;
    for (const img of [this.cover, this.bg]) {
      img.classList.remove('loaded');
      if (url) {
        img.onload = () => img.classList.add('loaded');
        img.onerror = () => img.removeAttribute('src');
        img.src = url;
      } else img.removeAttribute('src');
    }
    this.renderList();
  }

  renderState() {
    for (const node of this.list.querySelectorAll('.np-row.current .np-n')) node.replaceChildren(icon(player.state === 'paused' ? 'pause' : 'nowPlaying'));
  }

  async renderList() {
    let items = [];
    let fromQueue = false;
    if (player.queueCount) {
      const q = await tryCall('queue.get');
      items = (q?.items || []).map((t) => ({ t, queue: t.queueIndex }));
      fromQueue = true;
    } else if (player.active && player.playingPlaylist >= 0) {
      const start = Math.max(0, player.playingIndex);
      const res = await tryCall('playlist.getTracks', { playlist: player.playingPlaylist, start, count: UP_NEXT, fields: ['handle', 'title', 'artist', 'album', 'duration'] });
      items = (res?.tracks || []).map((t) => ({ t, row: t.index }));
    }
    const pl = playlists.list[player.playingPlaylist];
    const plName = playlists.isHidden(pl) ? 'Songs' : pl?.name;
    this.listTitle.textContent = fromQueue ? `Queue · ${items.length}` : items.length ? `Up next${plName ? ` from ${plName}` : ''}` : '';
    clear(this.list);
    items.forEach(({ t, queue, row }, n) => {
      const current = !fromQueue && row === player.playingIndex;
      const node = el(
        'div.np-row' + (current ? '.current' : ''),
        {
          ondblclick: () => (fromQueue ? playQueued(t) : call('playlist.playTrack', { playlist: player.playingPlaylist, index: row })),
          title: `${t.title} - ${t.artist}`,
        },
        el('span.np-n', null, current ? icon(player.state === 'paused' ? 'pause' : 'nowPlaying') : String(n + 1)),
        el('span.np-t.ellipsis', { text: t.title }),
        el('span.np-a.ellipsis', { text: t.artist }),
        el('span.np-al.ellipsis', { text: t.album }),
        el('span.np-l', { text: formatTime(t.duration) }),
        fromQueue ? el('button.btn-icon.np-x', { title: 'Remove from queue', onclick: () => call('queue.remove', { indices: [queue] }) }, icon('close')) : null,
      );
      this.list.append(node);
    });
  }
}

function playQueued(t) {
  if (t.playlist != null && t.playlistItem != null) return call('playlist.playTrack', { playlist: t.playlist, index: t.playlistItem });
  return call('playback.playPath', { path: t.handle });
}
