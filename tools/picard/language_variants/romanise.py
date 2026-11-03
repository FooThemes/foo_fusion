# -*- coding: utf-8 -*-
"""Machine romanisation, for when MusicBrainz has no romanised version.

Japanese (kana and kanji) uses pykakasi, Chinese uses pypinyin; both are
bundled in vendor/ and unpacked on first use (see load_vendor). Korean,
Cyrillic and Greek use the rules and tables below. Words come out with each
word capitalised ("Kimi Ni Muchuu"): the libraries don't know a title's real
capitalisation. Latin text inside a title is left exactly as it is.
"""

import os
import re
import sys
import unicodedata
import zipfile

KANA = re.compile('[぀-ヿｦ-ﾟ]')
KANJI = re.compile('[㐀-䶿一-鿿豈-﫿]')
HANGUL = re.compile('[가-힣]')
CYRILLIC = re.compile('[Ѐ-ӿ]')
GREEK = re.compile('[Ͱ-Ͽἀ-῿]')

# Option names, in the order the options page lists them.
SCRIPTS = (
    ('kana', 'Japanese kana'),
    ('kanji', 'Japanese kanji (dictionary guesses)'),
    ('hangul', 'Korean'),
    ('hanzi', 'Chinese (pinyin, dictionary guesses)'),
    ('cyrillic', 'Cyrillic and Greek'),
)


def title_case(word):
    return word[:1].upper() + word[1:] if word else word


def tidy(text):
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'\s+([)\]}>,.!?:;])', r'\1', text)
    return re.sub(r'([(\[{<])\s+', r'\1', text)


# --- vendored libraries -----------------------------------------------------

_vendor = {'path': None, 'error': None}


def load_vendor(user_dir, version):
    """Make the bundled libraries importable. Picard runs a zipped plugin
    straight from the zip, but pykakasi opens its dictionaries as files, so
    the vendor folder is unpacked into Picard's settings folder once."""
    if _vendor['path'] or _vendor['error']:
        return _vendor['path']
    here = os.path.dirname(os.path.abspath(__file__))
    vendor = os.path.join(here, 'vendor')
    try:
        if not os.path.isdir(vendor):
            vendor = _unpack(here, os.path.join(user_dir, 'language_variants', 'vendor-' + version))
        if vendor not in sys.path:
            sys.path.append(vendor)
        _vendor['path'] = vendor
    except Exception as e:  # pylint: disable=broad-except
        _vendor['error'] = str(e)
    return _vendor['path']


def vendor_error():
    return _vendor['error']


def _unpack(here, dest):
    # `here` is ".../plugins/language_variants.zip/language_variants".
    zpath, inner = here, ''
    while zpath and not os.path.isfile(zpath):
        zpath, part = os.path.split(zpath)
        inner = part + '/' + inner
    if not zpath:
        raise RuntimeError('bundled libraries not found')
    prefix = inner + 'vendor/'
    done = os.path.join(dest, '.complete')
    if os.path.exists(done):
        return dest
    with zipfile.ZipFile(zpath) as z:
        for name in z.namelist():
            if name.startswith(prefix) and not name.endswith('/'):
                target = os.path.join(dest, *name[len(prefix):].split('/'))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with z.open(name) as src, open(target, 'wb') as out:
                    out.write(src.read())
    with open(done, 'w') as f:
        f.write('ok')
    return dest


_kakasi = None


def japanese(text, kanji_ok):
    """Hepburn romaji with pykakasi; Latin parts are kept as they are."""
    global _kakasi  # pylint: disable=global-statement
    if KANJI.search(text) and not kanji_ok:
        return None
    if _kakasi is None:
        import pykakasi  # pylint: disable=import-outside-toplevel
        _kakasi = pykakasi.kakasi()
    out = []
    for item in _kakasi.convert(text):
        orig, rom = item['orig'], item['hepburn']
        if not (KANA.search(orig) or KANJI.search(orig)):
            out.append(' ' + orig + ' ')  # Latin, digits, punctuation: unchanged
        else:
            out.append(' ' + ' '.join(title_case(w) for w in rom.split()) + ' ')
    return tidy(''.join(out).replace('ー', ''))


def chinese(text):
    from pypinyin import lazy_pinyin  # pylint: disable=import-outside-toplevel
    out = []
    for part in lazy_pinyin(text, errors='default'):
        out.append(title_case(part) if part.isalpha() and part.isascii() else part)
    return tidy(' '.join(out))


# --- Korean: Revised Romanization ------------------------------------------

