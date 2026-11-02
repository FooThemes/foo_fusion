// Autoplaylist properties dialog, modelled on foobar2000's own: name, query
// pattern, sort pattern and "Force-sorted". The "?" buttons open foobar2000's
// bundled help pages (doc\Query Syntax Help.html, doc\titleformat_help.html)
// right inside the dialog instead of in a browser.
//
// foobar2000 keeps each autoplaylist's query and sort in the playlist's
// properties (profile\playlists-v2.0\playlist-<GUID>-props.sqlite), which
// foo_ui_webview2 doesn't expose, so Fusion reads that file directly. If it
// can't, it falls back to what it remembers, then to foobar2000's own editor.

import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { call, tryCall } from '../core/bridge.js';
import * as store from '../core/store.js';
import { playlists, COLLECTION, FAVORITES } from '../data/playlists.js';
import { toast } from './toast.js';

const HELP = {
  query: { file: 'Query Syntax Help.html', title: 'Query syntax' },
  sort: { file: 'titleformat_help.html', title: 'Title formatting' },
};
const helpCache = new Map();

// The standard autoplaylist manager's client GUID, {51B653F4-A2D7-4810-99BD-06724712175A},
// as stored (little-endian) at the start of the property blob, followed by
// the query and sort pattern as length-prefixed UTF-8 strings.
const CLIENT = [0xf4, 0x53, 0xb6, 0x51, 0xd7, 0xa2, 0x10, 0x48, 0x99, 0xbd, 0x06, 0x72, 0x47, 0x12, 0x17, 0x5a];

/** Read an autoplaylist's stored definition from its properties file. */
export async function readDefinition(p) {
  const prof = await tryCall('misc.getProfilePath');
  const dir = (prof?.path || prof?.value || '').replace(/[\\/]$/, '');
  if (!dir || !p?.guid) return null;
  const base = `${dir}\\playlists-v2.0\\playlist-${p.guid.replace(/[{}]/g, '').toUpperCase()}-props.sqlite`;
  // A newer copy can sit in the write-ahead log until SQLite checkpoints it.
  for (const path of [`${base}-wal`, base]) {
    const res = await tryCall('file.read', { path, encoding: 'binary' });
    if (!res?.content) continue;
    const def = parseDefinition(base64Bytes(res.content));
    if (def) return def;
  }
  return null;
}

function base64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Find the last stored definition in the bytes (the latest write wins). */
function parseDefinition(bytes) {
  const dec = new TextDecoder();
  const u32 = (o) => bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
  let found = null;
  outer: for (let i = 4; i + 24 <= bytes.length; i++) {
    for (let k = 0; k < 16; k++) if (bytes[i + k] !== CLIENT[k]) continue outer;
    let o = i + 16;
    const qlen = u32(o);
    if (qlen <= 0 || qlen > 65536 || o + 4 + qlen > bytes.length) continue;
    const query = dec.decode(bytes.subarray(o + 4, o + 4 + qlen));
    o += 4 + qlen;
    const slen = o + 4 <= bytes.length ? u32(o) : 0;
    const sort = slen > 0 && slen < 65536 && o + 4 + slen <= bytes.length ? dec.decode(bytes.subarray(o + 4, o + 4 + slen)) : '';
    found = { query, sort, keepSorted: (u32(i - 4) & 1) === 1 };
  }
  return found;
}

/** What Fusion knows about an autoplaylist's definition, or null. */
export function knownDefinition(p) {
  const saved = store.get('autoplaylists')[p.guid];
  if (saved) return saved;
  if (p.name === COLLECTION) return { query: 'ALL', sort: '', keepSorted: true, managed: true };
  if (p.name === FAVORITES) return { query: store.get('favouritesQuery'), sort: '', keepSorted: true, managed: true };
  return null;
}

function remember(guid, def) {
  store.update('autoplaylists', { [guid]: { query: def.query, sort: def.sort, keepSorted: def.keepSorted } });
}

/** New autoplaylist. */
export async function newAutoplaylist() {
  const def = await showDialog({ title: 'New autoplaylist', name: '', query: '', sort: '', keepSorted: false });
  if (!def) return;
  const res = await tryCall('playlist.createAutoplaylist', { name: def.name || def.query, query: def.query, sort: def.sort, keepSorted: def.keepSorted });
  if (!res) return toast("foobar2000 didn't accept that query");
  remember(res.guid, def);
  await playlists.refresh();
  playlists.activate(res.index);
}

/** Edit an existing autoplaylist (falls back to foobar2000's editor). */
export async function editAutoplaylist(p) {
  const known = (await readDefinition(p)) || knownDefinition(p);
  const def = await showDialog({
    title: 'Autoplaylist properties',
    name: p.name,
    nameLocked: playlists.isSpecial(p),
    query: known?.query ?? '',
    sort: known?.sort ?? '',
    keepSorted: known?.keepSorted ?? false,
    unknown: !known,
    playlist: p,
  });
  if (!def) return;
  const pl = playlists.list.find((x) => x.guid === p.guid);
  if (!pl) return;
  if (def.name && def.name !== pl.name && !playlists.isSpecial(pl)) await tryCall('playlist.rename', { playlistGuid: pl.guid, name: def.name });
  // Re-create the autoplaylist on the same playlist with the new definition.
  const released = await tryCall('playlist.removeAutoplaylist', { playlistGuid: pl.guid });
  if (!released || released.source === 'dui') {
    toast("This autoplaylist can only be changed in foobar2000's own editor");
    return tryCall('playlist.showAutoplaylistUI', { playlistGuid: pl.guid });
  }
  const res = await tryCall('playlist.convertToAutoplaylist', { playlistGuid: pl.guid, query: def.query, sort: def.sort, keepSorted: def.keepSorted });
  if (!res) return toast("foobar2000 didn't accept that query");
  if (pl.name === FAVORITES) store.set('favouritesQuery', def.query);
  else if (pl.name !== COLLECTION) remember(pl.guid, def);
}

