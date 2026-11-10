// Edit an artist's or a genre's information: the fields of its artist.nfo /
// genre.nfo, and its pictures. Pictures can be chosen from a file dialog,
// dropped onto their slot, or pasted; they're copied into the artist's (or
// genre's) folder under the name Fusion and Kodi look for (artist.jpg,
// fanart.jpg, logo.png, folder.jpg …), replacing what was there.
//
// Fields the editor doesn't show (band members, thumbs, anything another
// program wrote) are kept as they are. A file the artist script wrote loses
// its "written by" mark when edited here, so the script's --refresh only
// fills in what's missing and never overwrites the edits.

import { el, clear } from '../core/util.js';
import { icon } from '../core/icons.js';
import { tryCall } from '../core/bridge.js';
import { toast } from './toast.js';
import { artistFiles, artistFolder, musicArtistFolder, pictureUrl } from '../data/artistinfo.js';
import { genreFiles, genreFolder, forgetGenreInfo } from '../data/genreinfo.js';
import { refreshArtist } from '../data/artwork.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;

const ARTIST = {
  root: 'artist',
  file: 'artist.nfo',
  title: (name) => `Edit artist · ${name}`,
  images: [
    { key: 'picture', base: 'artist', label: 'Picture', hint: 'Square; shown on the artist tile and page', shape: 'round', also: ['folder', 'thumb', 'poster', 'photo'] },
    { key: 'fanart', base: 'fanart', label: 'Background', hint: 'Wide; behind the artist page', shape: 'wide', also: ['backdrop', 'background'] },
    { key: 'logo', base: 'logo', label: 'Logo', hint: 'Transparent PNG; in place of the name', shape: 'logo', also: ['clearlogo'] },
  ],
  fields: [
    { tag: 'name_en', label: 'English name' },
    { tag: 'name_rom', label: 'Romanised name' },
    { tag: 'sortname', label: 'Sort name', placeholder: 'e.g. Utada, Hikaru' },
    { tag: 'type', label: 'Type', type: 'select', options: ['', 'Person', 'Group', 'Orchestra', 'Choir', 'Character', 'Other'] },
    { tag: 'genre', label: 'Genres', type: 'list' },
    { tag: 'style', label: 'Styles', type: 'list' },
    { tag: 'mood', label: 'Moods', type: 'list' },
    { tag: 'born', label: 'Born', group: 'person', placeholder: 'YYYY-MM-DD' },
    { tag: 'died', label: 'Died', group: 'person', placeholder: 'YYYY-MM-DD' },
    { tag: 'formed', label: 'Formed', group: 'band', placeholder: 'YYYY-MM-DD' },
    { tag: 'disbanded', label: 'Disbanded', group: 'band', placeholder: 'YYYY-MM-DD' },
    { tag: 'yearsactive', label: 'Years active', placeholder: 'e.g. 1998 - present' },
    { tag: 'website', label: 'Website', placeholder: 'https://' },
    { tag: 'wikipedia', label: 'Wikipedia', placeholder: 'https://en.wikipedia.org/wiki/…' },
    { tag: 'musicBrainzArtistID', label: 'MusicBrainz ID', mono: true },
    { tag: 'biography', label: 'Biography', type: 'text' },
  ],
};

const GENRE = {
  root: 'genre',
  file: 'genre.nfo',
  title: (name) => `Edit genre · ${name}`,
  images: [
    { key: 'picture', base: 'folder', label: 'Picture', hint: 'Square; on the genre tile and page', shape: 'square', also: ['genre', 'thumb', 'poster', 'cover'] },
    { key: 'fanart', base: 'fanart', label: 'Background', hint: 'Wide; behind the genre page', shape: 'wide', also: ['backdrop', 'background'] },
  ],
  fields: [
    { tag: 'summary', label: 'Summary', placeholder: 'e.g. Genre of popular music' },
    { tag: 'origin', label: 'Origin', type: 'list', placeholder: 'Countries, comma separated' },
    { tag: 'since', label: 'Since', placeholder: 'Year' },
    { tag: 'alias', label: 'Also known as', type: 'list' },
    { tag: 'parent', label: 'Part of', type: 'list' },
    { tag: 'subgenre', label: 'Includes', type: 'list' },
    { tag: 'wikipedia', label: 'Wikipedia', placeholder: 'https://en.wikipedia.org/wiki/…' },
    { tag: 'musicBrainzGenreID', label: 'MusicBrainz ID', mono: true },
    { tag: 'discogs', label: 'Discogs', placeholder: 'https://www.discogs.com/style/…' },
    { tag: 'rateyourmusic', label: 'RYM', placeholder: 'https://rateyourmusic.com/genre/…' },
    { tag: 'description', label: 'Description', type: 'text' },
  ],
};