_INITIAL = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h']
_VOWEL = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i']
# Final consonant at the end of a syllable (before a consonant or a pause).
_FINAL = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't']
# Before a vowel (initial ㅇ) the final moves over: (what stays, what moves).
_LIAISON = {
    1: ('', 'g'), 2: ('', 'kk'), 3: ('k', 's'), 4: ('', 'n'), 5: ('n', 'j'), 6: ('n', ''), 7: ('', 'd'), 8: ('', 'r'),
    9: ('l', 'g'), 10: ('l', 'm'), 11: ('l', 'b'), 12: ('l', 's'), 13: ('l', 't'), 14: ('l', 'p'), 15: ('l', ''),
    16: ('', 'm'), 17: ('', 'b'), 18: ('p', 's'), 19: ('', 's'), 20: ('', 'ss'), 21: ('ng', ''), 22: ('', 'j'),
    23: ('', 'ch'), 24: ('', 'k'), 25: ('', 't'), 26: ('', 'p'), 27: ('', ''),
}


def _syllables(word):
    for ch in word:
        code = ord(ch) - 0xAC00
        if 0 <= code < 11172:
            yield code // 588, (code % 588) // 28, code % 28
        else:
            yield ch


def korean_word(word):
    parts = list(_syllables(word))
    out = []
    carry = None  # initial taken from the previous syllable's final
    for i, p in enumerate(parts):
        if isinstance(p, str):
            out.append(p)
            carry = None
            continue
        lead, vowel, final = p
        nxt = parts[i + 1] if i + 1 < len(parts) and not isinstance(parts[i + 1], str) else None
        initial = carry if carry is not None else _INITIAL[lead]
        carry = None
        coda = _FINAL[final]
        if final and nxt:
            n_lead = nxt[0]
            if n_lead == 11:  # next syllable starts with a vowel
                coda, carry = _LIAISON[final]
            elif n_lead in (2, 6):  # ㄴ, ㅁ: nasalisation
                coda = {'k': 'ng', 't': 'n', 'p': 'm'}.get(coda, coda)
            elif n_lead == 5 and coda in ('n', 'l'):  # ㄹ: ㄴㄹ, ㄹㄹ -> ll
                coda, carry = 'l', 'l'
        out.append(initial + _VOWEL[vowel] + coda)
    return ''.join(out)


def korean(text):
    return tidy(' '.join(title_case(korean_word(w)) if HANGUL.search(w) else w for w in text.split(' ')))


# --- Cyrillic and Greek: letter tables ---------------------------------------

_CYR = dict(zip(
    'абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґўђјљњћџ',
    ['a', 'b', 'v', 'g', 'd', 'e', 'yo', 'zh', 'z', 'i', 'y', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f',
     'kh', 'ts', 'ch', 'sh', 'shch', '', 'y', '', 'e', 'yu', 'ya', 'i', 'yi', 'ye', 'g', 'w', 'dj', 'j', 'lj', 'nj',
     'c', 'dz'],
))
_GRK = dict(zip(
    'αβγδεζηθικλμνξοπρσςτυφχψωάέήίόύώϊϋΐΰ',
    ['a', 'v', 'g', 'd', 'e', 'z', 'i', 'th', 'i', 'k', 'l', 'm', 'n', 'x', 'o', 'p', 'r', 's', 's', 't', 'y', 'f',
     'ch', 'ps', 'o', 'a', 'e', 'i', 'i', 'o', 'y', 'o', 'i', 'y', 'i', 'y'],
))


def letters(text):
    """Letter by letter; capitals stay capitals ("Москва" -> "Moskva")."""
    out = []
    for ch in text:
        low = ch.lower()
        rom = _CYR.get(low, _GRK.get(low))
        if rom is None:
            out.append(ch)
        else:
            out.append(title_case(rom) if ch != low else rom)
    return ''.join(out)


# --- choosing ------------------------------------------------------------------

def romanise(text, enabled, lang=None, script=None):
    """Romanised `text`, and what made it ("pykakasi", ...), or (None, None).

    enabled: set of SCRIPTS keys switched on. lang/script: the release's
    MusicBrainz text representation, which tells Japanese kanji from Chinese.
    """
    if not text:
        return None, None
    try:
        if KANA.search(text) or (KANJI.search(text) and (lang == 'jpn' or script == 'Jpan')):
            if 'kana' not in enabled:
                return None, None
            rom = japanese(text, 'kanji' in enabled)
            return (rom, 'pykakasi') if rom else (None, None)
        if HANGUL.search(text):
            return (korean(text), 'Revised Romanization') if 'hangul' in enabled else (None, None)
        if KANJI.search(text):
            chinese_release = lang in ('zho', 'yue', 'cmn') or script in ('Hans', 'Hant', 'Hani')
            if chinese_release and 'hanzi' in enabled:
                return chinese(text), 'pypinyin'
            return None, None
        if CYRILLIC.search(text) or GREEK.search(text):
            return (letters(text), 'transliteration table') if 'cyrillic' in enabled else (None, None)
    except ImportError as e:
        _vendor['error'] = _vendor['error'] or 'import failed: %s' % e
        raise RuntimeError('romanisation library missing: %s' % e)
    return None, None


def needs_romanisation(text):
    return any(c.isalpha() and 'LATIN' not in unicodedata.name(c, 'LATIN') for c in text or '')
