// Completion for query and title formatting patterns (the autoplaylist
// dialog): field names after %, functions after $, and in a query the field,
// operator, value and keyword that can come next. Fields come from the tags
// the library actually has (a sample of it) plus foobar2000's own; anything
// not in the list is fine too: the field just ends at its closing %.
//
// Below the box, a line says how many songs the query matches (foobar2000's
// own parser decides), or which bracket, quote or % isn't closed.

import { el } from '../core/util.js';
import { call, tryCall } from '../core/bridge.js';

// --- what can be suggested ------------------------------------------------------

const FIELDS = {
  artist: 'Artist',
  'album artist': 'Album artist (else artist)',
  album: 'Album',
  title: 'Title',
  tracknumber: 'Track number (2 digits)',
  discnumber: 'Disc number',
  totaltracks: 'Tracks on the disc',
  totaldiscs: 'Discs in the set',
  date: 'Date as tagged',
  genre: 'Genre',
  composer: 'Composer',
  performer: 'Performer',
  comment: 'Comment',
  publisher: 'Label',
  language: 'Language',
  length: 'Length (m:ss)',
  length_seconds: 'Length in seconds',
  length_ex: 'Length with milliseconds',
  bitrate: 'Bitrate (kbps)',
  codec: 'Codec',
  codec_profile: 'Codec profile',
  samplerate: 'Sample rate (Hz)',
  bitspersample: 'Bits per sample',
  channels: 'Channels',
  filesize: 'File size in bytes',
  filesize_natural: 'File size (MB)',
  path: 'Full path',
  filename: 'File name without extension',
  filename_ext: 'File name',
  directory: 'Folder name',
  directoryname: 'Folder name',
  subsong: 'Subsong number',
  added: 'Added to the library (foo_playcount)',
  first_played: 'First played (foo_playcount)',
  last_played: 'Last played (foo_playcount)',
  play_count: 'Play count (foo_playcount)',
  rating: 'Rating (foo_playcount)',
  replaygain_track_gain: 'ReplayGain track gain',
  replaygain_album_gain: 'ReplayGain album gain',
  musicbrainz_albumid: 'MusicBrainz release ID',
  musicbrainz_artistid: 'MusicBrainz artist ID',
  musicbrainz_trackid: 'MusicBrainz recording ID',
};

const FUNCTIONS = [
  ['if', '(cond,then)', 'then when cond is true'],
  ['if', '(cond,then,else)', 'then or else'],
  ['if2', '(a,else)', 'a if it has a value, else else'],
  ['if3', '(a1,a2,…,else)', 'the first with a value'],
  ['ifequal', '(n1,n2,then,else)', 'compare numbers'],
  ['ifgreater', '(n1,n2,then,else)', 'n1 > n2'],
  ['iflonger', '(s,n,then,else)', 's longer than n'],
  ['select', '(n,a1,a2,…)', 'the n-th argument'],
  ['and', '(x,y,…)', 'all true'],
  ['or', '(x,y,…)', 'any true'],
  ['not', '(x)', 'the opposite'],
  ['xor', '(x,y,…)', 'exactly one true'],
  ['stricmp', '(a,b)', 'equal, ignoring case'],
  ['strcmp', '(a,b)', 'equal'],
  ['strstr', '(s,find)', 'position of find in s'],
  ['meta', '(name)', 'first value of a tag'],
  ['meta', '(name,n)', 'n-th value of a tag'],
  ['meta_sep', '(name,sep)', 'every value, joined'],
  ['meta_num', '(name)', 'how many values'],
  ['meta_test', '(name,…)', 'all these tags present'],
  ['info', '(name)', 'technical info field'],
  ['year', '(date)', 'the year of a date'],
  ['month', '(date)', 'the month'],
  ['day_of_month', '(date)', 'the day'],
  ['date', '(time)', 'the date part'],
  ['left', '(s,n)', 'first n characters'],
  ['right', '(s,n)', 'last n characters'],
  ['cut', '(s,n)', 'first n characters'],
  ['substr', '(s,from,to)', 'characters from…to'],
  ['len', '(s)', 'length'],
  ['lower', '(s)', 'lower case'],
  ['upper', '(s)', 'upper case'],
  ['caps', '(s)', 'Capitalise Each Word'],
  ['trim', '(s)', 'without outer spaces'],
  ['replace', '(s,a,b,…)', 'replace a with b'],
  ['stripprefix', '(s)', 'without A / The'],
  ['swapprefix', '(s)', 'Beatles, The'],
  ['pad', '(s,n)', 'pad to n with spaces'],
  ['pad_right', '(s,n)', 'pad on the left'],
  ['num', '(n,len)', 'number with leading zeros'],
  ['add', '(a,b,…)', 'a + b'],
  ['sub', '(a,b,…)', 'a − b'],
  ['mul', '(a,b,…)', 'a × b'],
  ['div', '(a,b,…)', 'a ÷ b'],
  ['mod', '(a,b)', 'remainder'],
  ['min', '(a,b,…)', 'smallest'],
  ['max', '(a,b,…)', 'largest'],
  ['rand', '()', 'a random number'],
  ['directory', '(path)', 'folder name'],
  ['directory', '(path,n)', 'n levels up'],
  ['directory_path', '(path)', 'folder path'],
  ['ext', '(path)', 'file extension'],
  ['filename', '(path)', 'file name'],
  ['abbr', '(s)', 'initials'],
  ['ascii', '(s)', 'ASCII only'],
  ['crlf', '()', 'new line'],
  ['tab', '()', 'tab'],
  ['char', '(n)', 'character n'],
  ['repeat', '(s,n)', 's n times'],
  ['longest', '(a,b,…)', 'the longest'],
  ['shortest', '(a,b,…)', 'the shortest'],
  ['roman', '(n)', 'Roman numerals'],
];