/** Edit an artist's information. `handle`: one of their tracks (for their own music folder). */
export async function editArtist(name, handle = null) {
  const files = await artistFiles(name, handle);
  const dir = files?.dir || artistFolder(name) || musicArtistFolder(name, handle);
  if (!dir) return toast('Set the artist information folder first (Settings > Artists)', 3500);
  return edit(ARTIST, name, dir, () => refreshArtist(name, handle ? [handle] : []));
}

/** Edit a genre's information. */
export async function editGenre(name) {
  const files = await genreFiles(name);
  const dir = files?.dir || genreFolder(name);
  if (!dir) return toast('Set the genre information folder first (Settings > Artists)', 3500);
  return edit(GENRE, name, dir, () => forgetGenreInfo());
}

async function edit(kind, name, dir, refresh) {
  const nfoPath = `${dir}\\${kind.file}`;
  const [read, listing] = await Promise.all([tryCall('file.read', { path: nfoPath }), tryCall('artwork.getFolderImages', { directory: dir })]);
  const xml = read?.content || '';
  const doc = parseXml(xml, kind.root);
  const root = doc.documentElement;
  const values = (tag) => [...root.children].filter((n) => n.tagName === tag).map((n) => n.textContent.trim()).filter(Boolean);
  const images = listing?.images || [];
  const base = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();

  // --- fields
  const inputs = new Map();
  const typeOf = () => (inputs.get('type')?.value || '').toLowerCase();
  const rows = [];
  for (const f of kind.fields) {
    const current = values(f.tag);
    let input;
    if (f.type === 'select') {
      const cur = current[0] || '';
      const opts = f.options.includes(cur) ? f.options : [...f.options, cur];
      input = el('select.set-select.ie-input', null, opts.map((o) => el('option', { value: o, text: o || '—', selected: o === cur })));
    } else if (f.type === 'text') {
      input = el('textarea.dialog-input.ie-text', { spellcheck: true, rows: 7 });
      input.value = current.join('\n\n');
    } else {
      input = el('input.dialog-input.ie-input' + (f.mono ? '.mono' : ''), { type: 'text', spellcheck: false, placeholder: f.placeholder || (f.type === 'list' ? 'Comma separated' : '') });
      input.value = f.type === 'list' ? current.join(', ') : current[0] || '';
    }
    inputs.set(f.tag, input);
    const row = el('label.ie-row' + (f.type === 'text' ? '.ie-wide' : ''), null, el('span.ie-label', { text: f.label }), input);
    row.dataset.group = f.group || '';
    rows.push(row);
  }
  // A person is born and dies; a band forms and disbands.
  const showDates = () => {
    const t = typeOf();
    const band = t ? t !== 'person' && t !== 'character' : !values('born').length && (values('formed').length || values('member').length);
    for (const r of rows) if (r.dataset.group) r.hidden = r.dataset.group !== (band ? 'band' : 'person');
  };
  inputs.get('type')?.addEventListener('change', showDates);
  showDates();

  // --- pictures
  const changes = new Map(); // slot key -> { source: path | null, bytes: base64 | null, ext } | 'remove'
  const slots = kind.images.map((slot) => {
    const existing = [slot.base, ...slot.also].map((b) => images.find((im) => base(im.name) === b)).find(Boolean) || null;
    const img = el('img', { alt: '' });
    const empty = el('div.ie-empty', null, icon('image'), el('span', { text: 'Click, drop or paste a picture' }));
    const box = el('div.ie-pic.ie-' + slot.shape, { tabindex: 0, title: 'Drop or paste a picture, or click to choose one' }, img, empty);
    const show = (url) => {
      img.hidden = !url;
      empty.hidden = !!url;
      if (url) img.src = url;
      else img.removeAttribute('src');
    };
    show(null);
    if (existing) pictureUrl(existing, 600).then((u) => u && !changes.has(slot.key) && show(u));
    const take = (change, url) => {
      changes.set(slot.key, change);
      show(url);
      removeBtn.hidden = false;
    };
    const choose = async () => {
      const res = await tryCall('dialog.openFile', { title: `${slot.label} for ${name}`, filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }], multiple: false });
      const path = pickPath(res);
      if (path === undefined) return fileInput.click(); // no native dialog: the browser's
      if (!path) return;
      if (!IMAGE_EXT.test(path)) return toast('That isn’t a picture Fusion can use (JPG, PNG, WebP or GIF)');
      const url = await pictureUrl({ path, name: path.split('\\').pop() }, 600);
      take({ source: path, ext: extOf(path) }, url);
    };
    const fromFile = async (file) => {
      if (!file || !/^image\//.test(file.type)) return toast('That isn’t a picture');
      const bytes = await toBase64(file);
      take({ bytes, ext: extOf(file.name) || '.' + (file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg') }, URL.createObjectURL(file));
    };
    const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => fromFile(fileInput.files[0]) });
    box.addEventListener('click', choose);
    box.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose()));
    box.addEventListener('dragover', (e) => (e.preventDefault(), box.classList.add('over')));
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('over');
      fromFile(e.dataTransfer?.files?.[0]);
    });
    box.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files || [])][0];
      if (file) (e.preventDefault(), fromFile(file));
    });
    const removeBtn = el('button.btn-text.ie-remove', {
      text: 'Remove',
      hidden: !existing,
      onclick: () => {
        changes.set(slot.key, 'remove');
        show(null);
        removeBtn.hidden = true;
      },
    });
    return el('div.ie-slot', null, el('div.ie-slot-head', null, el('span.ie-label', { text: slot.label }), removeBtn), box, el('small.ie-hint', { text: slot.hint }), fileInput);
  });

  const body = el(
    'div.ie-body',
    null,
    el('div.ie-pics', null, slots),
    el('div.ie-fields', null, rows),
  );
  const folderNote = el('button.btn-text.ie-folder', { title: 'Show the folder in Explorer', onclick: () => tryCall('shell.showInExplorer', { path: dir }) }, icon('folder'), el('span', { text: dir }));

  const saved = await modal(kind.title(name), body, folderNote, async () => {
    // Fields into the file (what it doesn't show stays as it was).
    for (const f of kind.fields) {
      const input = inputs.get(f.tag);
      const row = input.closest('.ie-row');
      let list;
      if (row?.hidden) list = [];
      else if (f.type === 'list') list = input.value.split(/\s*[,;]\s*/).filter(Boolean);
      else if (f.type === 'text') list = input.value.trim() ? [input.value.trim().replace(/\r\n/g, '\n')] : [];
      else list = input.value.trim() ? [input.value.trim()] : [];
      setValues(doc, f.tag, list);
    }
    if (!values('name').length) setValues(doc, 'name', [name], true);
    await tryCall('file.mkdir', { path: dir });
    const out = serialize(doc);
    if (out !== xml) {
      const ok = await tryCall('file.write', { path: nfoPath, content: out, atomic: true });
      if (!ok) throw new Error(`Couldn't save ${kind.file} in ${dir}`);
    }
    // Pictures: the new one under its proper name; others of that kind go
    // to the Recycle Bin (so the new one is the one found).
    for (const slot of kind.images) {
      const change = changes.get(slot.key);
      if (!change) continue;
      const olds = images.filter((im) => [slot.base, ...slot.also].includes(base(im.name)));
      const target = change === 'remove' ? null : `${dir}\\${slot.base}${change.ext}`;
      for (const im of olds) if (im.path.toLowerCase() !== target?.toLowerCase()) await tryCall('file.delete', { path: im.path, moveToTrash: true });
      if (!target) continue;
      const ok = change.source
        ? await tryCall('file.copy', { source: change.source, destination: target, overwrite: true })
        : await tryCall('file.write', { path: target, content: change.bytes, encoding: 'base64', atomic: true });
      if (!ok) throw new Error(`Couldn't save the ${slot.label.toLowerCase()} in ${dir}`);
    }
    return true;
  });
  if (saved) {
    refresh();
    toast('Saved');
  }
}

