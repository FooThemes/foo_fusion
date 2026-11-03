# -*- coding: utf-8 -*-
"""Language Variants: original, English and romanised tags from MusicBrainz.

For releases that MusicBrainz links to translated or transliterated
pseudo-releases ("transl-tracklisting"), writes

    TITLE_ORIG / TITLE_EN / TITLE_ROM            (and the same for ARTIST,
    ALBUM_ORIG / ALBUM_EN / ALBUM_ROM             ALBUMARTIST and
    ...                                           DISCSUBTITLE)

and rebuilds TITLE, ALBUM, ... from them with a format you choose per tag,
e.g. albums as "English (原題)" and tracks as "原題 (English)".

English artist names also come from the artists' English aliases. When
MusicBrainz has no English version, an optional machine translation (DeepL
or Google Cloud Translation, with your own API key) fills in *_EN.
"""
# Copyright (C) 2026 Steven
#
# This program is free software; you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by the Free
# Software Foundation; either version 2 of the License, or (at your option)
# any later version.

PLUGIN_NAME = 'Language Variants'
PLUGIN_AUTHOR = 'Steven'
PLUGIN_DESCRIPTION = '''
Writes original, English and romanised versions of title, artist, album,
album artist and disc subtitle (TITLE_ORIG, TITLE_EN, TITLE_ROM, ...) from
the release's translated and transliterated pseudo-releases on MusicBrainz,
then rebuilds the main tags from them in a format you choose per tag, such as
"English (原題)" for albums and "原題 (English)" for tracks.<br><br>
English artist names also come from artist aliases. Optionally, missing
English versions can be machine translated with DeepL or Google Cloud
Translation (your own API key; off by default).<br><br>
Settings: Options &gt; Plugins &gt; Language Variants.
'''
PLUGIN_VERSION = '1.0.1'
PLUGIN_API_VERSIONS = ['2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10', '2.11', '2.12', '2.13']
PLUGIN_LICENSE = 'GPL-2.0-or-later'
PLUGIN_LICENSE_URL = 'https://www.gnu.org/licenses/gpl-2.0.html'

import html
import json
import os
import re
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from functools import partial

from PyQt5 import QtCore, QtWidgets

from picard import config, log
from picard.album import register_album_post_removal_processor
from picard.metadata import (
    register_album_metadata_processor,
    register_track_metadata_processor,
)
from picard.plugin import PluginPriority
from picard.ui.options import OptionsPage, register_options_page
from picard.util import thread
from picard.webservice.api_helpers import MBAPIHelper

try:
    from picard.const import USER_DIR
except ImportError:  # very old Picard
    USER_DIR = os.path.expanduser('~')


KINDS = ('orig', 'en', 'rom')
FIELDS = (
    ('title', 'Title'),
    ('artist', 'Artist'),
    ('album', 'Album'),
    ('albumartist', 'Album artist'),
    ('discsubtitle', 'Disc subtitle'),
)
ALBUM_FIELDS = ('album', 'albumartist')

# Per tag: which version leads, which goes in the brackets (each a fallback
# list: the first one that exists and differs from the lead is used), and
# the format joining them.
DEFAULT_LAYOUT = {
    'title': ('orig', 'en, rom', '{main} ({second})'),
    'artist': ('orig', 'en, rom', '{main} ({second})'),
    'album': ('en, rom, orig', 'orig', '{main} ({second})'),
    'albumartist': ('orig', 'en, rom', '{main} ({second})'),
    'discsubtitle': ('en, rom, orig', 'orig', '{main} ({second})'),
}
DEFAULT_MT_FIELDS = ('title', 'album', 'discsubtitle')

PROVIDERS = (('', 'Off'), ('deepl', 'DeepL API (Free or Pro)'), ('google', 'Google Cloud Translation'))
ENGLISH = (('EN-GB', 'British English'), ('EN-US', 'American English'))


def opt(name):
    return 'lv_' + name


def setting(name):
    return config.setting[opt(name)]


