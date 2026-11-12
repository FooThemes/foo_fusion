// Bottom bar: now-playing art and text, seek bar, transport, volume, menu.

import { setVersioned } from './titles.js';
import { trackVersions, VERSION_KEYS } from '../data/versions.js';
import { el, formatTime, clamp } from '../core/util.js';
import { tryCall } from '../core/bridge.js';
import { icon, setIcon } from '../core/icons.js';
import * as store from '../core/store.js';
import { player, ORDER_LABELS } from '../data/player.js';
import { nowPlayingUrl, isRawUrl, refreshArt } from '../data/artwork.js';
import { view } from '../data/view.js';
import { playlists } from '../data/playlists.js';
import { showAppMenu, contextMenu } from './menus.js';
import { dropdown } from './dropdown.js';
import { heartButton, setHeart } from './heart.js';
import { favourites } from '../data/favourites.js';
import { mountWaveform, prefetchWave } from './waveform.js';

export function mountPlayerBar(root, app) {
  const cover = el('img', { alt: '' });
  const coverBox = el('button.art.ph-album.pb-cover', { title: 'Show now playing', onclick: () => app.showPlaying() }, cover);
  // Long names scroll back and forth instead of staying cut off.
  const titleText = el('span.mq');
  const artistText = el('span.mq');
  const title = el('div.pb-title.mq-box', null, titleText);
  const artist = el('div.pb-artist.mq-box', null, artistText);
  const heart = heartButton('', '');
  heart.classList.add('pb-heart');
  const nowBox = el('div.pb-now', null, coverBox, el('div.pb-text', null, title, artist));
  // The title opens the song's album, the artist their page (both from the Collection).
  titleText.addEventListener('click', async () => {
    const t = player.track;
    const key = t && (await view.albumKeyOf(t.handle));
    if (key) view.goTo('albums', key);
  });
  artistText.addEventListener('click', async () => {
    const t = player.track;
    if (!t) return;
    const v = await trackVersions(t);
    const name = artistPage(t, v);
    if (name) view.goTo('artists', name);
  });

  const elapsed = el('span.pb-time');
  const length = el('span.pb-time');
  const fill = el('div.seek-fill');
  const knob = el('div.seek-knob');
  const seek = el('div.seek', { role: 'slider', 'aria-label': 'Seek', tabindex: 0 }, el('div.seek-track', null, fill, knob));
  const seekBox = el('div.pb-seek', null, elapsed, seek, length);
  const wave = mountWaveform(seek);

  const orderBtn = el('button.btn-icon.pb-order', { title: 'Playback order', onclick: orderMenu }, icon('shuffle'));
  const prev = el('button.btn-icon', { title: 'Previous', onclick: () => player.previous() }, icon('prev'));
  const play = el('button.pb-play', { title: 'Play', onclick: () => player.playOrPause() }, icon('play'));
  const next = el('button.btn-icon', { title: 'Next', onclick: () => player.next() }, icon('next'));
  const volBtn = el('button.btn-icon', { title: 'Volume', onclick: toggleVolume }, icon('volume'));
  // Lyrics: opens the track info panel on its Lyrics tab (or closes it).
  const lyricsBtn = el(
    'button.btn-icon.pb-lyrics',
    {
      title: 'Lyrics',
      onclick: () => {
        const showing = store.get('infoPanel') && store.get('infoTab') === 'lyrics';
        if (!showing) store.set('infoTab', 'lyrics');
        store.set('infoPanel', !showing);
      },
    },
    icon('lyrics'),
  );
  const markLyrics = () => lyricsBtn.classList.toggle('on', !!store.get('infoPanel') && store.get('infoTab') === 'lyrics');
  store.subscribe((k) => (k === 'infoPanel' || k === 'infoTab') && markLyrics());
  markLyrics();
  // The original's "…" opened the settings panel; right-click keeps the menu.
  const more = el('button.btn-icon', { 'data-settings-toggle': '', title: 'Settings (right-click for the menu)', onclick: () => app.toggleSettings(), oncontextmenu: (e) => (e.preventDefault(), mainMenu()) }, icon('more'));
  const controls = el('div.pb-controls', null, heart, orderBtn, prev, play, next, lyricsBtn, volBtn, more);

  const volFill = el('div.vol-fill');
  const volTrack = el('div.vol-track', null, volFill);
  const volValue = el('div.vol-value');
  const volPop = el('div.vol-pop', { hidden: true }, volValue, el('div.vol-slider', { role: 'slider', 'aria-label': 'Volume', tabindex: 0 }, volTrack), el('button.btn-icon.vol-mute', { title: 'Mute', onclick: () => player.toggleMute() }, icon('mute')));

  root.append(nowBox, seekBox, controls, volPop);

  function marquee(box) {
    box.classList.remove('marquee');
    const over = box.scrollWidth - box.clientWidth;
    if (over <= 2) return;
    box.style.setProperty('--mq-dist', -over - 8 + 'px');
    box.style.setProperty('--mq-dur', Math.max(8, (over / 30) * 2 + 5) + 's');
    box.classList.add('marquee');
  }
  new ResizeObserver(() => [title, artist].forEach(marquee)).observe(nowBox);

  // Hover card for the playing song, placed above the bar (there's no room
  // below it) and kept inside the window.
  let tipText = '';
  let tipTimer = 0;
  const tip = el('div.pb-tip', { hidden: true });
  document.body.append(tip);
  const textBox = nowBox.querySelector('.pb-text');
  textBox.addEventListener('pointerenter', () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (!tipText) return;
      tip.textContent = tipText;
      tip.hidden = false;
      const r = textBox.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
      tip.style.top = r.top - tip.offsetHeight - 10 + 'px';
    }, 500);
  });
  textBox.addEventListener('pointerleave', () => {
    clearTimeout(tipTimer);
    tip.hidden = true;
  });

  // foobar2000's own menu for the playing song (Properties and so on).
  nowBox.addEventListener('contextmenu', (e) => {
    if (!player.active) return;
    e.preventDefault();
    tip.hidden = true;
    const handle = player.track?.handle;
    contextMenu({ mode: 'nowPlaying' }, handle ? [{ label: 'Refresh artwork', run: () => refreshArt([handle]) }] : []);
  });
  store.subscribe((k) => VERSION_KEYS.includes(k) && renderTrack());
  window.addEventListener('fusion:artrefresh', () => {
    artTrack = undefined;
    renderTrack();
  });

  // Click the length to switch between total time and time remaining.
  length.title = 'Click to show the time remaining';
  length.addEventListener('click', () => {
    store.set('showRemaining', !store.get('showRemaining'));
    renderTime(true);
  });

  // --- now playing text and art -------------------------------------------
  let artTrack = null;
  async function renderTrack() {
    const t = player.track;
    const on = player.active && t;
    // The waveform first: it's the slowest part.
    wave.track(on ? t.handle : null);
    if (on) prefetchNext();
    // Original / English / romanised versions, when the song has them.
    const v = on ? await trackVersions(t) : null;
    if (player.track !== t) return;
    root.classList.toggle('idle', !on);
    const tip = setVersioned(titleText, on ? t.title || t.path.split(/[\\/]/).pop() : '', v?.title, 'titles');
    setVersioned(artistText, on ? t.artist : '', on ? v?.artist : null, 'artists');
    tipText = on ? [t.title, t.artist, t.album].filter(Boolean).join('\n') + (tip ? `\n\n${tip}` : '') : '';
    requestAnimationFrame(() => [title, artist].forEach(marquee));
    heart.dataset.handle = on ? t.handle : '';
    heart.hidden = !on;
    if (on) favourites.load([t.handle]).then(([state]) => heart.dataset.handle === t.handle && setHeart(heart, state));
    const key = on ? t.handle : null;
    if (key === artTrack) return;
    artTrack = key;
    cover.classList.remove('loaded');
    const url = on ? await nowPlayingUrl(64, 'front', t?.handle) : null;
    if (artTrack !== key) return;
    if (url) {
      cover.onload = () => cover.classList.add('loaded');
      cover.src = url;
      cover.classList.toggle('alpha', isRawUrl(url));
    } else cover.removeAttribute('src');
    updateBigArt(url ? await nowPlayingUrl(store.get('sidebarWidth'), 'front', player.track?.handle) : null);
  }

  // Optional large artwork above the bar, in the left panel ("Large now playing artwork").
  const bigArt = el('img', { alt: '' });
  const bigBox = el('div.art.ph-album.big-art', { hidden: true, onclick: () => app.showPlaying() }, bigArt);
  document.getElementById('sidebar').append(bigBox);
  // Slides open and shut (its height) instead of popping in and out.
  let bigTimer = 0;
  // Changing track stops playback for a moment ("stopped", then the next
  // song): closing waits a little, so it stays open between songs.
  let shutTimer = 0;
  function showBig(on, wait = false) {
    clearTimeout(shutTimer);
    if (!on && wait && !bigBox.hidden && !bigBox.classList.contains('shut')) {
      shutTimer = setTimeout(() => shutBig(), 700);
      return;
    }
    if (on === !bigBox.classList.contains('shut') && !bigBox.hidden) return;
    clearTimeout(bigTimer);
    if (on) {
      bigBox.classList.add('shut');
      bigBox.hidden = false;
      void bigBox.offsetHeight; // start from shut
      bigBox.classList.remove('shut');
    } else shutBig();
  }
  function shutBig() {
    if (bigBox.hidden) return;
    bigBox.classList.add('shut');
    clearTimeout(bigTimer);
    bigTimer = setTimeout(() => (bigBox.hidden = true), 260);
  }
  function updateBigArt(url) {
    const wanted = !!store.get('largeNowPlayingArt') && !store.get('sidebarCollapsed');
    const on = wanted && player.active;
    showBig(on, wanted);
    if (url) {
      // The old cover stays until the new one is ready (no blank in between).
      const next = new Image();
      next.onload = () => {
        if (bigArt.dataset.want !== url) return;
        bigArt.src = url;
        bigArt.classList.toggle('alpha', isRawUrl(url));
        bigArt.classList.add('loaded');
      };
      bigArt.dataset.want = url;
      next.src = url;
    } else if (!on) {
      // Nothing playing: the picture goes once the panel has shut.
      bigArt.dataset.want = '';
    } else {
      bigArt.dataset.want = '';
      bigArt.classList.remove('loaded');
      bigArt.removeAttribute('src');
    }
  }

  function renderState() {
    const playing = player.state === 'playing';
    setIcon(play.querySelector('.icon'), playing ? 'pause' : 'play');
    play.title = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', play.title);
    const nothing = !player.active && !(playlists.activePlaylist?.trackCount > 0);
    play.disabled = nothing;
    prev.disabled = next.disabled = !player.active;
    root.classList.toggle('idle', !player.active);
    seekBox.classList.toggle('disabled', !player.active || !player.canSeek);
    renderTime(true);
  }

  // --- time: interpolate between the host's 1 Hz updates ------------------
  let dragging = false;
  let lastQuarter = -1;
  // Called every animation frame while playing; only touches the DOM when the
  // shown value can change (4 times a second).
  function renderTime(force = false) {
    if (dragging) return;
    const q = Math.floor(player.now() * 4);
    if (q === lastQuarter && !force) return;
    lastQuarter = q;
    const d = player.duration;
    const p = player.now();
    elapsed.textContent = player.active ? formatTime(p) : '';
    const remaining = store.get('showRemaining');
    length.textContent = player.active ? (d ? (remaining ? '-' + formatTime(Math.max(0, d - p)) : formatTime(d)) : '') : '';
    length.title = remaining ? 'Time remaining (click for the total)' : 'Total time (click for the time remaining)';
    setSeek(d ? p / d : 0);
  }
  function setSeek(frac) {
    frac = clamp(frac, 0, 1);
    fill.style.transform = `scaleX(${frac})`;
    knob.style.left = frac * 100 + '%';
    wave.progress(frac);
    seek.setAttribute('aria-valuenow', Math.round(frac * 100));
  }
  // The next two songs' waveforms, straight after this one's (in playlist
  // order; with shuffle the next song isn't known).
  let nextTimer = 0;
  function prefetchNext() {
    clearTimeout(nextTimer);
    if (!store.get('waveformSeekbar')) return;
    nextTimer = setTimeout(async () => {
      if (player.order !== 'default' && player.order !== 'repeat-playlist') return;
      if (player.playingPlaylist < 0 || player.playingIndex < 0) return;
      const res = await tryCall('playlist.getTracksAt', { playlist: player.playingPlaylist, rows: [player.playingIndex + 1, player.playingIndex + 2], fields: ['handle'] });
      prefetchWave(...(res?.tracks || []).map((t) => t?.handle));
    }, 800);
  }
  let raf = 0;
  function tick() {
    renderTime();
    raf = player.state === 'playing' && !document.hidden ? requestAnimationFrame(tick) : 0;
  }
  function startTicking() {
    if (!raf && player.state === 'playing') raf = requestAnimationFrame(tick);
  }
  seek.addEventListener('pointerdown', (e) => {
    if (!player.active || !player.canSeek || !player.duration) return;
    dragging = true;
    seek.setPointerCapture(e.pointerId);
    const rect = seek.getBoundingClientRect();
    const frac = (ev) => clamp((ev.clientX - rect.left) / rect.width, 0, 1);
    const move = (ev) => {
      setSeek(frac(ev));
      elapsed.textContent = formatTime(frac(ev) * player.duration);
    };
    const up = (ev) => {
      seek.removeEventListener('pointermove', move);
      seek.removeEventListener('pointerup', up);
      dragging = false;
      player.seek(frac(ev) * player.duration);
    };
    move(e);
    seek.addEventListener('pointermove', move);
    seek.addEventListener('pointerup', up);
  });
  seek.addEventListener('keydown', (e) => {
    if (!player.active) return;
    if (e.key === 'ArrowRight') player.seek(Math.min(player.duration, player.now() + 5));
    if (e.key === 'ArrowLeft') player.seek(Math.max(0, player.now() - 5));
  });

  // --- volume --------------------------------------------------------------
  function renderVolume() {
    const v = player.muted ? 0 : player.volume;
    volFill.style.transform = `scaleY(${v / 100})`;
    volValue.textContent = Math.round(v);
    setIcon(volBtn.querySelector('.icon'), player.muted || v === 0 ? 'mute' : 'volume');
  }
  function toggleVolume() {
    volPop.hidden = !volPop.hidden;
    if (!volPop.hidden) {
      const r = volBtn.getBoundingClientRect();
      volPop.style.left = r.left + r.width / 2 - 30 + 'px';
      setTimeout(() => document.addEventListener('mousedown', closeVolume), 0);
    }
  }
  function closeVolume(e) {
    if (volPop.contains(e.target) || volBtn.contains(e.target)) return;
    volPop.hidden = true;
    document.removeEventListener('mousedown', closeVolume);
  }
  const volSlider = volPop.querySelector('.vol-slider');
  volSlider.addEventListener('pointerdown', (e) => {
    volSlider.setPointerCapture(e.pointerId);
    const rect = volTrack.getBoundingClientRect();
    const val = (ev) => clamp((rect.bottom - ev.clientY) / rect.height, 0, 1) * 100;
    const move = (ev) => {
      volFill.style.transform = `scaleY(${val(ev) / 100})`;
      volValue.textContent = Math.round(val(ev));
      player.setVolume(val(ev));
    };
    const up = () => {
      volSlider.removeEventListener('pointermove', move);
      volSlider.removeEventListener('pointerup', up);
    };
    move(e);
    volSlider.addEventListener('pointermove', move);
    volSlider.addEventListener('pointerup', up);
  });
  volSlider.addEventListener('wheel', (e) => player.setVolume(clamp(player.volume - Math.sign(e.deltaY) * 5, 0, 100)), { passive: true });
  volBtn.addEventListener('wheel', (e) => player.setVolume(clamp(player.volume - Math.sign(e.deltaY) * 5, 0, 100)), { passive: true });

  // --- playback order ------------------------------------------------------
  function renderOrder() {
    const o = player.order;
    setIcon(orderBtn.querySelector('.icon'), o === 'repeat-track' ? 'repeatOne' : o.startsWith('repeat') ? 'repeat' : 'shuffle');
    orderBtn.classList.toggle('on', o !== 'default');
    orderBtn.title = `Playback order: ${ORDER_LABELS[o]}`;
  }
  function orderMenu(e) {
    // Default | repeats | Random | shuffles.
    const items = Object.entries(ORDER_LABELS).flatMap(([k, label]) => [...(k === 'repeat-playlist' || k === 'random' || k === 'shuffle-tracks' ? ['-'] : []), { label, checked: player.order === k, run: () => player.setOrder(k) }]);
    dropdown(e.currentTarget, items, { align: 'right' });
  }

  // --- main menu (replaces the hidden foobar2000 menu bar) -----------------
  async function mainMenu() {
    return showAppMenu(app);
  }
  player.on('track', renderTrack);
  favourites.on('change', ({ handles, state }) => handles.includes(heart.dataset.handle) && setHeart(heart, state));
  // Lets CSS animate the "now playing" bars only while audio is playing.
  const markPlayback = () => (document.documentElement.dataset.playback = player.state || 'stopped');
  markPlayback();
  player.on('state', () => {
    markPlayback();
    renderState();
    startTicking();
    if (!player.active) renderTrack();
  });
  player.on('time', () => {
    renderTime(true);
    startTicking();
  });
  player.on('volume', renderVolume);
  player.on('order', renderOrder);
  playlists.on('active', renderState);
  view.on('change', renderState);
  store.subscribe((k) => {
    if (k === 'waveformSeekbar') wave.show(store.get('waveformSeekbar'), player.active ? player.track?.handle : null);
    else if (k === 'accent' || k === 'dark') requestAnimationFrame(wave.redraw);
  });
  wave.show(store.get('waveformSeekbar'), player.active ? player.track?.handle : null);
  store.subscribe((k) => (k === 'largeNowPlayingArt' || k === 'sidebarCollapsed') && ((artTrack = null), renderTrack()));
  document.addEventListener('visibilitychange', startTicking);

  renderTrack();
  renderState();
  renderVolume();
  renderOrder();
  startTicking();
}

/**
 * Whose page the play bar's artist opens: the song's artist, or the album
 * artist when the song has several ("A feat. B", "A & B"). Original names
 * (not "宇多田ヒカル (Hikaru Utada)"), as the Artists tab lists them.
 */
function artistPage(t, v) {
  const artist = v?.artist?.orig || t.artist || '';
  const several = /\s(feat\.?|ft\.?|featuring|with|x|vs\.?)\s|\s&\s|[,;]|、/i.test(artist);
  if (!several) return artist;
  return v?.albumArtist?.orig || t.albumArtist || (t.artists && t.artists[0]) || artist;
}