// --- XML ----------------------------------------------------------------------

function parseXml(xml, rootTag) {
  let doc = null;
  if (xml.trim()) {
    try {
      doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror') || doc.documentElement.tagName !== rootTag) doc = null;
    } catch {
      doc = null;
    }
  }
  if (!doc) doc = document.implementation.createDocument(null, rootTag, null);
  // The artist script's mark: edited here, the file is the user's now.
  for (const n of [...doc.childNodes, ...doc.documentElement.childNodes]) if (n.nodeType === Node.COMMENT_NODE && /written by fusion-artist-info/.test(n.data)) n.remove();
  return doc;
}

/** Replace every <tag> with one per value, where the first one was (else at the end). */
function setValues(doc, tag, list, first = false) {
  const root = doc.documentElement;
  const old = [...root.children].filter((n) => n.tagName === tag);
  const ref = old.length ? old[old.length - 1].nextSibling : first ? root.firstChild : null;
  // Keep attributes of the first (e.g. <genre clear="true">), drop the rest.
  const attrs = old[0] ? [...old[0].attributes].map((a) => [a.name, a.value]) : [];
  for (const n of old) n.remove();
  for (const v of list) {
    const n = doc.createElement(tag);
    for (const [k, val] of attrs) n.setAttribute(k, val);
    n.textContent = v;
    root.insertBefore(n, ref && ref.parentNode === root ? ref : first ? root.firstChild : null);
  }
}