def parse_chain(text):
    return [k for k in re.split(r'[\s,;/>]+', (text or '').lower()) if k in KINDS]


def same(a, b):
    return (a or '').strip().casefold() == (b or '').strip().casefold()


def combine(values, main_chain, second_chain, fmt):
    """values: {'orig': .., 'en': .., 'rom': ..} -> the combined string."""
    main_kind = next((k for k in main_chain if values.get(k)), None)
    if not main_kind:
        return values.get('orig') or ''
    main = values[main_kind]
    second = next((values[k] for k in second_chain if k != main_kind and values.get(k) and not same(values[k], main)), None)
    if not second or '{main}' not in fmt:
        return main
    second = strip_shared(second, main)
    return fmt.replace('{main}', main).replace('{second}', second)


BRACKETED = re.compile(r'\s*([(\[{（［【〈《「『<~])([^()\[\]{}]*?)([)\]}）］】〉》」』>~])\s*$')


def strip_shared(second, main):
    """Drop trailing bracketed parts of `second` that `main` already has, so
    "気分じゃないの (Not in the Mood)" + "Kibun Janai no (Not In The Mood)"
    combine as "気分じゃないの (Not in the Mood) (Kibun Janai no)"."""
    folded = main.casefold()
    while True:
        m = BRACKETED.search(second)
        if not m or m.start() == 0 or m.group(2).strip().casefold() not in folded:
            return second
        second = second[:m.start()].rstrip()


def credit_string(credits, name_of=None):
    """An artist credit as text, with its join phrases ("A feat. B")."""
    out = []
    for c in credits or []:
        name = (name_of(c) if name_of else None) or c.get('name') or (c.get('artist') or {}).get('name') or ''
        out.append(name + (c.get('joinphrase') or ''))
    return ''.join(out).strip()


def english_alias(credit):
    """The artist's primary English alias, if MusicBrainz has one."""
    aliases = (credit.get('artist') or {}).get('aliases') or []
    best = None
    for a in aliases:
        loc = (a.get('locale') or '').lower()
        if not (loc == 'en' or loc.startswith('en_')) or a.get('type') not in (None, 'Artist name', 'Legal name'):
            continue
        rank = (bool(a.get('primary')), loc == 'en', a.get('type') == 'Artist name')
        if best is None or rank > best[0]:
            best = (rank, a.get('name'))
    return best[1] if best else None


def pseudo_kind(release):
    """'en' for an English translation, 'rom' for a romanisation, else None."""
    dis = (release.get('disambiguation') or '').lower()
    rep = release.get('text-representation') or {}
    lang, script = rep.get('language'), rep.get('script')
    if re.search(r'translit|romani[sz]|r[oō]maji|romaja|pinyin|latin script', dis):
        return 'rom'
    if re.search(r'translat|english', dis):
        return 'en'
    if lang == 'eng':
        return 'en'
    if script == 'Latn':
        return 'rom'
    return None


def has_non_latin(text):
    for ch in text or '':
        if ch.isalpha() and 'LATIN' not in unicodedata.name(ch, 'LATIN'):
            return True
    return False


def needs_translation(text, lang, script):
    if not text or not text.strip():
        return False
    if has_non_latin(text):
        return True
    # Latin-script titles in another language (French, Spanish...).
    return script == 'Latn' and bool(lang) and lang not in ('eng', 'zxx', 'mul', 'und')


# ISO 639-3 (MusicBrainz) -> DeepL / Google source codes; anything else is
# left for the service to detect.
SOURCE_LANG = {
    'jpn': 'ja', 'zho': 'zh', 'kor': 'ko', 'rus': 'ru', 'ukr': 'uk', 'deu': 'de', 'fra': 'fr',
    'spa': 'es', 'ita': 'it', 'por': 'pt', 'nld': 'nl', 'pol': 'pl', 'swe': 'sv', 'dan': 'da',
    'fin': 'fi', 'nor': 'nb', 'nob': 'nb', 'ces': 'cs', 'tur': 'tr', 'ell': 'el', 'hun': 'hu',
    'ind': 'id', 'est': 'et', 'lav': 'lv', 'lit': 'lt', 'ron': 'ro', 'slk': 'sk', 'slv': 'sl',
    'bul': 'bg', 'ara': 'ar', 'heb': 'he', 'tha': 'th', 'vie': 'vi', 'hin': 'hi',
}