function showDialog(opts) {
  return new Promise((resolve) => {
    const root = document.getElementById('overlay-root');
    const name = el('input.dialog-input', { type: 'text', value: opts.name, spellcheck: false, disabled: !!opts.nameLocked, placeholder: 'Uses the query if left empty' });
    const query = el('input.dialog-input.mono', { type: 'text', value: opts.query, spellcheck: false, placeholder: 'e.g. GENRE HAS rock AND %rating% GREATER 3' });
    // Collection and Favorites are kept in the view's order by Fusion's Sort
    // menu, so their sort fields are shown but not editable here.
    const managed = !!opts.playlist && playlists.isSpecial(opts.playlist);
    const sort = el('input.dialog-input.mono', { type: 'text', value: managed ? '' : opts.sort, spellcheck: false, disabled: managed, placeholder: managed ? 'Set by the Sort menu above the albums' : 'Optional, e.g. %album artist% | %date% | %album%' });
    const forced = el('input', { type: 'checkbox', checked: !!opts.keepSorted, disabled: managed });
    const helpTitle = el('div.ap-help-title');
    const helpFrame = el('iframe.ap-help-frame', { sandbox: '', title: 'Help' });
    const help = el('div.ap-help', { hidden: true }, el('div.ap-help-head', null, helpTitle, el('button.btn-icon', { title: 'Close help', onclick: () => (help.hidden = true, box.classList.remove('with-help')) }, icon('close'))), helpFrame);

    const close = (v) => {
      back.remove();
      resolve(v);
    };
    const ok = () => {
      const q = query.value.trim();
      if (!q) {
        query.focus();
        query.classList.add('invalid');
        return;
      }
      close({ name: name.value.trim(), query: q, sort: sort.value.trim(), keepSorted: forced.checked });
    };
    const field = (label, input, helpKey) =>
      el('label.ap-field', null, el('span.ap-label', { text: label }), input, helpKey ? el('button.btn-icon.ap-q', { type: 'button', title: `${HELP[helpKey].title} help`, onclick: (e) => (e.preventDefault(), showHelp(helpKey)) }, '?') : el('span.ap-q-gap'));

    async function showHelp(key) {
      box.classList.add('with-help');
      help.hidden = false;
      helpTitle.textContent = HELP[key].title;
      if (!helpCache.has(key)) {
        const base = await tryCall('misc.getFoobarPath');
        const dir = (base?.path || base?.value || '').replace(/[\\/]$/, '');
        const res = dir ? await tryCall('file.read', { path: `${dir}\\doc\\${HELP[key].file}` }) : null;
        let html = res?.content || `<p style="font:14px Segoe UI,sans-serif">Couldn't find <b>doc\\${HELP[key].file}</b> in the foobar2000 folder.</p>`;
        // The pages share a stylesheet; inline it, since the frame has no base folder.
        const css = html.includes('titleformat_help.css') ? await tryCall('file.read', { path: `${dir}\\doc\\titleformat_help.css` }) : null;
        html = html.replace(/<link[^>]*titleformat_help\.css[^>]*>/i, `<style>${css?.content || ''} body{font-family:'Segoe UI',sans-serif;padding:0 16px 24px}</style>`);
        helpCache.set(key, html);
      }
      // Sandboxed (no scripts, no navigation away): it's a static help page.
      helpFrame.srcdoc = helpCache.get(key);
    }

    const box = el(
      'div.dialog.ap-dialog',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      el(
        'div.ap-main',
        null,
        el('h2', { text: opts.title }),
        field('Name', name),
        field('Query pattern', query, 'query'),
        field('Sort pattern', sort, 'sort'),
        el('label.ap-check', null, forced, el('span', { text: 'Force-sorted' }), el('span.ap-hint', { text: 'keeps the sort order as songs are added; the playlist can’t be reordered by hand' })),
        opts.unknown
          ? el(
              'p.ap-note',
              null,
              "foobar2000 doesn't share this autoplaylist's current query, so it's blank here. Enter a new one, or ",
              el('button.ap-link', { type: 'button', text: "use foobar2000's editor", onclick: () => (close(null), tryCall('playlist.showAutoplaylistUI', { playlistGuid: opts.playlist.guid })) }),
              '.',
            )
          : null,
        el('div.dialog-buttons', null, el('button.btn-primary', { text: 'OK', onclick: ok }), el('button.btn-text', { text: 'Cancel', onclick: () => close(null) })),
      ),
      help,
    );
    const back = el('div.dialog-back', { onmousedown: (e) => e.target === back && close(null) }, box);
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') ok();
      e.stopPropagation();
    });
    root.append(back);
    (opts.nameLocked || opts.name ? query : name).focus();
  });
}