function serialize(doc) {
  const root = doc.documentElement;
  for (const n of [...root.childNodes]) if (n.nodeType === Node.TEXT_NODE && !n.data.trim()) n.remove();
  for (const n of [...root.childNodes]) root.insertBefore(doc.createTextNode('\n    '), n);
  root.append(doc.createTextNode('\n'));
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + new XMLSerializer().serializeToString(root) + '\n';
}

// --- helpers ------------------------------------------------------------------

function pickPath(res) {
  if (res == null) return undefined;
  if (typeof res === 'string') return res;
  if (res.cancelled || res.canceled) return null;
  const list = res.filePaths || res.paths || res.files || res.selected;
  if (Array.isArray(list)) return list[0] || null;
  return res.filePath || res.path || res.file || null;
}

const extOf = (n) => {
  const m = /\.[a-z0-9]+$/i.exec(n || '');
  return m ? m[0].toLowerCase().replace('.jpeg', '.jpg') : '';
};

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function modal(title, body, footNote, onSave) {
  return new Promise((resolve) => {
    const root = document.getElementById('overlay-root');
    const close = (v) => {
      back.remove();
      resolve(v);
    };
    const error = el('p.ie-error', { hidden: true });
    const saveBtn = el('button.btn-primary', {
      text: 'Save',
      onclick: async () => {
        saveBtn.disabled = true;
        error.hidden = true;
        try {
          close(await onSave());
        } catch (e) {
          error.textContent = `${e.message}. foobar2000 may not allow writing there.`;
          error.hidden = false;
          saveBtn.disabled = false;
        }
      },
    });
    const back = el('div.dialog-back', { onmousedown: (e) => e.target === back && close(null) });
    const box = el(
      'div.dialog.ie-dialog',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div.ie-head', null, el('h2', { text: title }), el('button.btn-icon', { title: 'Close', onclick: () => close(null) }, icon('close'))),
      body,
      error,
      el('div.dialog-buttons.ie-buttons', null, saveBtn, el('button.btn-text', { text: 'Cancel', onclick: () => close(null) }), el('span.ie-spacer'), footNote),
    );
    back.append(box);
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 's' && e.ctrlKey) (e.preventDefault(), saveBtn.click());
      e.stopPropagation();
    });
    root.append(back);
    box.querySelector('.ie-fields input')?.focus();
    void clear;
  });
}