class Translator:
    """Machine translation with an on-disk cache, so each string is only
    paid for once. Runs in a worker thread."""

    def __init__(self):
        self.path = os.path.join(USER_DIR, 'language_variants_cache.json')
        self.lock = threading.Lock()
        self.cache = None

    def _load(self):
        if self.cache is None:
            try:
                with open(self.path, encoding='utf-8') as f:
                    self.cache = json.load(f)
            except (OSError, ValueError):
                self.cache = {}

    def _save(self):
        try:
            tmp = self.path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.cache, f, ensure_ascii=False, indent=0)
            os.replace(tmp, self.path)
        except OSError as e:
            log.warning('%s: could not save the translation cache: %s', PLUGIN_NAME, e)

    def translate(self, provider, key, target, lang, texts):
        """Returns {text: english}. Blocking; call from a worker thread."""
        with self.lock:
            self._load()
            out = {}
            todo = []
            for t in texts:
                hit = self.cache.get('%s:%s:%s' % (provider, target, t))
                if hit is not None:
                    out[t] = hit
                elif t not in todo:
                    todo.append(t)
        source = SOURCE_LANG.get(lang or '')
        for i in range(0, len(todo), 50):
            chunk = todo[i:i + 50]
            if provider == 'deepl':
                results = self._deepl(key, target, source, chunk)
            elif provider == 'google':
                results = self._google(key, source, chunk)
            else:
                return out
            with self.lock:
                for src, dst in zip(chunk, results):
                    dst = (dst or '').strip()
                    if dst:
                        out[src] = dst
                        self.cache['%s:%s:%s' % (provider, target, src)] = dst
                self._save()
        return out

    @staticmethod
    def _post(url, body, headers):
        req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('User-Agent', '%s Picard plugin/%s' % (PLUGIN_NAME, PLUGIN_VERSION))
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')[:300]
            raise RuntimeError('HTTP %s: %s' % (e.code, detail))

    def _deepl(self, key, target, source, texts):
        host = 'api-free.deepl.com' if key.strip().endswith(':fx') else 'api.deepl.com'
        body = {
            'text': texts,
            'target_lang': target,
            # Not billed; helps short titles come out as titles.
            'context': 'Titles of songs, albums and artists from a music release.',
        }
        if source:
            body['source_lang'] = source.upper()
        data = self._post('https://%s/v2/translate' % host, body, {'Authorization': 'DeepL-Auth-Key ' + key.strip()})
        return [t.get('text') for t in data.get('translations', [])]

    def _google(self, key, source, texts):
        body = {'q': texts, 'target': 'en', 'format': 'text'}
        if source:
            body['source'] = source
        url = 'https://translation.googleapis.com/language/translate/v2?key=' + urllib.parse.quote(key.strip())
        data = self._post(url, body, {})
        return [html.unescape(t.get('translatedText') or '') for t in (data.get('data') or {}).get('translations', [])]


class AlbumState:
    def __init__(self, album, release):
        self.album = album
        rep = release.get('text-representation') or {}
        self.lang, self.script = rep.get('language'), rep.get('script')
        self.release = release
        self.pending = 0
        self.ready = False
        self.album_orig = {}     # field -> original album-level value
        self.album_values = {}   # field -> {'en': .., 'rom': ..}
        self.disc_values = {}    # disc position -> {'en': .., 'rom': ..}
        self.track_values = {}   # (disc, track) -> {field: {'en': .., 'rom': ..}}
        self.mt = {}             # original text -> machine translation
        self.targets = []        # (metadata, disc, track, {field: original})
        self.used = {}           # kind -> pseudo-release id