// Query keywords: what comes after a field, and between conditions.
const OPERATORS = [
  ['HAS', 'contains (any case)'],
  ['IS', 'is exactly'],
  ['EQUAL', 'equals the number'],
  ['GREATER', 'more than'],
  ['LESS', 'less than'],
  ['MISSING', 'has no value'],
  ['PRESENT', 'has a value'],
  ['AFTER', 'later than a date'],
  ['BEFORE', 'earlier than a date'],
  ['SINCE', 'on or after a date'],
  ['DURING', 'within a period'],
  ['DURING LAST', '… 2 WEEKS, 30 DAYS'],
];
const VALUE_OPS = new Set(['HAS', 'IS', 'EQUAL', 'GREATER', 'LESS', 'AFTER', 'BEFORE', 'SINCE', 'DURING']);
const BETWEEN = [
  ['AND', 'both'],
  ['OR', 'either'],
  ['AND NOT', 'but not'],
  ['SORT BY', 'then sort'],
  ['SORT DESCENDING BY', 'then sort, highest first'],
];
const START = [
  ['NOT', 'the opposite of'],
  ['ALL', 'every song'],
];
const PERIODS = ['MINUTES', 'HOURS', 'DAYS', 'WEEKS'];

// --- library knowledge (loaded once) -------------------------------------------

let known = null; // Promise<Map<lowercase field, label>>
const valueCache = new Map(); // field -> Promise<[name, count][]>

function libraryFields() {
  if (!known)
    known = (async () => {
      const fields = new Map(Object.entries(FIELDS));
      // The tags the library actually uses: a random sample of it.
      const sample = await tryCall('library.getRandomTracks', { count: 60 });
      const paths = (sample?.tracks || []).map((t) => t.handle || t.path).filter(Boolean);
      const read = paths.length ? await tryCall('metadata.readBatch', { paths }) : null;
      for (const row of read?.results || []) {
        for (const k of Object.keys(row.tags || {})) {
          const name = k.toLowerCase();
          if (!/^[a-z0-9 _:.-]+$/.test(name) || name.length > 40) continue;
          if (!fields.has(name)) fields.set(name, 'tag in your library');
        }
      }
      return fields;
    })().catch(() => new Map(Object.entries(FIELDS)));
  return known;
}

function fieldValues(field) {
  const key = field.toLowerCase();
  if (!valueCache.has(key))
    valueCache.set(
      key,
      tryCall('library.getFieldValues', { field: key, limit: 3000 }).then((r) => (r?.values || []).map((v) => [v.name, v.trackCount])),
    );
  return valueCache.get(key);
}

// --- reading the text before the caret -------------------------------------------

