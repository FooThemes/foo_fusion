// Bottom bar: now-playing art and text, seek bar, transport, volume, menu.

import { setTitle } from './titles.js';
import { el, formatTime, clamp } from '../core/util.js';
import { icon, setIcon } from '../core/icons.js';
import * as store from '../core/store.js';
import { player, ORDER_LABELS } from '../data/player.js';
import { nowPlayingUrl } from '../data/artwork.js';
import { view } from '../data/view.js';
import { playlists } from '../data/playlists.js';
import { showMenu, showAppMenu } from './menus.js';
import { tryCall } from '../core/bridge.js';
import { heartButton, setHeart } from './heart.js';
import { favourites } from '../data/favourites.js';
import { mountWaveform } from './waveform.js';

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
  const nowBox = el('div.pb-now', null, coverBox, el('div.pb-text', null, title, artist), heart);

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
  // The original's "…" opened the settings panel; right-click keeps the menu.
  const more = el('button.btn-icon', { title: 'Settings (right-click for the menu)', onclick: () => app.toggleSettings(), oncontextmenu: (e) => (e.preventDefault(), mainMenu()) }, icon('more'));
  const controls = el('div.pb-controls', null, orderBtn, prev, play, next, volBtn, more);

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
    tryCall('menu.showNativePopup', { mode: 'nowPlaying' });
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
    root.classList.toggle('idle', !on);
    setTitle(titleText, on ? t.title || t.path.split(/[\\/]/).pop() : '');
    artistText.textContent = on ? t.artist : '';
    tipText = on ? [t.title, t.artist, t.album].filter(Boolean).join('\n') : '';
    requestAnimationFrame(() => [title, artist].forEach(marquee));
    heart.dataset.handle = on ? t.handle : '';
    heart.hidden = !on;
    wave.track(on ? t.handle : null);
    if (on) favourites.load([t.handle]).then(([state]) => heart.dataset.handle === t.handle && setHeart(heart, state));
    const key = on ? t.handle : null;
    if (key === artTrack) return;
    artTrack = key;
    cover.classList.remove('loaded');
    const url = on ? await nowPlayingUrl(64) : null;
    if (artTrack !== key) return;
    if (url) {
      cover.onload = () => cover.classList.add('loaded');
      cover.src = url;
    } else cover.removeAttribute('src');
    updateBigArt(url ? await nowPlayingUrl(store.get('sidebarWidth')) : null);
  }

  // Optional large artwork above the bar, in the left panel ("Large now playing artwork").
  const bigArt = el('img', { alt: '' });
  const bigBox = el('div.art.ph-album.big-art', { hidden: true, onclick: () => app.showPlaying() }, bigArt);
  document.getElementById('sidebar').append(bigBox);
  function updateBigArt(url) {
    bigBox.hidden = !store.get('largeNowPlayingArt') || !player.active || store.get('sidebarCollapsed');
    bigArt.classList.remove('loaded');
    if (url) {
      bigArt.onload = () => bigArt.classList.add('loaded');
      bigArt.src = url;
    } else bigArt.removeAttribute('src');
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
  function orderMenu() {
    showMenu(Object.entries(ORDER_LABELS).map(([k, label]) => ({ label, checked: player.order === k, run: () => player.setOrder(k) })));
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