class LanguageVariants:
    def __init__(self):
        self.albums = {}
        self.translator = Translator()

    # ------------------------------------------------------------ requests

    def _add_request(self, st):
        st.pending += 1
        st.album._requests += 1

    def _done_request(self, st):
        st.pending -= 1
        if st.pending == 0:
            self._finish(st)
        st.album._requests -= 1
        st.album._finalize_loading(None)  # pylint: disable=protected-access

    # ------------------------------------------------------------ processors

    def album_processor(self, album, metadata, release):
        st = AlbumState(album, release)
        self.albums[album.id] = st
        for field in ALBUM_FIELDS:
            st.album_orig[field] = metadata[field]
        st.targets.append((metadata, None, None, dict(st.album_orig)))

        # English artist names from aliases (Picard's release lookup
        # includes them).
        en = credit_string(release.get('artist-credit'), english_alias)
        if en:
            st.album_values.setdefault('albumartist', {})['alias'] = en
        for medium in release.get('media') or []:
            for track in medium.get('tracks') or []:
                en = credit_string(track.get('artist-credit') or (track.get('recording') or {}).get('artist-credit'), english_alias)
                if en:
                    key = (str(medium.get('position')), str(track.get('position')))
                    st.track_values.setdefault(key, {}).setdefault('artist', {})['alias'] = en

        self._add_request(st)  # held until the pseudo-releases are in
        try:
            if 'relations' in release:
                self._follow_relations(st, release.get('relations') or [])
            else:
                # "Use release relationships" is off: ask for them.
                self._add_request(st)
                MBAPIHelper(album.tagger.webservice).get_release_by_id(
                    release['id'], partial(self._relations_loaded, st), inc=['release-rels'])
        finally:
            self._done_request(st)

    def track_processor(self, album, metadata, track_node, release_node=None):
        # Picard passes (album, track metadata, track node, release node).
        st = self.albums.get(album.id)
        if not st:
            return
        orig = {f: metadata[f] for f, _ in FIELDS if f not in ALBUM_FIELDS}
        orig.update(st.album_orig)
        target = (metadata, metadata['discnumber'], metadata['tracknumber'], orig)
        if st.ready:
            self._apply(st, target)
        else:
            st.targets.append(target)

    def remove_album(self, album):
        self.albums.pop(album.id, None)

    # ------------------------------------------------------------ MusicBrainz

    def _relations_loaded(self, st, document, _reply, error):
        try:
            if error or not document:
                log.warning('%s: could not load relationships for %s', PLUGIN_NAME, st.release.get('id'))
                return
            self._follow_relations(st, document.get('relations') or [])
        finally:
            self._done_request(st)

    def _follow_relations(self, st, relations):
        helper = MBAPIHelper(st.album.tagger.webservice)
        for rel in relations:
            if rel.get('type') != 'transl-tracklisting' or rel.get('direction') == 'backward':
                continue
            target = rel.get('release') or {}
            if not target.get('id'):
                continue
            self._add_request(st)
            helper.get_release_by_id(target['id'], partial(self._pseudo_loaded, st),
                                     inc=['recordings', 'artist-credits'])

    def _pseudo_loaded(self, st, document, _reply, error):
        try:
            if error or not document:
                log.warning('%s: could not load a pseudo-release of %s', PLUGIN_NAME, st.release.get('id'))
                return
            kind = pseudo_kind(document)
            if not kind:
                log.debug('%s: skipping pseudo-release %s (%s)', PLUGIN_NAME, document.get('id'), document.get('text-representation'))
                return
            if kind in st.used:  # keep the first of each kind
                log.debug('%s: already have a %s version; skipping %s', PLUGIN_NAME, kind, document.get('id'))
                return
            st.used[kind] = document.get('id')
            log.info('%s: %s version of "%s" from pseudo-release %s', PLUGIN_NAME, kind, st.release.get('title'), document.get('id'))
            st.album_values.setdefault('album', {})[kind] = document.get('title')
            st.album_values.setdefault('albumartist', {})[kind] = credit_string(document.get('artist-credit'))
            for i, medium in enumerate(document.get('media') or []):
                disc = str(medium.get('position') or i + 1)
                if medium.get('title'):
                    st.disc_values.setdefault(disc, {})[kind] = medium['title']
                for j, track in enumerate(medium.get('tracks') or []):
                    key = (disc, str(track.get('position') or j + 1))
                    values = st.track_values.setdefault(key, {})
                    values.setdefault('title', {})[kind] = track.get('title')
                    ac = track.get('artist-credit') or (track.get('recording') or {}).get('artist-credit')
                    if ac:
                        values.setdefault('artist', {})[kind] = credit_string(ac)
        finally:
            self._done_request(st)

    # ------------------------------------------------------------ translation

    def _finish(self, st):
        """All MusicBrainz data is in: machine translate what's missing, if
        that's on, then fill in the tags."""
        provider, key = setting('mt_provider'), (setting('mt_key') or '').strip()
        if provider and key and not st.mt:
            texts = self._untranslated(st)
            if texts:
                self._add_request(st)
                thread.run_task(
                    partial(self.translator.translate, provider, key, setting('mt_english'), st.lang, texts),
                    partial(self._translated, st))
                return
        self._apply_all(st)

    def _untranslated(self, st):
        """Original texts (from the release) with no English version."""
        fields = set(parse_list(setting('mt_fields')))
        wanted = []

        def want(field, orig, values):
            if field in fields and orig and not (values or {}).get('en') and not (values or {}).get('alias') \
                    and needs_translation(orig, st.lang, st.script):
                wanted.append(orig)

        rel = st.release
        want('album', rel.get('title'), st.album_values.get('album'))
        want('albumartist', credit_string(rel.get('artist-credit')), st.album_values.get('albumartist'))
        for i, medium in enumerate(rel.get('media') or []):
            disc = str(medium.get('position') or i + 1)
            want('discsubtitle', medium.get('title'), st.disc_values.get(disc))
            for j, track in enumerate(medium.get('tracks') or []):
                values = st.track_values.get((disc, str(track.get('position') or j + 1))) or {}
                want('title', track.get('title'), values.get('title'))
                want('artist', credit_string(track.get('artist-credit') or (track.get('recording') or {}).get('artist-credit')), values.get('artist'))
        return list(dict.fromkeys(wanted))

    def _translated(self, st, result=None, error=None):
        try:
            if error:
                log.error('%s: machine translation failed: %s', PLUGIN_NAME, error)
            elif result:
                st.mt = result
                log.info('%s: machine translated %d strings for "%s"', PLUGIN_NAME, len(result), st.release.get('title'))
            self._apply_all(st)
        finally:
            st.pending -= 1
            st.album._requests -= 1
            st.album._finalize_loading(None)  # pylint: disable=protected-access

    # ------------------------------------------------------------ tags

    def _apply_all(self, st):
        st.ready = True
        for target in st.targets:
            self._apply(st, target)
        st.targets = []

    def _values_for(self, st, field, disc, track):
        if field in ALBUM_FIELDS:
            return st.album_values.get(field) or {}
        if field == 'discsubtitle':
            return st.disc_values.get(disc) or {}
        return (st.track_values.get((disc, track)) or {}).get(field) or {}

    def _apply(self, st, target):
        metadata, disc, track, origs = target
        sfx = {k: setting('suffix_' + k) or ('_' + k) for k in KINDS}
        mt_fields = set(parse_list(setting('mt_fields')))
        for field, _label in FIELDS:
            if track is None and field not in ALBUM_FIELDS:
                continue  # the album's own metadata has no track tags
            orig = origs.get(field) or ''
            if not orig:
                continue
            found = self._values_for(st, field, disc, track)
            en = found.get('en') or found.get('alias')
            if not en and field in mt_fields:
                en = st.mt.get(orig)
            rom = found.get('rom')
            # Artists: an English alias of a non-Latin name is its romanisation too.
            if not rom and field in ('artist', 'albumartist') and found.get('alias') and has_non_latin(orig):
                rom = found['alias']
            values = {'orig': orig, 'en': en, 'rom': rom}
            for k in ('en', 'rom'):
                if values[k] and same(values[k], orig):
                    values[k] = None
            if values['en'] and values['rom'] and same(values['en'], values['rom']) and found.get('rom') is None:
                values['rom'] = None  # an alias, not a real romanisation
            for k in KINDS:
                name = (field + sfx[k]).lower()
                if values['en'] or values['rom']:
                    if values[k]:
                        metadata[name] = values[k]
                    else:
                        metadata.delete(name)
                else:
                    metadata.delete(name)  # clear tags left by an earlier run
            if values['en'] or values['rom']:
                main, second, fmt = layout(field)
                metadata[field] = combine(values, main, second, fmt)