/** Where the caret is, in a query or a title formatting pattern. */
function context(text, kind) {
  // A field being typed: an odd number of % (outside quotes).
  let inQuote = false;
  let pct = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && pct < 0 && kind === 'query') inQuote = !inQuote;
    else if (c === "'" && kind === 'format') inQuote = !inQuote;
    else if (c === '%' && !inQuote) pct = pct < 0 ? i : -1;
  }
  if (pct >= 0) return { type: 'field', from: pct + 1, word: text.slice(pct + 1) };
  if (inQuote) return null;
  const fn = /\$([a-z0-9_]*)$/i.exec(text);
  if (fn) return { type: 'function', from: text.length - fn[1].length, word: fn[1] };
  if (kind !== 'query') return null;

  // A query: the condition after the last AND / OR / NOT / ( (outside quotes and %).
  const masked = text.replace(/"[^"]*"|%[^%]*%/g, (m) => '_'.repeat(m.length));
  const sortAt = /\bSORT\s+(?:(?:DESCENDING|ASCENDING)\s+)?BY\s+/i.exec(masked);
  if (sortAt) return null; // a sort pattern: % and $ only
  let start = 0;
  for (const m of masked.matchAll(/\b(?:AND|OR|NOT)\b|\(/gi)) start = m.index + m[0].length;
  const seg = text.slice(start);
  const lead = seg.length - seg.trimStart().length;
  const body = seg.slice(lead);
  const at = start + lead;
  const m = /^(%[^%]*%|"[^"]*"|[^\s"%()]+)(\s+)?(.*)$/s.exec(body);
  if (!m) return { type: 'start', from: at, word: '' };
  const [, field, gap, rest] = m;
  if (!gap) return { type: 'start', from: at, word: field };
  const fieldName = field.replace(/^[%"]|[%"]$/g, '');
  // Operator, then value.
  const op = /^(DURING\s+LAST|HAS|IS|EQUAL|GREATER|LESS|MISSING|PRESENT|AFTER|BEFORE|SINCE|DURING)\b(\s+)?(.*)$/is.exec(rest);
  if (!op) return { type: 'operator', from: at + field.length + gap.length, word: rest, field: fieldName };
  const opName = op[1].toUpperCase().replace(/\s+/g, ' ');
  const valueFrom = at + field.length + gap.length + op[1].length + (op[2]?.length || 0);
  if (!op[2]) return { type: 'operator', from: at + field.length + gap.length, word: op[1], field: fieldName };
  const value = op[3];
  if (opName === 'MISSING' || opName === 'PRESENT') return { type: 'between', from: valueFrom, word: value };
  if (opName === 'DURING LAST') {
    const p = /^(\d+)\s+(\S*)$/.exec(value);
    return p ? { type: 'period', from: text.length - p[2].length, word: p[2] } : null;
  }
  if (!VALUE_OPS.has(opName)) return null;
  // After a complete value and a space: AND / OR …
  const done = /^("[^"]*"|\S.*\S|\S)\s+(\S*)$/.exec(value);
  return { type: 'value', from: valueFrom, word: value, field: fieldName, op: opName, then: done ? { from: text.length - done[2].length, word: done[2] } : null };
}

/** Unclosed %, (, [ or quotes, as a short message (or ''). */
export function balance(text, kind) {
  let paren = 0;
  let bracket = 0;
  let pct = false;
  let quote = false;
  for (const c of text) {
    if (quote) {
      if (c === (kind === 'query' ? '"' : "'")) quote = false;
      continue;
    }
    if (c === (kind === 'query' ? '"' : "'") && !pct) quote = true;
    else if (c === '%') pct = !pct;
    else if (pct) continue;
    else if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    if (paren < 0) return 'A ) has no matching (';
    if (bracket < 0) return 'A ] has no matching [';
  }
  if (quote) return kind === 'query' ? 'A " isn’t closed' : 'A \' isn’t closed';
  if (pct) return 'A % isn’t closed (fields go %like this%)';
  if (paren) return `${paren} ( ${paren === 1 ? 'isn’t' : 'aren’t'} closed`;
  if (bracket) return `${bracket} [ ${bracket === 1 ? 'isn’t' : 'aren’t'} closed`;
  return '';
}

const starts = (name, word) => name.toLowerCase().startsWith(word.toLowerCase());
const contains = (name, word) => name.toLowerCase().includes(word.toLowerCase());

