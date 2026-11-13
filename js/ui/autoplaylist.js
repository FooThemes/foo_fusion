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
import { attachAssist } from './patternassist.js';
import { tabBar } from './tabs.js';
import { openModal } from './modal.js';
import { iconField } from './iconpicker.js';
import { pickedIcon, setPickedIcon } from './plicon.js';

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
/** New playlist dialog with Playlist / Autoplaylist tabs. */
export async function newPlaylistDialog(tab = 'playlist') {
  const def = await showDialog({ title: 'New', tabs: true, tab, name: '', query: '', sort: '', keepSorted: false });
  if (!def) return;
  if (def.kind === 'playlist') {
    const res = await playlists.create(def.name || 'New playlist');
    const guid = res?.guid || playlists.list.find((p) => p.index === res?.index)?.guid;
    if (guid && def.icon) setPickedIcon(guid, def.icon);
    return;
  }
  await createAuto(def);
}

export async function newAutoplaylist() {
  return newPlaylistDialog('auto');
}

async function createAuto(def) {
  const res = await tryCall('playlist.createAutoplaylist', { name: def.name || def.query, query: def.query, sort: def.sort, keepSorted: def.keepSorted });
  if (!res) return toast("foobar2000 didn't accept that query");
  remember(res.guid, def);
  if (def.icon) setPickedIcon(res.guid, def.icon);
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
    icon: pickedIcon(p.guid),
  });
  if (!def) return;
  const pl = playlists.list.find((x) => x.guid === p.guid);
  if (!pl) return;
  if (!playlists.isSpecial(pl)) setPickedIcon(pl.guid, def.icon || '');
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

/**
 * Links in the help pages: "#section" scrolls within the page (the frame has no
 * real address, so letting it navigate would blank it), links to the other
 * help page switch pages, and web links open in the browser.
 */
function wireHelpLinks(frame, openFile) {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      (doc.getElementById(id) || doc.querySelector(`[name="${CSS.escape(id)}"]`))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (/^https?:/i.test(href)) {
      tryCall('shell.openExternal', { url: href });
    } else {
      const file = href.split('#')[0].split('/').pop();
      if (file) openFile(file);
    }
  });
}