def parse_list(text):
    return [t for t in re.split(r'[\s,;]+', (text or '').lower()) if t]


def layout(field):
    d_main, d_second, d_fmt = DEFAULT_LAYOUT[field]
    main = parse_chain(config.setting[opt(field + '_main')]) or parse_chain(d_main)
    second = parse_chain(config.setting[opt(field + '_second')])
    fmt = config.setting[opt(field + '_format')] or d_fmt
    return main, second, fmt


# ---------------------------------------------------------------- options

class LanguageVariantsOptionsPage(OptionsPage):
    NAME = 'language_variants'
    TITLE = 'Language Variants'
    PARENT = 'plugins'

    options = [config.TextOption('setting', opt('suffix_' + k), '_' + k) for k in KINDS]
    for _f, _l in FIELDS:
        options += [
            config.TextOption('setting', opt(_f + '_main'), DEFAULT_LAYOUT[_f][0]),
            config.TextOption('setting', opt(_f + '_second'), DEFAULT_LAYOUT[_f][1]),
            config.TextOption('setting', opt(_f + '_format'), DEFAULT_LAYOUT[_f][2]),
        ]
    options += [
        config.TextOption('setting', opt('mt_provider'), ''),
        config.TextOption('setting', opt('mt_key'), ''),
        config.TextOption('setting', opt('mt_english'), 'EN-GB'),
        config.TextOption('setting', opt('mt_fields'), ', '.join(DEFAULT_MT_FIELDS)),
    ]

    def __init__(self, parent=None):
        super().__init__(parent)
        outer = QtWidgets.QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
        scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        outer.addWidget(scroll)
        body = QtWidgets.QWidget()
        scroll.setWidget(body)
        root = QtWidgets.QVBoxLayout(body)

        # Tag names
        names = QtWidgets.QGroupBox('Tag names')
        grid = QtWidgets.QGridLayout(names)
        self.suffix = {}
        for i, (k, label) in enumerate((('orig', 'Original'), ('en', 'English'), ('rom', 'Romanised'))):
            grid.addWidget(QtWidgets.QLabel(label + ' suffix:'), 0, i * 2)
            self.suffix[k] = QtWidgets.QLineEdit()
            self.suffix[k].setMaximumWidth(80)
            grid.addWidget(self.suffix[k], 0, i * 2 + 1)
        root.addWidget(names)

        # Combined tags
        combined = QtWidgets.QGroupBox('Main tags (built from the versions)')
        grid = QtWidgets.QGridLayout(combined)
        for col, text in enumerate(('', 'First', 'Then', 'Format')):
            head = QtWidgets.QLabel('<b>%s</b>' % text)
            grid.addWidget(head, 0, col)
        self.rows = {}
        for r, (field, label) in enumerate(FIELDS, 1):
            grid.addWidget(QtWidgets.QLabel(label), r, 0)
            edits = [QtWidgets.QLineEdit() for _ in range(3)]
            for c, e in enumerate(edits, 1):
                grid.addWidget(e, r, c)
            self.rows[field] = edits
        help_text = QtWidgets.QLabel(
            '<b>orig</b>, <b>en</b>, <b>rom</b>: the first that exists is used; <i>Then</i> is left '
            'out if it would repeat <i>First</i>. Format e.g. <code>{main} [{second}]</code>. '
            'To leave a tag alone: <i>First</i> orig, <i>Then</i> empty.')
        help_text.setWordWrap(True)
        grid.addWidget(help_text, len(FIELDS) + 1, 0, 1, 4)
        root.addWidget(combined)

        # Machine translation
        mt = QtWidgets.QGroupBox('Machine translation (when MusicBrainz has no English version)')
        form = QtWidgets.QFormLayout(mt)
        self.provider = QtWidgets.QComboBox()
        for value, label in PROVIDERS:
            self.provider.addItem(label, value)
        form.addRow('Service:', self.provider)
        self.key = QtWidgets.QLineEdit()
        self.key.setEchoMode(QtWidgets.QLineEdit.Password)
        form.addRow('API key:', self.key)
        self.english = QtWidgets.QComboBox()
        for value, label in ENGLISH:
            self.english.addItem(label, value)
        form.addRow('English (DeepL):', self.english)
        self.mt_boxes = {}
        boxes = QtWidgets.QGridLayout()
        for i, (field, label) in enumerate(FIELDS):
            cb = QtWidgets.QCheckBox(label)
            self.mt_boxes[field] = cb
            boxes.addWidget(cb, i // 3, i % 3)
        form.addRow('Translate:', boxes)
        note = QtWidgets.QLabel(
            'DeepL API Free: 500,000 characters a month. Google needs a Cloud project with billing. '
            '(Kagi has no API.) Results are cached, so each title is only translated once. '
            'Romanisations only come from MusicBrainz.')
        note.setWordWrap(True)
        form.addRow(note)
        root.addWidget(mt)
        root.addStretch(1)

    def load(self):
        for k in KINDS:
            self.suffix[k].setText(setting('suffix_' + k))
        for field, edits in self.rows.items():
            for e, part in zip(edits, ('_main', '_second', '_format')):
                e.setText(config.setting[opt(field + part)])
        i = self.provider.findData(setting('mt_provider'))
        self.provider.setCurrentIndex(max(0, i))
        self.key.setText(setting('mt_key'))
        i = self.english.findData(setting('mt_english'))
        self.english.setCurrentIndex(max(0, i))
        chosen = set(parse_list(setting('mt_fields')))
        for field, cb in self.mt_boxes.items():
            cb.setChecked(field in chosen)

    def save(self):
        for k in KINDS:
            text = re.sub(r'\s+', '', self.suffix[k].text()) or '_' + k
            config.setting[opt('suffix_' + k)] = text
        for field, edits in self.rows.items():
            main, second, fmt = (e.text().strip() for e in edits)
            config.setting[opt(field + '_main')] = main if parse_chain(main) else DEFAULT_LAYOUT[field][0]
            config.setting[opt(field + '_second')] = second
            config.setting[opt(field + '_format')] = fmt if '{main}' in fmt and '{second}' in fmt else DEFAULT_LAYOUT[field][2]
        config.setting[opt('mt_provider')] = self.provider.currentData() or ''
        config.setting[opt('mt_key')] = self.key.text().strip()
        config.setting[opt('mt_english')] = self.english.currentData() or 'EN-GB'
        config.setting[opt('mt_fields')] = ', '.join(f for f, cb in self.mt_boxes.items() if cb.isChecked())


plugin = LanguageVariants()
# Low priority, so other plugins' changes to the tags are in place first.
register_album_metadata_processor(plugin.album_processor, priority=PluginPriority.LOW)
register_track_metadata_processor(plugin.track_processor, priority=PluginPriority.LOW)
register_album_post_removal_processor(plugin.remove_album)
register_options_page(LanguageVariantsOptionsPage)