async function suggestions(ctx, kind) {
  if (!ctx) return [];
  const w = ctx.word;
  const fieldItems = async (wrap) => {
    const fields = await libraryFields();
    const list = [...fields].filter(([n]) => (w ? contains(n, w) : true));
    list.sort((a, b) => Number(!starts(a[0], w)) - Number(!starts(b[0], w)) || (a[1] === 'tag in your library') - (b[1] === 'tag in your library') || a[0].localeCompare(b[0]));
    return list.map(([n, d]) => ({ label: wrap ? `%${n}%` : n, detail: d, insert: wrap ? `%${n}% ` : n }));
  };
  switch (ctx.type) {
    case 'field': {
      const fields = await libraryFields();
      return [...fields]
        .filter(([n]) => contains(n, w))
        .sort((a, b) => Number(!starts(a[0], w)) - Number(!starts(b[0], w)) || a[0].localeCompare(b[0]))
        .map(([n, d]) => ({ label: `%${n}%`, detail: d, insert: kind === 'query' ? `${n}% ` : `${n}%`, skipClosing: '%' }));
    }
    case 'function':
      return FUNCTIONS.filter(([n]) => starts(n, w)).map(([n, args, d]) => ({ label: `$${n}${args}`, detail: d, insert: `${n}(`, skipClosing: '(' }));
    case 'start': {
      const keys = START.filter(([k]) => starts(k, w)).map(([k, d]) => ({ label: k, detail: d, insert: `${k} ` }));
      // Fields are written %like this% in a query (works for every name).
      const fields = (await fieldItems(true)).map((f) => ({ ...f, from: ctx.from }));
      return [...(w.startsWith('%') ? [] : keys.filter((k) => k.label !== 'ALL' || ctx.from === 0)), ...fields.filter((f) => contains(f.label, w.replace(/%/g, '')))];
    }
    case 'operator':
      return OPERATORS.filter(([k]) => starts(k, w)).map(([k, d]) => ({ label: k, detail: d, insert: `${k} ` }));
    case 'period':
      return PERIODS.filter((k) => starts(k, w)).map((k) => ({ label: k, insert: `${k} ` }));
    case 'between':
      return BETWEEN.filter(([k]) => starts(k, w)).map(([k, d]) => ({ label: k, detail: d, insert: `${k} ` }));
    case 'value': {
      const out = [];
      if (ctx.then) out.push(...BETWEEN.filter(([k]) => starts(k, ctx.then.word)).map(([k, d]) => ({ label: k, detail: d, insert: `${k} `, from: ctx.then.from })));
      if (/^(HAS|IS)$/.test(ctx.op) && !/^%|\$/.test(ctx.field)) {
        const values = await fieldValues(ctx.field);
        const v = w.trim();
        const matches = values.filter(([n]) => (v ? contains(n, v) : true)).sort((a, b) => Number(!starts(a[0], v)) - Number(!starts(b[0], v)) || b[1] - a[1]);
        out.unshift(...matches.slice(0, 200).map(([n, c]) => ({ label: n, detail: `${c.toLocaleString()} songs`, insert: (/[()"]|\b(AND|OR|NOT)\b/.test(n) ? `"${n.replace(/"/g, '')}"` : n) + ' ' })));
        // A value already typed in full: offer what comes next first.
        if (ctx.then && values.some(([n]) => n.toLowerCase() === ctx.word.trim().toLowerCase())) out.sort((a, b) => Number(!!b.from) - Number(!!a.from));
      }
      return out;
    }
  }
  return [];
}

// --- the list ---------------------------------------------------------------------------

/**
 * Add completion to a text box. kind: 'query' or 'format'.
 * status: an element for the match count / unclosed-bracket line.
 */
export function attachAssist(input, kind, status) {
  let items = [];
  let index = 0;
  let ctx = null;
  let token = 0;
  const list = el('div.popup.pa-list', { role: 'listbox', hidden: true });
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'list');

  const host = () => input.closest('.dialog-back') || document.body;

  function place() {
    const r = input.getBoundingClientRect();
    // Under the text being completed.
    const cs = getComputedStyle(input);
    const ctx2d = (place.c ||= document.createElement('canvas').getContext('2d'));
    ctx2d.font = `${cs.fontSize} ${cs.fontFamily}`;
    const before = input.value.slice(0, ctx?.from ?? input.selectionStart);
    const x = Math.min(r.left + parseFloat(cs.paddingLeft) + ctx2d.measureText(before).width - input.scrollLeft, window.innerWidth - 340);
    list.style.left = `${Math.max(8, x - 8)}px`;
    list.style.top = `${r.bottom + 2}px`;
  }

  function render() {
    list.replaceChildren(
      ...items.slice(0, 200).map((it, i) =>
        el(
          'div.pa-item',
          {
            role: 'option',
            'aria-selected': String(i === index),
            className: `pa-item${i === index ? ' on' : ''}`,
            onmousedown: (e) => {
              e.preventDefault();
              accept(i);
            },
          },
          el('span.pa-label', { text: it.label }),
          it.detail ? el('span.pa-detail', { text: it.detail }) : null,
        ),
      ),
    );
    list.hidden = !items.length;
    if (!list.hidden) {
      if (!list.isConnected) host().append(list);
      place();
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    }
  }

  function hide() {
    items = [];
    list.hidden = true;
  }

  async function update() {
    const my = ++token;
    const caret = input.selectionStart;
    if (caret !== input.selectionEnd) return hide();
    ctx = context(input.value.slice(0, caret), kind);
    const found = await suggestions(ctx, kind);
    if (my !== token) return;
    // Nothing more to add: the word is already exactly the only suggestion.
    items = found.filter((it) => !(found.length === 1 && it.insert.trim() === (ctx?.word || '').trim()));
    index = 0;
    render();
  }

  function accept(i = index) {
    const it = items[i];
    if (!it || !ctx) return;
    const from = it.from ?? ctx.from;
    const caret = input.selectionStart;
    let after = input.value.slice(caret);
    // The rest of the word under the caret is replaced too.
    const tail = /^[^\s%()"$,]*/.exec(after)[0];
    after = after.slice(tail.length);
    let insert = it.insert;
    // Don't double a closing % or ( that's already there.
    if (it.skipClosing && after.startsWith(it.skipClosing)) insert = insert.slice(0, -1);
    if (insert.endsWith(' ') && after.startsWith(' ')) insert = insert.slice(0, -1);
    input.value = input.value.slice(0, from) + insert + after;
    const pos = from + insert.length + (it.skipClosing && after.startsWith(it.skipClosing) ? 1 : 0);
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  input.addEventListener('input', () => {
    update();
    check();
  });
  input.addEventListener('click', update);
  input.addEventListener('focus', () => {
    libraryFields();
    check();
  });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      return update();
    }
    if (list.hidden || !items.length) {
      if (e.key === 'ArrowDown' && !e.altKey) {
        e.preventDefault();
        update();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      index = Math.max(0, Math.min(items.length - 1, index + (e.key === 'PageDown' ? 8 : -8)));
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      accept();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      setTimeout(update);
    }
  });

  // The line under the box: unclosed brackets first, then what foobar2000
  // makes of it (songs matched / a sample of the sort pattern).
  let checkTimer = 0;
  let checkToken = 0;
  function check() {
    if (!status) return;
    clearTimeout(checkTimer);
    const text = input.value.trim();
    const my = ++checkToken;
    const say = (msg, cls = '') => {
      if (my !== checkToken) return;
      status.textContent = msg;
      status.className = `pa-status ${cls}`;
    };
    if (!text) return say('');
    const open = balance(text, kind);
    if (open) return say(open, 'warn');
    checkTimer = setTimeout(async () => {
      if (kind === 'query') {
        try {
          const r = await call('library.query', { query: text, limit: 0, fields: ['handle'] });
          say(`Matches ${Number(r.total || 0).toLocaleString()} ${r.total === 1 ? 'song' : 'songs'}`, r.total ? 'ok' : '');
        } catch (e) {
          if (e.code === 'INVALID_PARAMS') say(/SORT\s+BY/i.test(text) ? 'Put the sort order in the Sort pattern box' : "foobar2000 can't read this query yet", 'warn');
          else say('');
        }
      } else {
        // The pattern on a song from the library, as a sample.
        const pick = await tryCall('library.getRandomTracks', { count: 1 });
        const path = pick?.tracks?.[0]?.handle;
        const r = path ? await tryCall('titleformat.eval', { path, pattern: text }) : null;
        say(r ? `e.g. ${r.result || '(empty)'}` : path ? "foobar2000 can't read this pattern yet" : '', r ? '' : 'warn');
      }
    }, 300);
  }

  return { refresh: check, close: hide };
}