function showDialog(opts) {
  return new Promise((resolve) => {
    let mode = opts.tabs ? opts.tab || 'playlist' : 'auto';
    const name = el('input.field', { type: 'text', value: opts.name, spellcheck: false, disabled: !!opts.nameLocked });
    // Collection and Favourites are Fusion's own: their queries are fixed, and
    // they're kept in the view's order by Fusion's Sort menu.
    const managed = !!opts.playlist && playlists.isSpecial(opts.playlist);
    const query = el('input.field.mono', { type: 'text', value: opts.query, spellcheck: false, disabled: managed, placeholder: 'e.g. GENRE HAS rock AND %rating% GREATER 3' });
    const sort = el('input.field.mono', { type: 'text', value: managed ? '' : opts.sort, spellcheck: false, disabled: managed, placeholder: managed ? 'Set by the Sort menu above the albums' : 'Optional, e.g. %album artist% | %date% | %album%' });
    const forced = el('input', { type: 'checkbox', checked: !!opts.keepSorted, disabled: managed });
    const helpTitle = el('div.ap-help-title');
    // allow-same-origin (but no scripts) so Fusion can handle clicks inside it.
    const helpFrame = el('iframe.ap-help-frame', { sandbox: 'allow-same-origin', title: 'Help' });
    helpFrame.addEventListener('load', () => wireHelpLinks(helpFrame, showHelpFile));
    const help = el('div.ap-help', { hidden: true }, el('div.ap-help-head', null, helpTitle, el('button.btn-icon', { title: 'Close help', onclick: () => (help.hidden = true, box.classList.remove('with-help')) }, icon('close'))), helpFrame);

    let remove = null;
    const close = (v) => {
      remove();
      resolve(v);
    };
    // Completion, and a line saying what foobar2000 makes of each pattern.
    const queryStatus = el('div.pa-status');
    const sortStatus = el('div.pa-status');
    if (!managed) attachAssist(query, 'query', queryStatus).refresh();
    if (!managed) attachAssist(sort, 'format', sortStatus).refresh();
    // A wrong query stays red (and says why) until it's changed.
    const queryError = el('div.ap-error', { hidden: true });
    const bad = (msg) => {
      query.classList.add('invalid');
      queryError.textContent = msg;
      queryError.hidden = false;
      query.focus();
    };
    query.addEventListener('input', () => {
      query.classList.remove('invalid');
      queryError.hidden = true;
    });
    // The playlist's icon, beside its name (not for Collection and Favourites).
    const iconBox = opts.nameLocked ? null : iconField(opts.icon || '', mode === 'auto' ? 'autoplaylist' : 'playlist');
    let checking = false;
    const ok = async () => {
      if (mode === 'playlist') return close({ kind: 'playlist', name: name.value.trim(), icon: iconBox?.value() ?? '' });
      const q = query.value.trim();
      if (!q) return bad('Enter a query.');
      if (checking) return;
      // foobar2000's own parser decides (Fusion doesn't guess at the syntax).
      if (!managed) {
        checking = true;
        try {
          await call('library.query', { query: q, limit: 0, fields: ['handle'] });
        } catch (e) {
          if (e.code === 'INVALID_PARAMS') {
            checking = false;
            return bad(/SORT\s+BY/i.test(q) ? 'Put the sort order in the Sort pattern box, not "SORT BY" in the query.' : "foobar2000 can't read this query. Check the brackets, quotes and keywords (? for help).");
          }
        }
        checking = false;
      }
      close({ kind: 'auto', name: name.value.trim(), query: q, sort: sort.value.trim(), keepSorted: forced.checked, icon: iconBox?.value() ?? '' });
    };
    const field = (label, input, helpKey) =>
      // A label around a plain box (clicking the words focuses it); not around the icon button.
      el(input.tagName === 'INPUT' ? 'label.ap-field' : 'div.ap-field', null, el('span.ap-label', { text: label }), input, helpKey ? el('button.btn-icon.btn-outline.ap-q', { type: 'button', title: `${HELP[helpKey].title} help`, onclick: (e) => (e.preventDefault(), showHelp(helpKey)) }, '?') : el('span.ap-q-gap'));

    // A link in one help page to the other (e.g. title formatting from the query page).
    function showHelpFile(file) {
      const key = Object.keys(HELP).find((k) => HELP[k].file.toLowerCase() === file.toLowerCase());
      if (key) showHelp(key);
    }

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

    // Tabs (new playlist only): Playlist | Autoplaylist.
    const tabs = opts.tabs
      ? tabBar(
          [
            ['playlist', 'Playlist'],
            ['auto', 'Autoplaylist'],
          ],
          { className: 'ap-tabs', label: 'Kind', onPick: (k) => setMode(k) },
        )
      : null;
    const autoPart = el(
      'div.ap-auto',
      null,
      field('Query pattern', query, 'query'),
      queryError,
      queryStatus,
      field('Sort pattern', sort, 'sort'),
      sortStatus,
      el('label.ap-check', null, forced, el('span', { text: 'Force-sorted' }), el('span.ap-hint', { text: 'keeps the sort order as songs are added; the playlist can’t be reordered by hand' })),
    );
    function setMode(k) {
      mode = k;
      autoPart.hidden = k !== 'auto';
      if (k !== 'auto') {
        help.hidden = true;
        box.classList.remove('with-help');
      }
      name.placeholder = k === 'auto' ? 'Uses the query if left empty' : 'New playlist';
      iconBox?.setFallback(k === 'auto' ? 'autoplaylist' : 'playlist');
      tabs?.set(k);
      (k === 'auto' && name.value ? query : name).focus();
    }
    const box = el(
      'div.dialog.ap-dialog',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      el(
        'div.ap-main',
        null,
        tabs?.node || el('h2', { text: opts.title }),
        field('Name', iconBox ? el('span.ap-name-row', null, iconBox, name) : name),
        autoPart,
        opts.unknown
          ? el(
              'p.ap-note',
              null,
              "Fusion couldn't read this autoplaylist's current query, so it's blank here. Enter a new one, or ",
              el('button.ap-link', { type: 'button', text: "use foobar2000's editor", onclick: () => (close(null), tryCall('playlist.showAutoplaylistUI', { playlistGuid: opts.playlist.guid })) }),
              '.',
            )
          : null,
        el('div.dialog-buttons', null, el('button.btn-primary', { text: 'OK', onclick: ok }), el('button.btn-text', { text: 'Cancel', onclick: () => close(null) })),
      ),
      help,
    );
    remove = openModal(box, {
      cancel: () => close(null),
      onKey: (e) => e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text' && ok(),
    });
    if (opts.tabs) setMode(mode);
    else (opts.nameLocked || opts.name ? query : name).focus();
  });
}
